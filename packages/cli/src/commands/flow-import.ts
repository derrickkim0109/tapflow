import fs from 'fs'
import path from 'path'
import {
  convertMaestroFlow,
  isMaestroFlowFile,
  isEnvName,
  flowToYaml,
  parseFlow,
  type ImportedFlow,
  type ImportReport,
} from '@tapflowio/flow-runner'
import { BOLD, DIM, GREEN, R, RED, YELLOW } from '../lib/print.js'

export interface FlowImportOptions {
  /** The source format. Only `maestro` today. */
  from?: string
  /** Where converted flows go. Defaults to `.tapflow/flows`, where `flow run`'s examples read them from. */
  out?: string
  /** `KEY=VALUE`, repeatable. cac hands one occurrence as a string and several as an array. */
  env?: string | string[]
  /** Write the JSON report here. */
  report?: string
  overwrite?: boolean
}

const FORMATS = ['maestro'] as const
export const DEFAULT_IMPORT_OUT = '.tapflow/flows'

// 0 = every flow converted · 1 = at least one was not, and its report says why · 2 = nothing could be read or written.
const EXIT_NOT_CONVERTED = 1
const EXIT_USAGE = 2

/**
 * `tapflow flow import --from maestro` (#1094). Each source flow either becomes a whole tapflow flow, or writes
 * nothing and is listed with every command that kept it out — never a partial flow that could pass without the
 * assertions it lost. What a flow could not keep is said in one report format that names no tool, so a later
 * source (or an agent filling the gaps) reads the same thing.
 */
export async function cmdFlowImport(inputs: string[], opts: FlowImportOptions): Promise<number> {
  if (opts.from === undefined || !(FORMATS as readonly string[]).includes(opts.from)) {
    console.error(`flow import needs --from <format> (supported: ${FORMATS.join(', ')})`)
    return EXIT_USAGE
  }
  if (inputs.length === 0) {
    console.error('flow import needs at least one Maestro flow file or directory')
    return EXIT_USAGE
  }

  let env: Record<string, string>
  let files: string[]
  let base: string
  try {
    env = parseEnvPairs(opts.env)
    ;({ files, base } = collectFlowFiles(inputs))
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`)
    return EXIT_USAGE
  }
  if (files.length === 0) {
    console.error('✗ no Maestro flow files found (a directory contributes the .yaml files directly in it, not config.yaml)')
    return EXIT_USAGE
  }

  const outDir = path.resolve(opts.out ?? DEFAULT_IMPORT_OUT)
  const outputOf = (file: string): string => path.join(outDir, path.relative(base, file))
  // `--overwrite` exists for re-importing, which an output landing on its own source would turn into deleting it.
  const onSource = files.filter((f) => outputOf(f) === f)
  if (onSource.length > 0) {
    console.error(`✗ --out ${display(outDir)} would replace the Maestro flows themselves (${onSource.map(display).join(', ')}) — write to another directory`)
    return EXIT_USAGE
  }
  const results = files.map((file) => ({ result: convertMaestroFlow(file, { env }), output: outputOf(file) }))

  // Every flow is serialized and read back before the first file is written. A flow that does not read back is
  // reported like any other that did not convert, rather than costing the others their output.
  const written: Written[] = []
  for (const { result, output } of results) {
    if (result.status !== 'converted') {
      written.push({ result, ...(fs.existsSync(output) ? { stale: output } : {}) })
      continue
    }
    const yaml = flowToYaml(result.flow, `Converted from ${display(result.source)} by \`tapflow flow import --from ${opts.from}\`.`)
    try {
      // What is written is what `flow run` will read, so it is read back the way `flow run` reads it.
      parseFlow(yaml, output)
      written.push({ result, output, yaml })
    } catch (e) {
      const issue = { file: result.source, command: '(output)', kind: 'unconverted' as const, reason: `the converted flow does not read back: ${(e as Error).message}` }
      written.push({ result: { source: result.source, status: 'not-converted', issues: [...result.issues, issue] }, ...(fs.existsSync(output) ? { stale: output } : {}) })
    }
  }
  // Every collision is named before anything is written: a converted flow is likely to have been edited since.
  // Checked after the read-back, so a flow that did not read back is reported, not counted as a collision.
  if (!opts.overwrite) {
    const taken = written.filter((w) => w.output !== undefined && fs.existsSync(w.output)).map((w) => display(w.output!))
    if (taken.length > 0) {
      console.error(`✗ ${taken.length === 1 ? 'this file exists' : 'these files exist'} — pass --overwrite to replace, or --out to write elsewhere:`)
      for (const t of taken) console.error(`    ${t}`)
      return EXIT_USAGE
    }
  }
  // A write that fails part way leaves the files before it; the error names the one that failed.
  const done: string[] = []
  try {
    for (const { output, yaml } of written) {
      if (output === undefined || yaml === undefined) continue
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, yaml)
      done.push(display(output))
    }
  } catch (e) {
    console.error(`✗ ${(e as Error).message}${done.length > 0 ? ` (already written: ${done.join(', ')})` : ''}`)
    return EXIT_USAGE
  }

  printResults(written)

  if (opts.report !== undefined) {
    const report: ImportReport = {
      format: 'tapflow-import-report',
      version: 1,
      from: opts.from,
      flows: written.map(({ result, output, stale }) => ({
        source: display(result.source),
        status: result.status,
        ...(output !== undefined ? { output: display(output) } : {}),
        ...(stale !== undefined ? { staleOutput: display(stale) } : {}),
        issues: result.issues.map((i) => ({ ...i, file: display(i.file) })),
      })),
    }
    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.report)), { recursive: true })
      fs.writeFileSync(opts.report, JSON.stringify(report, null, 2) + '\n')
      console.log(`${DIM}report: ${opts.report}${R}`)
    } catch (e) {
      console.error(`✗ cannot write the report: ${(e as Error).message}`)
      return EXIT_USAGE
    }
  }

  return written.some((w) => w.result.status !== 'converted') ? EXIT_NOT_CONVERTED : 0
}

/**
 * `stale` is a file an earlier import wrote for a flow that no longer converts. It is left in place — no tapflow
 * command deletes what a person may have edited — but named, because `flow run` would keep replaying it.
 */
interface Written { result: ImportedFlow; output?: string; yaml?: string; stale?: string }

function printResults(written: Written[]): void {
  for (const { result, output, stale } of written) {
    if (output !== undefined) {
      console.log(`${GREEN}✓${R} ${display(result.source)} ${DIM}→${R} ${display(output)}`)
    } else {
      console.log(`${RED}✗${R} ${display(result.source)} ${DIM}— not converted, nothing written${R}`)
      if (stale !== undefined) {
        console.log(`    ${YELLOW}stale${R} ${display(stale)} is from an earlier import and does not reflect this source — \`flow run\` still replays it`)
      }
    }
    for (const issue of result.issues) {
      const where = `${display(issue.file)}${issue.line !== undefined ? `:${issue.line}` : ''}`
      const color = issue.kind === 'unconverted' ? RED : YELLOW
      console.log(`    ${color}${issue.kind}${R} ${where} ${BOLD}${issue.command}${R} — ${issue.reason}`)
    }
  }
  const converted = written.filter((w) => w.output !== undefined).length
  const notConverted = written.length - converted
  console.log()
  console.log(`${converted} converted, ${notConverted} not converted`)
}

function display(p: string): string {
  const rel = path.relative(process.cwd(), p)
  return rel === '' || rel.startsWith('..') ? p : rel
}

function parseEnvPairs(env: string | string[] | undefined): Record<string, string> {
  const pairs = env === undefined ? [] : Array.isArray(env) ? env : [env]
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = String(pair).indexOf('=')
    const key = eq > 0 ? String(pair).slice(0, eq) : ''
    if (!isEnvName(key)) throw new Error(`--env takes KEY=VALUE (got "${String(pair)}")`)
    out[key] = String(pair).slice(eq + 1)
  }
  return out
}

/**
 * The files a list of inputs names, and the directory their output paths are kept relative to. A directory
 * contributes the flows directly in it, as Maestro runs a directory: subfolders are where subflows live, and
 * `runFlow` inlines those.
 */
function collectFlowFiles(inputs: string[]): { files: string[]; base: string } {
  const files: string[] = []
  const dirs: string[] = []
  for (const input of inputs) {
    const abs = path.resolve(input)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new Error(`${input}: no such file or directory`)
    }
    if (stat.isDirectory()) {
      dirs.push(abs)
      for (const name of fs.readdirSync(abs).sort()) {
        if (isMaestroFlowFile(name) && fs.statSync(path.join(abs, name)).isFile()) files.push(path.join(abs, name))
      }
    } else {
      dirs.push(path.dirname(abs))
      files.push(abs)
    }
  }
  return { files: [...new Set(files)], base: commonDir(dirs) }
}

function commonDir(dirs: string[]): string {
  return dirs.reduce((acc, d) => {
    let cur = acc
    while (cur !== d && !d.startsWith(cur.endsWith(path.sep) ? cur : cur + path.sep)) {
      const parent = path.dirname(cur)
      // A root is its own parent: inputs on two Windows drives share no directory to keep paths relative to.
      if (parent === cur) throw new Error(`the inputs share no directory (${acc} and ${d}) — import them separately`)
      cur = parent
    }
    return cur
  })
}
