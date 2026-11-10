# Contributing

Start with the build and configuration steps in [README.md](README.md). Run `npm test` before submitting a change. Tests use simulated devices and do not require a fan, credentials, or a local configuration file.

For a bug report or compatibility report, include:

- Fan model, firmware version, and whether it has a light or Breeze support.
- macOS version and whether the issue occurs in Fan Control, the web interface, or Apple Home.
- What you did, what you expected, and what happened.
- A short, redacted error message if available.

Keep Wi-Fi names, device IP/MAC addresses, pairing codes, HomeKit keys, access tokens, and unredacted logs out of issues and pull requests. Do not upload `config.json`, the app's Application Support folder, or personalized app builds. Use invented device identities in tests.

Changes to device controls should verify identity before writing, preserve unrelated settings, and confirm the resulting device state. New protocol or model support should include simulated tests and clearly state what was tested on real hardware.

Schedule inspection is experimental and read-only. Do not treat the inferred format as verified support for editing schedules.

The built Mac app includes the local configuration used during its build. Build with a reviewed example configuration before sharing an artifact. Existing installations keep their configuration and HomeKit pairings outside the app bundle.
