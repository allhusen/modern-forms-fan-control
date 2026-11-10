# Contributing

Start with the build and configuration steps in [README.md](README.md). Run `npm run format:check` and `npm test` before submitting a change. Tests use simulated devices and do not require a fan, credentials, or a local configuration file.

For a bug report or compatibility report, include:

- Fan model, firmware version, and whether it has a light or Breeze support.
- macOS version and whether the issue occurs in Fan Control, the web interface, or Apple Home.
- What you did, what you expected, and what happened.
- A short, redacted error message if available.

Keep Wi-Fi names, device IP/MAC addresses, pairing codes, HomeKit keys, access tokens, schedule locations and routines, and unredacted logs out of issues and pull requests. Do not upload `config.json`, the app's Application Support folder, or personalized app builds. Use invented device identities in tests.

Changes to device controls should verify identity before writing, preserve unrelated settings, and confirm the resulting device state. New protocol or model support should include simulated tests and clearly state what was tested on real hardware.

Schedule inspection is experimental and read-only. Do not treat the inferred format as verified support for editing schedules.

The built Mac app includes the local configuration used during its build. Build with a reviewed example configuration before sharing an artifact. Existing installations keep their configuration and HomeKit pairings outside the app bundle.

## Code organization

- `src/lib/fan.ts` owns the device protocol, validation, command queue, and read-back verification.
- `src/lib/homekit.ts` maps Apple Home characteristics to that shared device controller.
- `src/lib/scheduler.ts` serializes schedule edits and execution, persisting each claimed action before a device write. `schedule-time.ts` handles calendar and sunset calculations; `schedule-validation.ts` validates external configuration.
- `src/lib/config.ts`, `src/lib/network.ts`, and `src/lib/http.ts` handle configuration and HTTP boundaries.
- `src/server.ts` assembles the web routes. `src/app-server.ts` owns the native app's server and bridge lifecycle.
- `public/app.js` handles device controls; `public/schedules.js` handles schedules; `public/homekit.js` handles the pairing dialog; `public/api.js` handles browser requests.
- `macos/FanControl.swift` owns the window and bundled child process. `ScheduleLocation.swift` handles a user-initiated, one-shot Core Location request for sunset.

Keep device writes in `Fan.write()` so all entry points share identity checks, serialization, and confirmation. Tests should check observable behavior with simulated devices rather than reach real hardware. Never automatically retry a physical command whose outcome is uncertain.

Use `npm run format` for TypeScript, JavaScript, HTML, CSS, JSON, Markdown, and workflow files. On a Mac, run `xcrun swift-format format --in-place macos/*.swift` for Swift. Formatting does not replace review of state transitions, failure handling, and resource cleanup.

## Type contracts

The controller, HTTP server, and Apple Home bridge are strict TypeScript in `src/`. `npm run build` compiles them into the ignored `build/` directory; the Mac bundle includes that compiled code. Browser UI and development scripts remain JavaScript.

`src/lib/types.ts` defines supported commands, device state, and online/offline results. `Fan.write()` accepts a nonempty `FanCommand` or a synchronous factory receiving read-only, freshly verified state. Discrete fan and Breeze speeds use literal types. Brightness remains a number whose integer range is checked at runtime.

Treat JSON and device replies as `unknown` until validated. Do not cast external input directly to `FanCommand`. `npm run check` checks production code and compile-only contract examples in `typecheck/`; `npm test` includes that check. The negative examples deliberately fail compilation if an invalid call becomes accepted.
