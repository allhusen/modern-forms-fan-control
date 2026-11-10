# Fan Control

A self-contained Mac app for controlling a Modern Forms ceiling fan over the local network, with a built-in Apple Home bridge.

[![Tests](https://github.com/allhusen/modern-forms-fan-control/actions/workflows/test.yml/badge.svg)](https://github.com/allhusen/modern-forms-fan-control/actions/workflows/test.yml)

Independent project; not affiliated with or endorsed by WAC Lighting, Modern Forms, or Apple. The bridge is not Apple-certified.

## Features

- Fan power, six steady speeds, and summer/winter direction.
- Light power and brightness.
- Breeze mode with Gentle, Medium, and Strong settings on supported fans.
- An in-app schedule editor with weekdays, fixed times or sunset, brightness, Breeze, and optional off timers.
- Separate fan and light accessories in Apple Home, including remembered speed and brightness across power changes.
- A native Mac window that starts and stops its bundled local server and HomeKit bridge.
- A responsive web interface for an iPhone on the same network.

The app currently controls one configured fan and has been tested with one Modern Forms fan using the `/mf` API. Other models using the same WAC/Modern Forms protocol may work but are unverified. Newer Gen4 devices using `/fixture` and `/device` are not supported.

## Build and install

Requirements: an Apple Silicon Mac running macOS 14 or later, Apple's Command Line Tools, and Node.js 22 or later for development. The built app includes its own Node.js runtime.

```sh
npm ci
cp config.example.json config.json
```

Edit `config.json` with the fan's local IPv4 address and Wi-Fi station MAC address. The supplied address and MAC are examples; replace both. Local configuration is ignored by Git. The default controller port is 8787 and the HomeKit port is 51826; an optional `homeKitPort` can override the latter.

```sh
npm test
npm run build:mac
```

The build produces `dist/Fan Control.zip`. Extract it and move **Fan Control.app** to `~/Applications` or `/Applications`. Quit an older copy before replacing it. The build downloads a pinned official Node.js runtime, verifies its SHA-256, compiles the native window, and signs the bundle locally. It is not notarized for public distribution.

On first launch, the app copies the configured fan settings into `~/Library/Application Support/Fan Control/config.json`. Subsequent launches use that saved configuration. To change the fan later, edit that saved file and restart the app. Updating the app preserves saved configuration and HomeKit pairings.

The build includes your local `config.json` as its first-launch default. Treat a locally built archive as personalized; review that configuration before sharing a binary.

## Everyday use

Open **Fan Control.app** to start the window, local server, and Apple Home bridge. Closing the window or choosing **Quit Fan Control** stops the server and bridge without changing the physical fan or light. Minimize the window to keep it running.

Keep the Mac awake and the app running for iPhone access and Home automations. The app does not start at login or prevent sleep. Allow Local Network access if macOS asks.

- Tap the fan or light indicator to toggle power. Turning it back on restores its remembered setting.
- Move a slider to zero to turn off; moving above zero turns on at the selected setting.
- Enable **Breeze** to vary the fan speed automatically. Its slider selects Gentle, Medium, or Strong. Unsupported fans show Breeze as unavailable.
- Summer sends `forward`; winter sends `reverse`. The fan may pause while reversing.
- Failed requests show the last known state. Every control request verifies the fan's identity and reads back the result before reporting success.

## Schedules

Open **Schedules → Add schedule**. Choose the days and either a fixed time or sunset, then select what to do with the light and fan. Each can be left unchanged, turned on, or turned off. Light-on actions can set brightness; fan-on actions can preserve the current speed and Breeze mode or choose new settings. **Turn off after** switches off only devices that this schedule turned on.

For sunset, open **Location & time → Use my location** in the Mac app, or enter approximate town coordinates. Location is requested only when you press that button. SunCalc calculates sunset locally without an online service. All schedules use the time zone shown in settings.

Keep the app open and Mac awake. Scheduling checks every ten seconds; an action more than one minute late is skipped, and earlier starts are not replayed when reopening the app. A pending off timer survives an app restart, but is also skipped if more than one minute late. Disabling, editing, or deleting a schedule cancels its pending off timer. An off timer still applies after manual adjustments. Recent activity shows completed, missed, and failed actions. Unconfirmed device writes are never automatically retried.

Schedules follow local daylight saving time. A clock time skipped by the spring transition does not run that day; a repeated autumn clock time runs once. Days without a sunset have no sunset event. The editor starts empty and leaves the fan's onboard schedule and Adaptive Learning unchanged. App schedules and Apple Home or manufacturer automations operate independently, so avoid conflicting rules.

Schedules, approximate location, and recent activity stay in `~/Library/Application Support/Fan Control/schedules.json`, alongside your existing configuration and HomeKit pairings. Updating the app preserves them. Development mode keeps a separate file at `.runtime/schedules.json`. Do not share or commit those files. A damaged file is preserved and scheduling pauses instead of silently resetting it.

## Apple Home

Click **Apple Home** in the Mac app to display its pairing QR code. On the iPhone, choose **Home → + → Add Accessory**, scan the code, and add **Ceiling Fan** and **Ceiling Light**. Home may ask you to choose **Add Anyway** for this uncertified accessory.

Tap an accessory's name to open its controls; tapping its icon toggles power. If Home groups the accessories, open the group to find the individual fan and light controls.

Choose Breeze or steady mode in Fan Control. Home preserves the selected mode. In Breeze mode, Home's speed slider controls strength: 33% Gentle, 67% Medium, and 100% Strong. Powering off and on preserves the selected speed or strength. Direction remains available in Fan Control.

For Home automations, use **Home → Automation → +** with an appropriate Home hub. Commands travel through the Mac's bridge to the fan. The iPhone and Home hub must be able to discover the Mac through mDNS and reach TCP port 51826.

Pairing data stays in `~/Library/Application Support/Fan Control/homekit/`. The pairing QR code is only available through the Mac's loopback address while the bridge is unpaired. Do not share pairing files or commit them to Git.

## iPhone web access and networking

Connect the iPhone to a network that can reach the Mac. Tap **?** in Fan Control to find the Mac's current address, then open the listed URL in Safari. Optionally use **Share → Add to Home Screen**. This requires a live connection to the Mac.

The connection path is **iPhone → Mac:8787 → fan:80**. On a network with isolated IoT devices, allow these connections explicitly. Reserve the fan's and Mac's IP addresses if you want stable URLs. The app does not change router settings.

The web controller permits local source addresses, validates Host and Origin headers, and restricts control requests to supported fields. It has no user login: devices allowed to reach it on your local network can control the fan. Do not expose its port to the Internet.

## Development and diagnostics

```sh
npm start                 # Development web server; no HomeKit bridge
npm run open              # Launch the development server and browser
npm run stop              # Stop the development server
npm run diagnose          # Read-only connection and identity check
npm test                  # Type checks and simulated-device tests; no real fan commands
npm run check             # Strict TypeScript and command contract checks
npm run build             # Compile the controller into build/
npm run format:check      # Check consistent source formatting
npm run format            # Apply source formatting
npm run inspect-schedule  # Read-only inspection of the fan's stored schedule
```

The controller, HTTP API, and HomeKit bridge are written in strict TypeScript. Browser UI and development scripts use JavaScript. The npm commands compile the controller when needed.

The `.command` launchers also run the development server, which requires a separate Node.js installation. Do not run it alongside the native app on the same port.

The browser polls while visible; the HomeKit bridge polls while the app runs. Device requests are serialized and briefly cached for concurrent clients. Failed writes are not automatically retried.

Native logs are in `~/Library/Application Support/Fan Control/controller.log`. Development logs and diagnostic snapshots belong in the ignored `.runtime/` directory. If the fan is unreachable, check its wall power, Wi-Fi, client isolation, and macOS Local Network permission.

The schedule inspector reports an experimental interpretation of the fan's opaque onboard schedule data and never writes it. The app's schedule editor uses ordinary verified control commands instead of that unverified format.

## Protocol and dependencies

The controller uses the manufacturer's [WAC / Modern Forms local IP API](https://waclighting-images.s3.amazonaws.com/developer/WAC_Modern_Forms_3rd_Party_API_Reference.pdf): HTTP POST `/mf`, `queryDynamicShadowData: 1` for status, and individual fields for control. Its controls do not reset or change the fan's pairing, schedule, firmware, or Wi-Fi.

WAC's API is subject to its [API License Agreement](https://waclighting-images.s3.amazonaws.com/developer/WAC_API_License_Agreement_21.10.2021.pdf). This project does not grant rights to WAC documentation, trademarks, or APIs.

Apple Home support uses [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS), with QR codes generated by [node-qrcode](https://github.com/soldair/node-qrcode). Sunset calculations use [SunCalc](https://github.com/mourner/suncalc). Their respective dependency licenses apply. Native app icons and UI assets are included in this repository.

Bug reports, compatibility reports, and contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

Fan Control is an independent project, not affiliated with, endorsed by, or supported by WAC Lighting, Modern Forms, or Apple. Product names and trademarks belong to their respective owners and are used to identify compatibility. The Apple Home bridge is not Apple-certified.

This software is provided “as is,” without warranty. Compatibility has been tested on limited hardware and may change with device firmware updates. Use it at your own risk.

Any license for this project's original code and assets does not grant rights to manufacturer APIs, firmware, documentation, or trademarks. Dependencies retain their own licenses; applicable WAC API terms remain separate.
