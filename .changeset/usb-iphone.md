---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/relay": minor
"@tapflowio/ios-agent": minor
---

A USB-connected iPhone or iPad can be used like a simulator (#152). `DeviceReport` and `Device` carry an optional `kind` (`simulator`, `emulator` or `physical`); a relay drops a kind it does not know, as it does a form factor, and passes it to `agents:listed`. The iOS agent lists devices `devicectl` reports as plugged in over USB, trusted and in Developer Mode, by hardware UDID. Opening one skips every simulator step and streams its screen through `device-capture-helper.app`, an ad-hoc signed app launched with `open` so it can hold the macOS Camera grant a screen-capture device needs, in screencapture-helper's framing after one status byte. Input goes through the XCUITest runner, which gains tap, drag, type and key routes, builds for the physical destination signed by `TAPFLOW_IOS_TEAM_ID` (optionally under `TAPFLOW_IOS_BUNDLE_PREFIX`), and is reached over the device's CoreDevice tunnel address. What a phone cannot do yet — installing a build, clipboard, network control, rotation, opening a URL, screenshots, full and run resets — is refused through each message's existing error reply. The dashboard counts USB devices on the Mac card and marks them with a USB badge and Connected.
