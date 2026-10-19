---
type: rules
topics: [flow-runner, yaml, replay]
status: living
---

# flow-runner — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`@tapflowio/flow-runner`: deterministic YAML flow engine — the replay half of the automated QA axis.
Flows are authored once (by an agent via MCP, or by hand) and replayed with **zero LLM calls**: same input → same execution, no API cost in CI.

Published on the standard npm channel and versioned by changesets in the repo-wide fixed group. Publish only via the changesets flow — see [CONTRIBUTING.md § Branches & releases](../../CONTRIBUTING.md#branches--releases).

Consumers: `tapflow flow run` (CLI) and the `run_flow` MCP tool — both drive the same engine, so results never diverge.

## HOW

- `schema.ts` — YAML → `Flow` (hand-rolled validation, indexed error messages `file: steps[i]: …`). Step vocabulary is deliberately minimal: `clearState / launchApp / tapOn / inputText / pressKey / swipe / scroll / openUrl / assertVisible / assertNotVisible`. No fixed `sleep` step — waiting is always condition-based (`assertVisible` + `timeout`).
- `engine.ts` — executes steps against the `FlowDriver` interface (DIP: relay transport, mcp adapter, and test fakes all satisfy it). Selector resolution: bare string → exact identifier → exact label → partial label; `{id}` / `{label}` are explicit. **Multiple matches on `tapOn` fail immediately** (no implicit first-pick); `assertVisible` accepts ≥1. Polls `queryUITree` every 500ms up to the timeout (default 10s, per-selector `timeout` override). `launchApp` waits differently: until the tree's structure holds still for a second, capped 3 s after the first successful read — see `waitForScreen` for why a single read cannot tell a splash from the first screen.
- `suggest.ts` — on a `tapOn` that matched nothing or several, up to three replacement lines from the last tree the poll saw (B2), no LLM. **Each is written out, read back through `parseSelector` and must tap exactly that element** (identity, not "one match": a bare string resolves by identifier first, and iOS identifiers often equal another element's title); `index` is the last resort; an `input` is offered by its `id` (with `role`/`index` when ids repeat), never its label, since the label can be what was typed. **Never for `assertVisible`**: a near match there is as often the app being wrong, and an agent reading `get_run` would apply it and turn a regression green.
- `RelayClient.ts` / `RelayDriver.ts` — WS (session/input, message shapes shared with dashboard/mcp) + REST (`/ui-tree`, `/screenshot`). **A ui-tree failure is judged by what this client knows about the session before it is judged by the HTTP status**: a `terminated` session can never answer again and a rebound one cannot answer *this run* — the engine has no boot step to restore the binding — so those fail the step now and name the cause, while `away` — the relay's 15s hold — keeps polling, which is what the retry is for. Failing rather than recovering is what *same input → same execution* requires: a run that repaired itself by re-booting mid-flow would not be the same execution as one that did not, and the engine has no boot step to repair it with. `launchApp` targets the CLI `--build` / `run_flow` `buildId`, so flow files never hardcode a buildId and stay portable across CI runs.
- `inboundDisposition.ts` — what this client does with each of the 29 messages a browser socket can receive, or why it deliberately does not. A deliberate **copy** of `mcp-server`'s rather than a shared module: the key set is shared already (it comes from `@tapflowio/protocol` through `satisfies`), and the values genuinely differ — this package never shuts a device down, and its input-ack wrapper deliberately appends no session note where the other appends one. Checked both ways by `scripts/__tests__/clientInboundDisposition.test.mjs`.
- **A session-scoped failure carries what the relay said about that session**, through `failed()`, and `scripts/__tests__/sessionNoteCoverage.test.mjs` enforces it across both clients — see [mcp-server/AGENTS.md](../mcp-server/AGENTS.md) for why it anchors on the construction rather than the `throw`.
- `video.ts` — `VideoTap` turns the held stream into one video per flow (A4): records `[u8 kind][u32 BE ms][u32 BE len][payload]` (a frame as received, or a JSON event: chrome, device info, step marks from the engine's `onStep`), chunked at ~2 s / ~2 MB and before every decodable keyframe. **A chunk's `keyframe` means an IDR carrying SPS/PPS** — a point decoding can begin from. iOS and the emulator's gRPC encoder carry them on every IDR; scrcpy only on its first, so its video plays from the start and seeks only there. That is the backend's standing, absorbed rather than detected: protocol has no backend field, and a frame-based verdict could only arrive after the video was opened. A video starts at the last decodable keyframe before its flow, because a still screen may not key for a minute. JPEG is not kept, and a flow whose H.264 never offered a decodable keyframe (scrcpy after its first one has aged out of the 6 MB lead-in) opens with `notRecorded: 'no-keyframe'` so the page can say why rather than show nothing. The tap reads frames only through `RelayClient.setStreamListener`; the engine never sees it.
- `credentials.ts` — where a client's token comes from (T1): `--token`, then a non-empty `TAPFLOW_TOKEN`, then `~/.config/tapflow/credentials.json` (`$XDG_CONFIG_HOME`, `TAPFLOW_TOKEN_FILE`), keyed by relay origin with loopback hosts folded together. Here because mcp-server and cli both depend on this package and on neither other. **Opt-in**: `RelayClient` takes `string | TokenSource`, and a string is used as given — constructing a client never reads a file under `$HOME`, so a third party's token is never swapped for one it did not pass. `fetchWithToken` retries a 401 once **when the token differs from the one the request carried**, not from the last read, so every request in flight on an old token recovers; an explicit token is never replaced. Every relay 401 comes from its auth middleware before any handler, so retrying a POST is safe. `tokenRefusal` is the one message: which relay, which source, which fix.
- `junit.ts` — one `<testcase>` per flow, step log in `system-out` / `<failure>`.
- `schema/tapflow-flow.schema.json` — JSON Schema shipped for editor autocomplete; keep it in sync with `schema.ts` when the vocabulary changes.
- Exit-code contract (CLI): `0` all passed · `1` any product or mixed flow failure · `2` environment/config error, including relay/agent/session failures when every failed flow is environmental. Never conflate 1 and 2 — CI dashboards rely on the distinction.
- Coordinates are normalized 0-1 everywhere, matching the touch path and `query_ui_tree` frames.
- `clearState` maps to `app:clear-state` (relay) → `pm clear` (Android) / data-container wipe (iOS `SimctlWrapper.clearAppData`).

## HOW NOT

- Do not call an LLM anywhere in this package — replay must stay deterministic and free.
- Do not add a fixed-sleep step; add condition-based waits instead.
- Do not resolve ambiguous selectors implicitly (first-match). Fail loudly with candidates.
- Do not put relay-side logic here — this is a client, like mcp-server.
- Do not let the engine depend on `RelayClient` — engine code touches only `FlowDriver`.
