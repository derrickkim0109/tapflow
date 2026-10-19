---
type: diagnosis
topics: [macos, ios, system-extension, setup, cli]
status: living
updated: 2026-09-16
---

# Deep-linking into System Settings — what actually opens the approval sheet

Installing the iOS network filter ends with a step only a human can do: approve the system
extension in System Settings. `tapflow migrate net-filter` and `tapflow setup ios` print the path
to it, and [#799](https://github.com/jo-duchan/tapflow/issues/799) records that people miss it
anyway — the macOS prompt can be dismissed without acting, and the banner is one line.

Offering to *open* that screen needs a URL, and the obvious candidates do not work. This is the
measurement, on **macOS 27.0**, 2026-09-16.

## What works

```
x-apple.systempreferences:com.apple.ExtensionsPreferences?extensionPointIdentifier=com.apple.system_extension.network_extension.extension-point
```

It opens Login Items & Extensions **with the Network Extensions sheet already presented**, showing
`TapflowNetFilter` / `dev.tapflow.netfilter.ext` and its approval toggle. Not the containing pane —
the sheet with the switch in it, which is the screen the banner describes.

The `.extension-point` suffix is part of the identifier. The bare
`com.apple.system_extension.network_extension` — the string `systemextensionsctl list` prints as its
extension point — was **not** tested, so nothing here says whether it also works.

## What does not

Each row is a complete value — paste it into `open` as it stands. That matters more here than it
looks: a URL you had to reassemble from a prefix and an identifier fails the same way a *wrong* URL
does, and by the trap below, `open` answers `0` either way. A typo and a dead end are then
indistinguishable.

| URL | Where it lands |
|---|---|
| `x-apple.systempreferences:com.apple.LoginItems-Settings.extension` | Login Items & Extensions, scrolled to the **top** — the per-app background-activity list. The Extensions categories are further down and it does not go there |
| `x-apple.systempreferences:com.apple.LoginItems-Settings.extension?ExtensionItems` | Identical to the row above. The anchor changes nothing observable |
| `x-apple.systempreferences:com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension` | The **Network** pane. Useful-looking — it shows `Filter: Active` — but it is the filter's *configuration*, not the extension's approval toggle |

Those two locations are easy to confuse, and they are different things. **Network → Filter** reports
whether a content filter configuration is enabled. **General → Login Items & Extensions → Network
Extensions** is where the system extension is approved. A tester sent to the first one sees
"Active" and concludes the setup is done.

## Two traps in measuring this, both of which produced a wrong answer first

**1. The exit code is not a signal.** `open` returns `0` and launches System Settings for a
*deliberately nonexistent* pane id:

```
com.apple.this.pane.does.not.exist   → exit=0, System Settings launched
com.apple.LoginItems-Settings.extension → exit=0, System Settings launched
com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension → exit=0, System Settings launched
```

All three are indistinguishable. Without the control in that first row, "both candidates returned 0"
reads as "both work", which is what it looked like. **Run the bogus id every time** — it is the only
thing that says whether the signal you are reading discriminates.

This has a consequence for the CLI, not just for the experiment: **nothing can confirm the sheet
opened.** A command that offers to take the user there must not claim it succeeded, and should keep
the click path in its message for the case where it did not.

**2. An already-open System Settings masks the navigation.** If the pane is already on screen, the
same URL does not move it, and "the anchor worked" is indistinguishable from "it was already there".
The first reading of `?ExtensionItems` was invalidated exactly this way. Quit first:

```sh
pkill -x "System Settings"
```

**Use `pkill`, not `osascript`.** `osascript -e 'quit app "System Settings"'` is app automation and
raises a TCC prompt. Over SSH the requester is attributed to the login shell's ancestor, so the
dialog reads *"sshd-keygen-wrapper wants to control System Events"* — an alarming, permanent,
broad grant for a one-off measurement. A signal needs no permission.

## How to re-measure on a new macOS

The pane identifiers are ExtensionKit bundles and can be enumerated without opening anything:

```sh
ls /System/Library/ExtensionKit/Extensions/
```

Read each bundle's `CFBundleIdentifier` rather than guessing from the filename — the filenames are
generic (`AppExtensionManagement.appex`) and dozens of them contain "Extension". Then test each
candidate against the bogus-id control, quitting System Settings between tries.

Apple's developer forums carry the same finding for the neighbouring panes — that these URLs open a
pane but generally not a nested sheet — so an OS update moving this is likelier than not:
[761193](https://developer.apple.com/forums/thread/761193),
[763382](https://developer.apple.com/forums/thread/763382),
[764384](https://developer.apple.com/forums/thread/764384).
