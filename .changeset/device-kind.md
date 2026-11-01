---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/relay": minor
---

`DeviceReport` and `Device` carry an optional `kind` — `simulator`, `emulator` or `physical` — on `agent:register` and `agent:devices` alike. A relay drops a kind it does not know, as it does a form factor, and passes it to `agents:listed`. No agent reports `physical` yet; this is the field USB-connected devices (#152) will use.
