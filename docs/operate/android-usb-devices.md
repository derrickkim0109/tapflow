---
title: Android phones over USB
description: Open an Android phone plugged into the agent Mac like an emulator. Covers the TAPFLOW_ANDROID_USB_DEVICES switch, which is off by default, turning on and authorizing USB debugging, what a phone refuses, and the rotation setting that comes back when a session ends.
---

# Android phones over USB

You can list an Android phone plugged into the agent Mac over USB and open it like an emulator. It streams its screen and takes touch, keys, app installs and launches. tapflow never starts, stops or erases the phone.

## Turn on phone listing {#turn-on}

This is off by default. Once it is on, anyone who can reach the relay can see the phone's screen and notifications, its apps and their data, from outside too if the relay is open to external access. So that a personal phone plugged in to charge is not opened to the whole team, the person running the agent turns it on.

Start the agent process with the environment variable set.

```sh
TAPFLOW_ANDROID_USB_DEVICES=1 tapflow agent start
```

Put the same variable in front of `tapflow start` when it runs the relay and the agent together. Any value other than `1` leaves it off, and with it off the device list is what it was before this feature: emulators only, and no command is sent to a phone.

Use a phone kept for testing rather than a personal one. A phone with a messenger, an authenticator or other personal data on it is safer left unplugged.

## Prepare the phone {#prepare}

1. On the phone, open **Settings > About phone > Software information** and tap **Build number** 7 times to turn on Developer options. The menu names differ slightly between manufacturers.
2. In **Developer options**, turn on **USB debugging**.
3. Connect the phone to the agent Mac with a USB cable.
4. When the phone asks **Allow USB debugging?**, check **Always allow from this computer** and tap **Allow**.

You can plug the phone in before or after you start the agent. The agent re-reads its device list every 30 seconds, as it does for emulators, so a phone plugged in while it runs appears within about 35 seconds without restarting the agent. A phone you unplug leaves the list the same way, or after its session ends if someone is using it. This needs a relay on a version that includes the device list refresh; with an older relay, a phone plugged in or unplugged shows up only after the agent restarts.

When a phone cannot be used, the agent prints why, once. It prints again when the same phone reaches another state or is plugged in again.

| State | What to do |
|---|---|
| `unauthorized` | Answer the USB debugging prompt on the phone. The phone appears within about 35 seconds. |
| `offline` | Unplug the cable and plug it back in. |
| `recovery` and similar | The phone is not running Android, as in recovery mode. Start Android on it. |

A phone connected over wireless debugging (`ip:port`) is not listed yet.

## What a phone refuses {#refused}

These are refused because they are emulator-only or would leave the phone changed after the session. Asking for one returns that feature's error with the reason.

- **Full reset**: it would erase the phone.
- **Network control**: a session that ended offline would leave the phone offline.
- **Clipboard**: not supported yet.
- **Fold and unfold**: fold a foldable phone by hand.
- **Clearing app data**: only an app tapflow installed in this session can be cleared. A flow run's reset follows the same rule and reports any other app as failed instead of clearing it.

A full phone is never given room by rolling back its system apps' updates. Video always comes over scrcpy, so `TAPFLOW_ANDROID_BACKEND=grpc` does not apply to a phone.

A request that borrows a device by platform alone, as `tapflow flow run` and the MCP server make, never picks a phone. To run on a phone, name that device.

### Installing an app {#install}

An emulator starts each install from empty app data, but a phone installs over the app already there, so **the app's data stays**. To start empty, clear the app's data after installing. If an app with the build's package name fails to install because it is signed differently, its data is left as it was.

### When an install stops {#install-prompt}

When the phone shows **Verify apps over USB** or a Play Protect scan, `adb install` waits for an answer. tapflow reports the install as failed after 120 seconds plus 1 second per MB of the APK. If the phone shows a prompt, answer it and install again. Turning off **Verify apps over USB** in Developer options stops the prompt. If there was no prompt, the install of a large build on a slow connection ran out of time; raise it with `TAPFLOW_ANDROID_USB_INSTALL_TIMEOUT_MS`.

## Rotation setting {#rotation}

Pressing **Rotate** locks the phone's rotation, which also turns its auto-rotate off. When the session ends, the rotation setting from before the session comes back: auto-rotate if it was on, or the orientation it was locked to.

- If you stop the agent mid-session (Ctrl+C), it puts the setting back as it exits.
- If it cannot (the phone was unplugged first, or the agent crashed), it keeps the setting in `~/.android/tapflow-usb-rotation.json` and puts it back the next time the agent lists that phone: within about 35 seconds of plugging it back in, or when the next agent starts. With `ANDROID_USER_HOME` set, the file is kept in that directory.

Rotation does not work on an older Android phone without the `wm user-rotation` command.

## What is left on the phone {#left-on-phone}

tapflow pushes the scrcpy server that streams the screen, and a file that reads the UI tree, to the phone's `/data/local/tmp`, and removes them when the session is shut down normally. If the phone is unplugged or the agent stops mid-session, they can stay until a later session on that phone is shut down normally. Their names differ from the scrcpy you may run yourself, so the two do not overwrite each other.

The phone's screen stays on while it streams. If the lock screen comes up, the PIN is typed in the viewer and goes through the relay. Apps that block screen capture show black.
