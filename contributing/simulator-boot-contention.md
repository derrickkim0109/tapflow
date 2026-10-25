---
type: diagnosis
topics: [performance, capacity, resource-management, ios, android]
status: living
related: [measurement, relay-resource-rejection, workshop-lab-fork-observations]
---

# What a simulator boot does to the other sessions on the same Mac

> Read this before adding a resource gate, a memory threshold, or a priority trick meant to protect a
> person's session from automated runs on the same Mac. The measurements below show where the harm is,
> and a memory percentage does not find it.

## The question

A person and automation share a Mac. When automation brings up more devices, does the person's session
degrade, and which signal says so early enough to act on? The relay's existing gate
([relay-resource-rejection.md](./relay-resource-rejection.md)) refuses a join above a CPU or memory
percentage. The obvious extension is to tighten that percentage for automated sessions. These
measurements are why that is the wrong shape.

## Method

One client holds a "person's" device the way the dashboard does (`session:start` with
`clientKind: 'dashboard'`, H.264), launches Settings and swipes every 2 s. For each swipe it records the
time from the first touch to the first frame captured after it (**input→frame**), and it counts frames
per second. Once a second it samples the host:

- the relay's current memory metric (`vm_stat` active + wired + compressor, as `agent-core` computes it)
- the same without file-backed pages
- `kern.memorystatus_level` and `kern.memorystatus_vm_pressure_level`
- per-second deltas of `vm_stat` compressions, decompressions, pageins and swapouts
- host CPU

Each stage boots one more device and holds for 120–150 s. Results are read per stage, from 30 s after the
boot completes, and separately as 10 s buckets around each boot.

Two hosts:

| Host | RAM | OS / Xcode | Devices |
|---|---|---|---|
| MacBook Pro (Apple Silicon) | 32 GB | Xcode 26 | iOS 26 simulators, Android 14–16 emulators |
| Mac mini M2 | 8 GB | macOS 27 / Xcode 27 | iOS 27 simulators |

The harness is not in the repo. Two of its mistakes are worth knowing before writing another one; see
[Pitfalls](#pitfalls).

## Findings

### 1. A device that has finished booting does not hurt the person's session

| | MacBook 32 GB | Mac mini 8 GB |
|---|---|---|
| Devices up at once | 9 (3 already up + 5 simulators + 1 emulator) | 4 iOS simulators |
| Person's session once settled | mostly at baseline (one unexplained dip, see Pitfalls) | **at baseline**: 15–16 fps, input→frame p95 197–287 ms |
| Current memory metric | 69 → 79 %, then flat | 66 → 80 %, then flat |
| `memorystatus_level` | 56 → 36 | 55 → 28 |
| Pressure level | warn from the second added device, session fine | **warn with only the person's device up**, session fine |

The memory metric flattens near 80 % on both hosts because macOS absorbs the rest by compressing. In that
state the person's session is unaffected. On 8 GB the pressure level sits at warn permanently.
**Neither the percentage nor the pressure level separates a harmed session from an unharmed one.** The
memory cliff, where a settled session degrades, was not reached on either host.

### 2. The harm is the boot itself, for 30–90 seconds

During each boot on the 8 GB Mac:

- host CPU went to 98–100 % for 60–90 s
- decompressions reached 20–33 thousand per second and pageins about 14 thousand
- swapouts appeared
- the person's session dropped to 4–7 fps, with input→frame up to about 1 s

On 32 GB the same window was 30–60 s at 60–79 % CPU. **The cost is memory population**: the booting
simulator's own process tree used only 60–80 CPU-seconds over 90 s, and the rest was the kernel compressing,
decompressing and paging the other devices' memory to make room. A simulator booted before (warm data)
still did this, so the cost is not first-boot indexing alone.

### 3. Priority demotion protects the person and breaks the boot

Demoting the booting simulator's whole process tree (every descendant of its `launchd_sim`, re-swept each
second) on the 8 GB Mac:

| Method | Booting device | Person's session during the boot | After restoring |
|---|---|---|---|
| none | 5–22 s | min fps 4.4–14.4, p95 212–661 ms, CPU > 90 % for 27–57 s | — |
| `taskpolicy -b` for 120 s | 108–139 s | **min fps 14.6–15.2, p95 84–115 ms, CPU > 90 % for 0 s** | the spike arrives then: p95 573–676 ms |
| `taskpolicy -b` until settled | **not booted after 5 min** | fps 15.5, p95 97 ms | — |
| `taskpolicy -t 5 -l 5` | 10–17 s | one boot better, one worse | no spike |

`-b` (`PRIO_DARWIN_BG`) throttles disk I/O as well as CPU. The boot is bound on paging, so throttling I/O
stalls it, and releasing on a timer only moves the spike. Throughput and latency tiers leave I/O alone
and made no clear difference. **Priority is not the lever**, and the reason fits finding 2: the
compression happens in the kernel on behalf of the booter's page faults, so the person's pages are
compressed however the booter is scheduled.

### 4. Many fewer services at boot shrinks the spike; lean mode's list does not

The simulator reads launchd disable overrides from
`/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>/disabled.plist` at boot. That is the store the
iOS agent's lean mode writes (`packages/ios-agent/src/LeanStore.ts`), and the one simslim writes. Same 8 GB
Mac, two simulators booted 120 s apart, each read over the 120 s from its boot. Three lists, four runs of
lean and of the full list and three of the middle one, in a shuffled order; "none" is a single run. Mean,
then range:

| Overrides | Boot | Person p95 (ms) | Min fps (10 s) | CPU > 90 % (s) | Decompressions (thousands) | Swapouts (thousands) | `memorystatus_level` after |
|---|---|---|---|---|---|---|---|
| none, first boot | 13 | 479 | 9.8 | 34 | 1,395 | 32 | 32 |
| none, second boot | 15 | 386 | 11.6 | 46 | 1,673 | 131 | 30 |
| lean mode's 99, first | 9 (8–10) | 332 (119–612) | 12.9 (8.5–15.3) | 28 (20–37) | 1,236 (398–1,885) | 6 (0–17) | 34 |
| lean mode's 99, second | 16 (11–21) | 362 (228–529) | 10.0 (4.3–13.6) | 36 (26–49) | 1,728 (1,436–2,100) | 82 (59–98) | 30 |
| middle 113, first | 9 (8–10) | 167 (112–265) | 11.8 (7.4–14.9) | 10 (9–12) | 284 (219–332) | 0 | 48 |
| middle 113, second | 9 (9–9) | 373 (284–496) | 11.0 (9.8–13.3) | 17 (15–21) | 1,094 (942–1,210) | 12 (0–27) | 32 |
| simslim's 168, first | 8 (7–9) | 128 (113–150) | 14.0 (12.8–15.3) | 8 (7–9) | 245 (165–329) | 0 | 51 |
| simslim's 168, second | 9 (8–13) | 172 (122–274) | 12.5 (9.5–14.8) | 11 (9–14) | 583 (272–973) | 6 (0–20) | 39 |

The middle list is lean mode's plus the 14 labels lean keeps for Spotlight, suggestions, on-device ML,
widgets and Live Activities (`searchd`, `spotlightknowledged`, `suggestd`, `mlhostd`, `modelmanagerd`,
`chronod`, `liveactivitiesd`, `PosterBoard` and their kin).

- **Lean mode barely changes the boot.** Its ranges cover the unmodified boot on every column, and its worst
  run was worse than the unmodified one. An earlier single run that looked better was the lucky end of
  the range.
- **The full list separates from lean on CPU saturation and decompressions** (7–14 s against 20–49 s, and
  165–973 thousand against 398–2,100 thousand, no overlap on either boot) and on the person's p95 for most
  runs; those ranges touch at one run each. Swapouts overlap on the first boot, where both reach zero.
- **The 14 middle labels carry most of the first boot.** Adding them took the first boot to the full
  list's level on host cost. On the second boot, with memory already fuller, the middle list harmed the
  person as much as lean did. The remaining 55 labels of the full list are what holds the second boot down.

The labels lean mode keeps on purpose (widgets, Spotlight, on-device ML, push, payments) are the
difference, and an app under test can need any of them, which is why lean mode keeps them.

### 5. Android: a cold boot costs less than a simulator's; a snapshot boot is faster, with a catch

The agent starts every emulator with `-no-snapshot`, so every boot is cold
(`packages/android-agent/src/EmulatorLauncher.ts`). On the MacBook a quickboot snapshot of the same AVD
booted in 2.7 s against 11.9 s cold. Saving the snapshot failed with `UNSUPPORTED_VK_APP` until the guest's
Vulkan was turned off (`-feature -Vulkan`) under `-gpu host`, which changes the rendering path of the app
under test. The effect on the person's session could not be read on the 32 GB host: the cold boot never
took the host above 60 % CPU, and the run was mixed with the unexplained dip below.

On the 8 GB Mac, a cold boot with the agent's arguments (`-no-snapshot -gpu host`; the harness also passed `-no-boot-anim`),
API 35, 2 GB guest,
beside the person's iOS session, three runs, read the same way as finding 4:

| | Boot | Person p95 (ms) | Min fps (10 s) | CPU > 90 % (s) | Decompressions (thousands) | Pageins (thousands) | `memorystatus_level` after |
|---|---|---|---|---|---|---|---|
| iOS simulator, no overrides (one run) | 13 | 479 | 9.8 | 34 | 1,395 | 836 | 32 |
| Android emulator, cold | 14–16 | 128–197 | 9.9–14.7 | 8–11 | 1,625–2,620 | 201–383 | 30–33 |

The emulator decompresses as much as an unmodified simulator boot or more, but pages in about a third as
much and saturates the CPU for about a quarter as long, and the person's p95 stays near the full-list
simulator boot. One run in three dipped to 10 fps. Once settled, the person's session was at baseline
(p95 99–135 ms, 15 fps). The emulator leaves memory as full as two simulators do, so a second device
after it would start from the state where finding 4's second boots were measured. That was not run.

## Pitfalls

- **A synchronous `simctl boot` / `bootstatus` in the harness stops the harness.** The sampler and the
  probe share its event loop, so for the length of the boot nothing is sampled and no frame is read. On
  the 8 GB Mac that was 48 s, which looked like the person's stream freezing for 48 s and then stopping.
  It did not reproduce once the boot was awaited asynchronously.
- **`capturedAt` → receive is not a latency measure here.** On one host it read 0–1 ms throughout:
  `capturedAt` is stamped at the encoder's output, so it covers the hop through the relay and nothing
  before it. Input→frame is the number that moves.
- **An unexplained dip on the MacBook.** Some whole windows held at 10–12 fps with input→frame p95 near
  1 s at low host CPU, including a baseline window before any boot. It did not follow load (it cleared
  when another device was added). Until it is explained, treat MacBook numbers from this harness as
  indicative, and prefer the 8 GB host for anything close.
- **A first boot is heavier than later ones.** A simulator's first boot also does one-time indexing
  (CircleCI measured over 300 % CPU for 1–2 minutes). The tables above use devices that had booted
  before. A run whose first boots took 48–92 s was discarded for this and the pitfall above.

## What this rules out, and what it leaves

- **Ruled out: admitting automated work by a memory percentage or by pressure level.** Once devices have
  settled, neither separates a harmed session from an unharmed one (finding 1). During a boot the harm
  follows the boot itself, which a gate can see directly, so a percentage adds nothing there either; this
  was not tested as a threshold. A tighter automated threshold would also refuse most of the day on an
  idle Mac (the relay's per-minute history put the metric above 60 % for 40–62 % of minutes on two Macs).
- **Ruled out: demoting the booting device.** It protects the person by not booting.
- **Left: fewer boots, one at a time, each lighter.** A boot is the cost, so the levers are not overlapping
  boots, not repeating them (keeping finished devices up), and booting with fewer services where the
  session can afford it. On iOS "fewer" has to mean well past lean mode's list to show up.

## Limits

Three or four runs per list and one with no overrides, idle simulators with no app beyond Settings, one
8 GB host, and on 8 GB Android only as a single device beside the person's. The full list was not checked
against the apps it would break. The steady
state was measured up to 4 devices on 8 GB and 9 on 32 GB.

## Related work

- simslim (MIT) — <https://github.com/MobAI-App/simslim>. The 168-label list above is its full profile. It
  reports 258 → 70 processes and 4.0 → 0.9 GB per simulator (phys_footprint, which counts compressed pages),
  and a first boot of 2 min 14 s → 33 s. It keeps `assistantd`, `gamed` and `sharingd` on, with reasons.
- baguette (Apache-2.0) — <https://github.com/tddworks/baguette>. A headless simulator manager; no
  resource mechanism, and its notes say booting many devices at once serialises in framework warm-up.
- CircleCI, "Reducing iOS Simulator CPU overhead on macOS executors" —
  <https://support.circleci.com/hc/en-us/articles/46737392770203-Reducing-iOS-Simulator-CPU-Overhead-on-macOS-Executors>.
  First-boot indexing cost.
- [workshop-lab-fork-observations.md](./workshop-lab-fork-observations.md) — an independent capacity data
  point (about four iOS seats on 32 GB).
