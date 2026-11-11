# `tapflow maestro`

Runs one Maestro flow with the Maestro CLI itself on one physical phone, and records it on the Flow Runs page.
The flow is not translated into tapflow's flow format, so `runScript`, `${output.…}` and `when: platform` work exactly
as they do under Maestro.

```sh
tapflow maestro flows/checkout.yaml --device SERIAL0001 --app-id com.example.app
TEST_PHONE=0100000000 TEST_PIN=000000 tapflow maestro flows/login.yaml --device 00008140-0001111111111111 --app-id com.example.app
```

| Option | Default | Description |
|---|---|---|
| `--device <id>` | — | Required. An Android adb serial (or `usb:<serial>`), or an iPhone's hardware UDID. A CoreDevice identifier is translated to the UDID. The device is never picked for you. Emulators are refused. |
| `-e, --env <KEY=VALUE>` | — | A value the flow reads as `${KEY}`. Repeatable. |
| `--app-id <id>` | not set | `APP_ID` |
| `--test-phone <phone>` | `TEST_PHONE` from the environment, else empty | `TEST_PHONE` |
| `--test-pin <pin>` | `TEST_PIN` from the environment, else empty | `TEST_PIN`. Prefer the environment, which keeps it out of shell history. |
| `--output-dir <dir>` | `~/.tapflow/maestro-runs/<time>-<flow>-<platform>` | `OUTPUT_DIR`: screenshots, `maestro.log` and Maestro's debug output. Default folders older than seven days are removed on the next run. |
| `--apple-team-id <id>` | `TAPFLOW_MAESTRO_APPLE_TEAM_ID`, else not passed | The team that signs Maestro's iOS driver |
| `--relay <url>` | `ws://localhost:4000` | The relay the run is recorded on |
| `--token <token>` | `TAPFLOW_TOKEN`, then the token file | Token for recording (`view, builds:write`) |
| `--no-record` | — | Do not record the run (the device-in-use check still runs when the relay is reachable) |

`TEST_PHONE` and `TEST_PIN` are always passed, empty when unset: Maestro leaves an unknown `${KEY}` as the text
`undefined`, which a flow would then type into a field.

## Before Maestro starts

- adb is looked for in the order the Android agent uses: `$ADB_PATH`, `$ANDROID_HOME/platform-tools`,
  `$ANDROID_SDK_ROOT/platform-tools`, `~/Library/Android/sdk/platform-tools`, then PATH. A different order could pick
  another adb version, and two adb versions on one Mac kill each other's server. A login shell under PM2 or a CI runner
  often has no SDK on PATH. The adb found is also put first on Maestro's PATH. When none is found and the id matches no
  device, the error says `adb not found`.
- Android: the screen is woken, or screenshots come out black and taps land on the lock screen.
- iPhone: `iproxy` (`brew install libimobiledevice`) is required. If an `iproxy` left by an earlier run *for this same
  phone* holds the driver port `22087`, it is ended. If an `iproxy` for another iPhone holds it, or any other program,
  the run is refused (exit 2) and nothing is ended — one Mac runs one iPhone at a time. The app is launched with
  `devicectl`, since Maestro cannot launch apps on a physical iPhone.
- When the relay is reachable, a device a tapflow session holds is refused. When it is not, the run goes on with a
  warning. A session opened on the phone while the run is going is not prevented.

## The record

- Steps: Maestro's command log. A `when:` that did not hold is skipped; a failed `optional` command passes with a note.
- Failure kind: `environment` when no step ran, when Maestro's output shows a driver, connection or device problem, or
  when the flow file itself was refused; otherwise `product`.
- Attachments: `maestro.log`, then the failure screenshot, then the flow's screenshots — only files written by this
  run, all within 60 seconds, stopping at the first network error.
- Redaction: PIN, password, CVC, phone and account values are replaced with `***` in step names, failure messages and
  the attached log. They are still in Maestro's own arguments (`-e TEST_PIN=…`), so `ps` on the same Mac shows them,
  and in the local `maestro.log`.
- The relay keeps at most 100 files, 3 logs and 200 MB per run, and removes a deleted run's files within the hour.

## Exit codes

`0` passed · `1` failed · `2` could not run (no such device, no `maestro` or `iproxy`, device in use, port held, bad
option, anything unexpected) · `130` interrupted (Ctrl-C or SIGTERM: Maestro and iproxy are stopped and the run is
recorded as aborted).
