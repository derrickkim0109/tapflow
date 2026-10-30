---
"@tapflowio/android-agent": minor
---

A USB-connected Android phone is offered beside the emulators (#152): every row of `adb devices` in state `device` that is not an emulator or a network serial, as `usb:<serial>` with `kind: 'physical'`, named from `ro.product.marketname`, the phone's device name, or `ro.product.model`. Emulators now report `kind: 'emulator'`. A phone's boot starts scrcpy and input only — no launch, wipe, gRPC, Lean mode or network reset — and its shutdown stops only the stream. Full reset, network control, the clipboard and postures are refused on a phone through each message's error reply, and storage is never reclaimed on one. The rotation lock a phone had at boot is written back at shutdown, or on the next listing that sees it if it was unplugged first (#1033).
