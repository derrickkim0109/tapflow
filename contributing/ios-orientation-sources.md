---
type: reference
topics: [ios, rotation, simulator, reverse-engineering]
status: stable
related: [android-rotation, simkit-internals]
---

# Reading and writing an iOS simulator's orientation

> Read this before adding an orientation source to `PhysicalOrientation`, moving single-panel turns to
> `devicectl device orientation set`, or polling single-panel devices for turns made outside tapflow.
> The rules live in `packages/ios-agent/AGENTS.md` ("Rotation is the physical orientation"). This file
> holds the measurements behind them, including the sources that look right and are not.

## Two orientations

DeviceHub and Simulator.app turn the whole device, frame and screen buffer together, by the way it is
held: the physical orientation. iOS then lays the app out inside the buffer, and an app that does not
support the new orientation stays on its side. The interface orientation is a separate value. On an
iPhone home screen it stays at portrait however the device is turned.

tapflow draws the physical orientation. Building rotation on the interface orientation was tried first
and gets three things wrong: the frame turns after the content instead of before it, a turn made on the
home screen or in a portrait-locked app is never seen, and a reload joins the device at the wrong angle.

## Read sources

Measured 2026-10-28 and 2026-10-29 on an Xcode 27.1 host (iOS 27.0, 27.1 and 26.5 runtimes) and an
Xcode 26.6 host (iOS 26.5).

| Source | Where | Reads | Result |
|---|---|---|---|
| `xcrun devicectl device orientation get` | host, public | physical | Used on Xcode 27 hosts. Follows DeviceHub, Purple, `devicectl … set` and the guest helper's `orient`, on single-panel devices and the Duo, iOS 26 and 27 runtimes alike. About 0.18 s. A fresh device reports `unknown` until something turns it, and it is drawn upright, so `unknown` reads as portrait |
| The same command on an Xcode 26 host | host | nothing | devicectl does not list simulators there |
| `devicectl device info displays`: `currentOrientation`, `orientation.currentDeviceOrientation` | host, public | interface | Stayed at portrait on the home screen while DeviceHub turned the device four times |
| `simctl io <udid> enumerate` "UI Orientation" (what serve-sim reads), SimulatorKit's `uiOrientation`, WebDriverAgent's `interfaceOrientation` | host or guest | interface | Same problem. On an Xcode 26 host the host side has nothing else |
| backboardd MIG: `_BKSHIDGetNonFlatDeviceOrientation(BKSHIDServicesServerPort(), …)` | guest, private | physical | Used on Xcode 26 hosts, as `guest-helper --orientation` through `simctl spawn` (0.33–0.42 s). Followed all four Purple turns on iOS 26.5. On iOS 27.1 it stayed at unknown or portrait through DeviceHub turns, because DeviceHub turns through vendor HID and not through backboardd. That is why the host's Xcode picks the source and the two are never tried in turn |
| `CMDeviceStateManager.sharedManager.currentDeviceState` (what idb reads) | guest, private | physical, per idb | The class is absent on the iOS 26.5 runtime. Not needed on 27 |
| `BKHIDServicesGet*`, `com.apple.backboardd.*` notifications | guest | nothing useful | Fixed values on iOS 27.1 |
| A `HIDEventSystemClient` monitor in the guest | guest, private | turn events | Saw DeviceHub's `orientation-picker-control` events as they happened. The only push source found, and unused (see below) |

## Write paths

| Device | Path | Notes |
|---|---|---|
| Single-panel | Purple `GSEventTypeDeviceOrientationChanged` (`rotation-helper`) | Works on both host Xcodes. Its landscape names are `UIInterfaceOrientation`'s, so what it calls `landscapeRight` reads back as physical `landscapeLeft`. `PURPLE_ARGS` swaps the two |
| Single-panel, Xcode 27 host | `devicectl device orientation set` | Works, on the iOS 26.5 runtime too, and Safari's layout followed. Not adopted: Purple already covers both hosts, and a second path would be a second behaviour to keep equal for one button |
| iPhone Duo | guest helper `orient <label>`, DeviceHub's own vendor HID event | Purple and `devicectl … set` do nothing on the Duo. `set` answers success and nothing moves. The labels are the physical orientations' names on both panels |

Simulator.app's own rotate commands send Purple as well. So on an Xcode 26 host a turn made in
Simulator.app is a Purple turn, the kind the MIG source was measured to follow. That is inferred from
the path; a turn made by hand in Simulator.app was not measured.

## The Duo

- Folding does not change the physical orientation. Unfolding from landscapeLeft leaves it at
  landscapeLeft, and folding back does too.
- The frame's turn is `(physical + 360 − nativeOrientation) mod 360` for the lit panel. The cover and
  every single-panel device have a native orientation of 0. The unfolded panel's is 270, so held upright
  its frame is turned 90.

## No polling on single-panel devices

The Duo's fold poll reads the orientation with the panels, so a DeviceHub turn shows within one poll.
A single-panel device is read at a session's boot and around each Rotate: before it, to know where to
turn from, and after it, to confirm the turn landed (waiting up to 3 s). Nothing reads it in the
background. Turning a single-panel simulator in Simulator.app or DeviceHub while a tapflow session is
open is not a case the product serves, and a poll would cost CPU on every open session for it (each
devicectl read is about 0.2 s of CPU). If it becomes a case, start from the guest HID monitor above: it
follows a turn immediately, at the price of one more private path that a runtime update can break.

## Other tools (as of October 2026)

- facebook/idb added physical orientation in September 2026. It reads CoreMotion's device state in a
  fresh guest process when CoreDevice advertises a motion capability, and CoreDevice's
  `remote.devicecontrol.orientation` service otherwise. Writes choose vendor HID or Purple by the same
  capability. Its source notes that the CoreDevice stream can replay a stale snapshot.
- baguette does not read the orientation, and its docs say it does not follow DeviceHub turns.
- serve-sim and WebDriverAgent report the interface orientation only.
