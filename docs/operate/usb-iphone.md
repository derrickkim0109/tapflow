---
title: USB-connected iPhones
description: Get an iPhone plugged into the agent Mac by USB ready to open from the dashboard like a simulator — Developer Mode, the signing team, the Camera permission, Auto-Lock, and what a phone cannot do.
---

# USB-connected iPhones

An iPhone plugged into the agent Mac by USB is listed next to the simulators with a **USB** badge. Open it from the dashboard to mirror its screen in the browser and send it taps, drags, long presses and typing. It is still experimental: mirroring and taps were tried on a real iPhone; drags, typing, install and launch were not tried on hardware. An iPad is listed too but has not been tried.

## Prepare the iPhone

1. Connect it to the agent Mac with a USB cable, and tap **Trust** when the phone asks **Trust This Computer?**.
2. Turn on **Settings › Privacy & Security › Developer Mode**. The phone restarts. If the setting is not there, open the phone once in Xcode on the Mac and it appears.
3. Set **Settings › Display & Brightness › Auto-Lock** to **Never** and keep the phone on a charger. A locked phone stops the screen capture, and tapflow cannot unlock it.
4. If you connect more than one iPhone, give each its own name in **Settings › General › About › Name**. The Mac's screen capture tells phones apart only by name, so with two phones of the same name tapflow refuses the capture rather than guess which is which.

Only a phone that is connected by USB, trusts the Mac and has Developer Mode on is listed. A phone paired only over Wi-Fi is left out, because its screen cannot be captured.

**Plug a phone in or out while the agent runs; no restart is needed.** The agent re-reads its devices every 30 seconds, so a phone you plug in appears in the device list within about half a minute. One you unplug leaves the list about a minute later, once nobody has it open; its screen capture and runner stop with it. Plugged in again, it opens as a new session.

## Set the signing team

Input to the phone goes through an XCUITest runner tapflow installs on it. To install there, the runner has to be signed by an Apple developer team, so set the team ID in the environment the agent runs in.

```sh
export TAPFLOW_IOS_TEAM_ID=ABCDE12345
tapflow agent start
```

| Variable | Description |
|---|---|
| `TAPFLOW_IOS_TEAM_ID` | The Apple developer team ID (10 characters) that signs the runner. Without it the screen still mirrors, but input is refused and the dashboard says to set this variable. The value in parentheses after a signing certificate in `security find-identity -v -p codesigning` is the team ID. |
| `TAPFLOW_IOS_BUNDLE_PREFIX` | Bundle ID prefix for the runner. Defaults to `dev.tapflow`. An App ID is unique across every Apple team, so if another team has registered `dev.tapflow.treerunner.*`, set a prefix your team uses, such as `com.example.tapflow`. |

Xcode on the Mac must be signed in to an account in that team (**Xcode › Settings › Accounts**).

**The first build changes the team's Apple developer account.** The runner is built with `-allowProvisioningUpdates`, which registers the phone as one of the team's devices and creates the App IDs `<prefix>.treerunner.host` and `<prefix>.treerunner.uitests` and a development provisioning profile for them. Opening a phone the runner was not built for rebuilds it, to register that phone.

## Allow the Camera permission

macOS treats a USB-connected iPhone's screen as a camera device. So the first time a phone is opened, tapflow builds `device-capture-helper` on the agent Mac (in `~/Library/Caches/tapflow`; it needs Xcode's Swift compiler), and macOS asks whether this app may use the camera.

**The prompt appears on the agent Mac's screen, so someone at the Mac has to click Allow.** If your team tests remotely, have the operator open a phone once to allow it ahead of time. If it was denied, switch `device-capture-helper` on in **System Settings › Privacy & Security › Camera**. While it is denied, the dashboard shows an error starting with `Screen capture: camera access denied`.

When the capture fails, the reason shows in the device status on the dashboard. If the phone is locked or its cable came out, unlock it or plug it back in, and tapflow tries the capture again.

## Install a build

A phone takes only a device build: the `.ipa` you upload to Firebase App Distribution or export for ad-hoc or development, or an iphoneos `.app` zipped or tarred.

- **An install goes over the app already on the phone, without removing it first.** The app's data and sign-in stay. Unlike a simulator, it does not start from a clean state.
- If the phone refuses the install (a profile without this phone, an expired certificate), the app it had stays.
- Only when the installed app is signed by another team or App ID, so it cannot be replaced in place, does tapflow remove it and install once more. Its data is lost then.
- **A simulator build cannot run on a phone.** When the same app is already installed from TestFlight or Firebase, tapflow uses that copy, and the dashboard warns that you are not testing the build you uploaded and names the installed version. When it is not installed, the install fails asking for a device build.

## What a phone cannot do

These are refused on a phone, and the dashboard does not show their controls:

- **Full reset**, run resets, and clearing app data
- The clipboard, network control, opening a URL or deep link, and the agent's screenshots
- **Rotate** and the software keyboard button
- Pinches, holding a button down, the side button, and ⌘/⌃/⌥ shortcuts

A drag is played after you let go, as a straight line from where it started to where it ended. The home and volume buttons are sent to the phone; the volume buttons have not been tried on hardware.

A phone boots nothing on the Mac, so its session is not refused when the Mac is short of memory or CPU. In the device list it sits under its iOS version with the simulators, reads **Connected** rather than Booted, and can be starred, renamed or hidden like any other device. When the Mac is overloaded, its card still opens for its phones, and only the simulators are greyed out.

## Related

- [Agent Setup](/operate/agents)
- [Configuration](/reference/configuration)
