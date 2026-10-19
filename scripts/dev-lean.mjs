// `pnpm dev` with Lean mode on for both agents. A Node wrapper rather than `TAPFLOW_LEAN=on pnpm dev`:
// that is POSIX shell syntax, and this repo is developed on Windows too (see CONTRIBUTING).
import { spawnSync } from 'node:child_process'

// One command string with `shell: true`, so Windows finds `pnpm.cmd`; an argument array alongside a
// shell is deprecated in Node (DEP0190).
const run = spawnSync('pnpm dev', { stdio: 'inherit', shell: true, env: { ...process.env, TAPFLOW_LEAN: 'on' } })
process.exit(run.status ?? 1)
