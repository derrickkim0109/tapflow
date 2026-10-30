---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/relay": minor
"@tapflowio/ios-agent": minor
---

A USB-connected iPhone can be opened from the dashboard, mirrored and tapped (#152). `DeviceReport` and `Device` carry an optional `kind` (`simulator`, `emulator` or `physical`); a relay drops a kind it does not know, as it does a form factor, and passes it to `agents:listed`. The iOS agent lists the iPhones and iPads `devicectl` reports as plugged in over USB, trusted and in Developer Mode, by hardware UDID; only an iPhone has been tried on hardware, so an iPad is listed and nothing more is claimed for it.

Opening one skips every simulator step and streams its screen through `device-capture-helper.app`, an ad-hoc signed app built on the agent Mac from the shipped Swift source and launched with `open` so it can hold the macOS Camera grant a screen-capture device needs. A denied Camera grant is logged and not retried. Taps, drags, long presses, typing, Return/Delete/Tab and the home and volume buttons go through the XCUITest runner, which gains `/tap`, `/drag`, `/type` and `/key` routes, builds for the device signed by `TAPFLOW_IOS_TEAM_ID` (optionally under `TAPFLOW_IOS_BUNDLE_PREFIX`), binds every interface with a per-launch token on every route, and is reached over the device's CoreDevice tunnel. A drag is played after the finger lifts, as a straight line. Taps were tried on hardware; drags and typing were not. Pinches, holding a button, the side button and ⌘/⌃/⌥ shortcuts are refused.

The first device build runs `xcodebuild -allowProvisioningUpdates`, which registers the phone in the team's Apple developer account and creates the App IDs `<prefix>.treerunner.host` and `<prefix>.treerunner.uitests` (prefix `dev.tapflow` unless `TAPFLOW_IOS_BUNDLE_PREFIX` is set) and a development provisioning profile for them.

`app:install` on a phone installs a device-signed build with `devicectl`: an `.ipa` (as Firebase App Distribution or an ad-hoc or development export produce) or a zip or tar of an iphoneos `.app`, uninstalling the old copy first as on a simulator. A simulator build cannot run on a phone, so when the app is already installed there (from TestFlight or Firebase) that copy is used, and otherwise the install fails asking for a device build. `app:launch` launches the installed app with `devicectl`, with launch arguments and environment. Neither has been tried on hardware yet.

Refused on a phone through each message's existing error reply: Full reset and run resets, clearing app data, the clipboard, network control, opening a URL and screenshots. Rotate and the software-keyboard button do nothing on a phone, and since neither message has a reply, the browser is not told. The dashboard counts USB devices on the Mac card and marks them with a USB badge and Connected.
