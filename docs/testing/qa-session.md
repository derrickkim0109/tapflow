---
title: QA Session
description: "Pick a Mac and a device to start a session and drive the device screen from your browser. Every feature a session offers, with a link to its own page."
---

# QA Session

A QA Session is where you watch and drive an iOS simulator or Android emulator running on a Mac, straight from your browser. The device runs on your operator's Mac, so teammates install nothing. It opens when you press **Start QA** on a build's row in [App Center](/testing/app-center).

## Start a session {#start-a-session}

### Pick a Mac {#select-mac}

**Select Mac** shows a card for each Mac that has devices for this platform. Each card has the Mac's name, a status dot, its free slots (free/total, such as `2/4 slots`), and its CPU and RAM usage.

| Status dot | Meaning |
|---|---|
| Green | Plenty of headroom |
| Yellow | CPU or RAM from 70% up to 80% |
| Red | CPU or RAM over 80%. The card cannot be picked |
| Grey | No usage report, or none for over 30 seconds. The card shows **Stale** |

Hovering a red card shows **This Mac is currently overloaded. Try again later.** Pick another Mac or try again shortly.

### Pick a device {#select-device}

Click a device under **Select device** to start the session. Each device shows its state.

- **Booted**: already running.
- **Available**: shut down and free. Picking it boots it.
- **In use**: another teammate is using it, so it cannot be picked.

Find a device by name with **Search device…**. Narrow the list with the OS version filter (default **Any version**).

Turn on **Full reset** before picking a device to erase all of its data first, other apps included. Even with it off, the build under test is installed fresh at every session start, so that app always starts with its data cleared. It applies once: the switch turns itself off the moment you pick a device. The switch appears only when the Mac supports resetting.

### Launch the app {#launch}

Once the device is up, the build is installed on it automatically. The info card to the right of the device shows progress such as **Starting device…** and **Installing app…**. When the install finishes, a **Launch app** button appears in the toolbar; press it to run the app. See [Device controls](/testing/device-controls#launch-the-app).

### Leave a session {#leave-a-session}

The breadcrumb at the top reads `app name › build › Mac › device`. Click an earlier step to go back to it. Leaving the device screen shuts that device down, so another teammate can use it straight away. Closing the browser tab does the same.

## What you can do in a session {#features}

| Feature | What it does |
|---|---|
| [Touch and gestures](/testing/device-controls#touch-and-gestures) | Click to tap, drag to swipe. Hold Option (Alt) and drag to pinch. |
| [Typing](/testing/device-controls#typing) | Click the device screen once, then type. |
| [Launch the app](/testing/device-controls#launch-the-app) | Run the installed build with **Launch app**. |
| [Device buttons](/testing/device-controls#device-buttons) | Press iOS Home and the side buttons on the device frame, or Android **Home**, **Back**, **Recent Apps**, **Volume Up**, **Volume Down** and **Power**. |
| [Software keyboard](/testing/device-controls#software-keyboard) | Show or hide the iOS on-screen keyboard. |
| [Rotate](/testing/device-controls#rotate) | Turn the device between portrait and landscape. |
| [Fold and unfold](/testing/device-controls#fold) | Fold or unfold a foldable Android emulator. |
| [Restart the device](/testing/device-controls#restart) | Restart the device. The build under test is reinstalled; other apps keep their data. |
| [Clipboard](/testing/device-controls#clipboard) | Copy and paste text between the device and your computer. |
| [Deep links](/testing/deep-links) | Open a specific screen of the app from a URL. |
| [Network control](/testing/network-control) | Take the device offline and bring it back. |
| [Audio](/testing/audio) | Hear the device in your browser. |
| [Screenshots](/testing/screenshots-and-recordings#screenshots) | Download the device screen as a PNG. |
| [Recordings](/testing/screenshots-and-recordings#recordings) | Record the device screen as a video and share it with the team. |
| [Comments](/testing/comments) | Leave notes and images on the build. |
| [Keyboard shortcuts](#keyboard-shortcuts) | Run common actions with one key combination. |

The buttons sit in the toolbar to the right of the device, in four groups: Navigation, Device, Capture and Environment. A button for a feature the Mac does not support is not shown.

## Info card {#info-card}

The info card to the right of the device shows the session's state.

- **Focus**: turns green while your keystrokes go to the device.
- **fps**: frames per second arriving. Above 15 it reads **Active**, otherwise **Idle**. A low number is normal while the screen is still.
- **Smooth** / **Standard**: the stream profile this browser gets. Click **Standard** for a dialog on what it takes to switch to Smooth. See [Stream quality](/operate/streaming-quality) for the profiles.

The tabs under the card hold [Comments](/testing/comments) (**Comments**) and [Recordings](/testing/screenshots-and-recordings#recordings) (**Recordings**).

## Keyboard shortcuts {#keyboard-shortcuts}

These shortcuts do not fire while the cursor is in one of the dashboard's text fields.

| Shortcut | Action | Platform |
|---|---|---|
| <kbd>⌘</kbd> <kbd>K</kbd> | Open the [deep link](/testing/deep-links) box | iOS, Android |
| <kbd>⌘</kbd> <kbd>S</kbd> | [Screenshot](/testing/screenshots-and-recordings#screenshots) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>Y</kbd> | Start or stop a [recording](/testing/screenshots-and-recordings#recordings) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd> | [Rotate](/testing/device-controls#rotate) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>U</kbd> | [Home button](/testing/device-controls#device-buttons) | iOS |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>K</kbd> | Show or hide the [software keyboard](/testing/device-controls#software-keyboard) | iOS |
| <kbd>⌥</kbd> + drag | [Pinch](/testing/device-controls#touch-and-gestures) | iOS, Android |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>C</kbd>·<kbd>X</kbd>·<kbd>V</kbd> | [Clipboard](/testing/device-controls#clipboard) copy, cut and paste | iOS, Android |

Any other key goes to the device once you have clicked its screen.

## Limits {#limits}

- One person uses a device at a time. A device someone else is using shows **In use** and cannot be picked.
- Leaving the device screen shuts the device down. Whatever was open on screen is gone and other apps keep their data. The build under test is installed again when the next session starts, so its data does not carry over.

## Troubleshooting {#troubleshooting}

When a session drops, the dashboard says why in a notice and returns to the Mac list.

| Notice | Cause and what to do |
|---|---|
| **`The agent disconnected — this session ended.`** | The Mac's connection dropped. Pick the Mac again to start a new session. |
| **This device is already open in another browser session.** | Someone else is using the device. If you reloaded while your connection was down, your own earlier tab is holding it, and it clears within about 45 seconds. |
| **That Mac is too busy to start a session.** | The Mac's CPU or RAM is over the limit. Pick another Mac or wait a moment. |

If the stream stalls or lags, see [Stream & sessions troubleshooting](/troubleshooting/streaming).

## Related {#related}

- [App Center](/testing/app-center): picking a build and changing its review status
- [Device controls](/testing/device-controls): touch, buttons, rotation, the clipboard and the rest
- [Stream quality](/operate/streaming-quality): how the Smooth and Standard profiles differ
