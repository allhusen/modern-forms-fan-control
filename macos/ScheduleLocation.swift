import CoreLocation
import WebKit

/// A one-shot location request, initiated only by the scheduler's location button.
@MainActor
// Core Location delivers callbacks on the run loop where its manager was created (the main thread).
final class ScheduleLocation: NSObject, WKScriptMessageHandlerWithReply,
    @preconcurrency CLLocationManagerDelegate
{
    private var manager: CLLocationManager?
    private var reply: ((Any?, String?) -> Void)?
    private var timeout: DispatchWorkItem?
    private var requesting = false

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "http", origin.host == "127.0.0.1",
            origin.port == message.webView?.url?.port
        else {
            replyHandler(nil, "Location is available only from Fan Control's own window.")
            return
        }
        guard reply == nil else {
            replyHandler(nil, "A location request is already in progress.")
            return
        }
        reply = replyHandler
        let manager = CLLocationManager()
        self.manager = manager
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
        let timeout = DispatchWorkItem { [weak self] in
            self?.finish(
                error: "Location timed out. You can enter your town's coordinates instead.")
        }
        self.timeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else {
            requestIfAuthorized(manager)
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        requestIfAuthorized(manager)
    }

    private func requestIfAuthorized(_ manager: CLLocationManager) {
        guard reply != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            guard !requesting else { return }
            requesting = true
            manager.requestLocation()
        case .denied, .restricted:
            finish(
                error:
                    "Location access is off. Allow Fan Control in System Settings → Privacy & Security → Location Services, or enter coordinates below."
            )
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0 else {
            finish(error: "Location unavailable. Enter your town's coordinates below.")
            return
        }
        finish(value: [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "timeZone": TimeZone.current.identifier,
        ])
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(
            error:
                "Location unavailable. Check Location Services or enter your town's coordinates below."
        )
    }

    private func finish(value: Any? = nil, error: String? = nil) {
        timeout?.cancel()
        timeout = nil
        manager?.stopUpdatingLocation()
        manager?.delegate = nil
        manager = nil
        requesting = false
        let callback = reply
        reply = nil
        callback?(value, error)
    }
}
