import Cocoa
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var message: NSTextField!
    private var server: Process?
    private var log: FileHandle?
    private var controllerURL: URL!
    private var instance = ""
    private var stopping = false
    private var starting = false
    private var ready = false
    private var signals: [DispatchSourceSignal] = []
    private let scheduleLocation = ScheduleLocation()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        makeMenu()
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered,
            defer: false)
        window.title = "Fan Control"
        window.minSize = NSSize(width: 360, height: 620)
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(
            calibratedRed: 244 / 255, green: 245 / 255, blue: 240 / 255, alpha: 1)
        window.setFrameAutosaveName("FanControlWindow")
        window.center()
        let content = window.contentView!
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addScriptMessageHandler(
            scheduleLocation, contentWorld: .page, name: "scheduleLocation")
        webView = WKWebView(frame: content.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.isHidden = true
        content.addSubview(webView)
        message = NSTextField(wrappingLabelWithString: "Starting Fan Control…")
        message.alignment = .center
        message.font = .systemFont(ofSize: 16)
        message.textColor = .secondaryLabelColor
        message.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(message)
        NSLayoutConstraint.activate([
            message.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            message.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            message.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -60),
        ])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signals.append(source)
        }
        startController()
    }

    private func makeMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Quit Fan Control", action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [
            ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a"),
        ] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = editMenu
        menu.addItem(editItem)
        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        let viewMenu = NSMenu(title: "View")
        let reload = viewMenu.addItem(
            withTitle: "Reload Controls", action: #selector(reloadControls), keyEquivalent: "r")
        reload.target = self
        viewItem.submenu = viewMenu
        menu.addItem(viewItem)
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(
            withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m")
        windowMenu.addItem(
            withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }

    @objc private func reloadControls() {
        if server?.isRunning == true, ready {
            webView.reload()
        } else if !starting {
            startController()
        }
    }

    private func startController() {
        guard !starting, server?.isRunning != true else { return }
        starting = true
        ready = false
        webView.isHidden = true
        message.isHidden = false
        message.stringValue = "Starting Fan Control…"
        do {
            let files = FileManager.default
            let resources = Bundle.main.resourceURL!
            let controller = resources.appendingPathComponent("controller")
            let support = try files.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil,
                create: true)
            let data = support.appendingPathComponent("Fan Control", isDirectory: true)
            try files.createDirectory(
                at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let configFile = data.appendingPathComponent("config.json")
            if !files.fileExists(atPath: configFile.path) {
                try files.copyItem(
                    at: controller.appendingPathComponent("config.json"), to: configFile)
                try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configFile.path)
            }
            let config =
                try JSONSerialization.jsonObject(with: Data(contentsOf: configFile))
                as? [String: Any]
            guard let port = config?["port"] as? Int, (1024...65535).contains(port) else {
                throw NSError(
                    domain: "FanControl", code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey: "The controller port in config.json is invalid."
                    ])
            }
            controllerURL = URL(string: "http://127.0.0.1:\(port)/")!
            instance = UUID().uuidString
            let logURL = data.appendingPathComponent("controller.log")
            if !files.fileExists(atPath: logURL.path) {
                files.createFile(
                    atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            try? log?.close()
            log = try FileHandle(forWritingTo: logURL)
            try log?.seekToEnd()
            let process = Process()
            process.executableURL = resources.appendingPathComponent("node")
            process.arguments = [controller.appendingPathComponent("build/app-server.js").path]
            process.currentDirectoryURL = data
            var environment = ProcessInfo.processInfo.environment
            environment["FAN_CONTROL_DATA_DIR"] = data.path
            environment["FAN_CONTROL_PARENT_PID"] = String(getpid())
            environment["FAN_CONTROL_INSTANCE"] = instance
            environment.removeValue(forKey: "NODE_OPTIONS")
            process.environment = environment
            process.standardOutput = log
            process.standardError = log
            process.terminationHandler = { [weak self] process in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.starting = false
                    self.ready = false
                    if !self.stopping {
                        self.showError(
                            "The local controller stopped (code \(process.terminationStatus)). If an older controller is running, stop it first. Choose View → Reload Controls to try again. Details are in ~/Library/Application Support/Fan Control/controller.log."
                        )
                    }
                }
            }
            server = process
            try process.run()
            checkReady(attempt: 0, expectedInstance: instance)
        } catch {
            starting = false
            showError(error.localizedDescription)
        }
    }

    private func checkReady(attempt: Int, expectedInstance: String) {
        guard !stopping, instance == expectedInstance, server?.isRunning == true else { return }
        if attempt >= 60 {
            starting = false
            showError(
                "The controller did not start. Another app may be using its port. Close and reopen Fan Control to try again."
            )
            server?.terminate()
            return
        }
        var request = URLRequest(url: controllerURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 1
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            let health = data.flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            }
            let matches =
                health?["app"] as? String == "modern-forms-local-control"
                && health?["instance"] as? String == expectedInstance
            DispatchQueue.main.async {
                guard let self, !self.stopping, self.instance == expectedInstance,
                    self.server?.isRunning == true
                else { return }
                if matches {
                    self.starting = false
                    self.ready = true
                    self.webView.load(URLRequest(url: self.controllerURL))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.checkReady(attempt: attempt + 1, expectedInstance: expectedInstance)
                    }
                }
            }
        }.resume()
    }

    private func showError(_ text: String) {
        webView.isHidden = true
        message.isHidden = false
        message.stringValue = text
        log?.write(Data(("App: \(text)\n").utf8))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        message.isHidden = true
        webView.isHidden = false
        log?.write(Data("App window loaded the controller successfully.\n".utf8))
    }

    func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        if (error as NSError).code != NSURLErrorCancelled {
            showError(
                "Could not load the controls: \(error.localizedDescription). Choose View → Reload Controls to retry."
            )
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == controllerURL.scheme && url.host == controllerURL.host
            && url.port == controllerURL.port
        {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated
                && ["http", "https"].contains(url.scheme ?? "")
            {
                NSWorkspace.shared.open(url)
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool)
        -> Bool
    {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let server, server.isRunning else { return .terminateNow }
        if stopping { return .terminateNow }
        stopping = true
        server.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 6) {
            if server.isRunning { kill(server.processIdentifier, SIGKILL) }
        }
        server.waitUntilExit()
        return .terminateNow
    }
}

@main
enum FanControlApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
