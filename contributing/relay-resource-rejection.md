---
type: rationale
topics: [relay, resource-management, session]
status: stable
---

# Why the relay rejects new sessions when an agent is overloaded

> Read this before removing the CPU/RAM gate on `session:start`, or before moving the
> decision into the agent. An overloaded Mac silently degrades every existing session.

## The problem

When another session attaches to an already-overloaded Mac, the streaming quality of the
QA sessions already running on it drops. Origin: [#107](https://github.com/jo-duchan/tapflow/issues/107).

## Decisions

- **The relay decides, the agent does not change.** The agent already reports `agent:resources`
  every few seconds. The relay evaluates that data and rejects a new `session:start` with a
  clear client error when CPU or RAM is over the threshold (default 80%; RAM with one exception, below). No agent-side code
  is touched.
- **Fail open.** If there is no resource data, the session is allowed. A stale-data check is
  unnecessary: the agent reports every ~5 seconds and a dropped connection tears the session
  down anyway.
- **Reject, do not queue.** There is no waiting queue and no auto-resume when resources
  recover; the client retries. A single global threshold is used, not per-machine tuning.
- **Memory does not refuse a person joining a device the relay has up; CPU refuses any join.** The
  two halves cost different things. Booting is what spends memory, and the join only starts a stream,
  whose encoding is the CPU load this gate exists for. Judging memory on every join refused a tester's
  own reconnect: the dashboard re-sends `session:start` after every connection drop, and the close
  clears the owner, so the relay cannot tell the person coming back from a newcomer. Once other devices
  had filled memory, a Wi-Fi blink lost the tester their device. Two limits keep it honest. "Up" is
  `readySent`, not `deviceStatus`: a simulator booted before the agent registered reports `booted`
  without the relay ever bringing it up (#440), and the viewer's next boot would be a full one. And
  an AI client keeps the memory check, because its boot warms the UI-tree runner, which costs memory
  on a device already running.
- **The CPU half pauses on a Mac whose boot slot is held.** A cold boot pins the CPU for 30–90 s
  ([simulator-boot-contention.md](./simulator-boot-contention.md)), and the per-Mac boot gate
  (`packages/relay/src/admission/`) already decides when the next boot may start. A join during that
  time is not a boot, so refusing it would lock a person out of a device that is up, for the length of
  someone else's boot. Outside a held slot the CPU check is unchanged. "Reject, do not queue" still holds
  for this gate; the boot gate is the one place a request waits, and only a person's boot does.
- The error message is returned to the client; surfacing it in the dashboard UI is a
  separate concern. This gate is distinct from any slot-count mechanism, which follows its
  own path.
