---
"@tapflowio/dashboard": minor
"@tapflowio/relay": patch
"@tapflowio/protocol": patch
---

**Connect Physical Device** (#152). On the QA page's Mac screen a button lists the phones plugged into every Mac by USB (`kind: 'physical'`, the build's platform only), each with the Mac it is on and whether it is free; picking one opens a session on it, resuming or asking to take over as a simulator's card does. A Mac's card and device list now hold its simulators and emulators only. Until a phone's first frame the device shows "Connected to physical device. Waiting for device...". The viewer leaves out what an agent refuses on a phone — rotate, deep links, the clipboard, network control and Full reset — and a phone boots `app-only` even with Full reset armed. A stream that fails mid-session (an uncorrelated `device:boot-error`) is shown and cleared by the next frame. The relay no longer holds a phone to its Mac's CPU or memory load: `handleSessionStart` lets it in, and `MacAdmission` is judged on the Mac's simulators and emulators.
