---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/relay": minor
---

`DeviceReport` and `Device` carry an optional `kind` — `simulator`, `emulator` or `physical` — validated the same way on `agent:register` and `agent:devices`. A relay drops a kind it does not know, as it does a form factor, and passes it to `agents:listed`. It is fixed for a device id: the relay takes it when a session is created or rebound, and a later `agent:devices` does not change it for a device it already lists.
