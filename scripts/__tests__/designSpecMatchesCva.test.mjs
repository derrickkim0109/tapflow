import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// A component spec in `packages/dashboard/design/components/` is what an outside designer builds the
// Figma file from, and it is a hand copy of a `cva` definition. Hand copies drift: before this check
// existed, DESIGN.md's Button size table had already lost `icon-sm` while three call sites used it.
//
// So each spec names its source in frontmatter (`source`, `cva`), and every axis of that `cva` must
// appear as a `### \`axis\`` heading whose table lists exactly the same values. An axis that is not in
// `cva` (`state` is CSS, not a prop) must be declared in `own:` — otherwise an axis deleted from code would
// stay documented, green. A component whose source has no `cva` with variants for it says `cva: none`, and
// every axis it has is its own. `none` cannot opt a real cva out: it fails when the component's own cva
// (`Button` → `buttonVariants`) has variants, or when an `own:` axis is defined by any cva in that source.
//
// Reading nothing must fail, not pass. A `cva` name that no longer exists, or a refactor that moves the
// variants somewhere this cannot see, would otherwise compare an empty set to whatever the spec says
// about an axis it then never looks at — green, and checking nothing. That holds per axis and per value
// too: an axis pulled out into a shared constant, or written `as const`, is a thrown error, not a skipped one.

const root = join(import.meta.dirname, '../..')
const dashboard = join(root, 'packages/dashboard')
const specDir = join(dashboard, 'design/components')

const isCvaCall = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'cva'
const nameOf = (n) => (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : null)

/** `{ axis: [values] }` from `const <cvaName> = cva(base, { variants: { … } })`. Throws if not found. */
export function cvaAxes(sourceText, cvaName) {
  const sf = ts.createSourceFile('x.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found = null
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && nameOf(n.name) === cvaName && n.initializer && isCvaCall(n.initializer)) {
      const config = n.initializer.arguments[1]
      if (config && ts.isObjectLiteralExpression(config)) {
        const variants = config.properties.find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === 'variants')
        if (variants && ts.isObjectLiteralExpression(variants.initializer)) {
          found = {}
          for (const axis of variants.initializer.properties) {
            const axisName = ts.isPropertyAssignment(axis) ? nameOf(axis.name) : null
            if (!axisName || !ts.isObjectLiteralExpression(axis.initializer)) {
              throw new Error(`\`${cvaName}\`: a variants entry is not a literal axis this can read (${axis.getText()})`)
            }
            found[axisName] = axis.initializer.properties.map((v) => {
              const value = ts.isPropertyAssignment(v) ? nameOf(v.name) : null
              if (!value) throw new Error(`\`${cvaName}\`.${axisName}: a value is not a literal key (${v.getText()})`)
              return value
            })
          }
        }
      }
    }
    if (!found) ts.forEachChild(n, visit)
  }
  visit(sf)
  if (!found || Object.keys(found).length === 0 || Object.values(found).some((v) => v.length === 0)) {
    throw new Error(`no cva variants found for \`${cvaName}\` — it must be assigned a \`cva(base, { variants })\` call`)
  }
  return found
}

/**
 * Every `const <name> = cva(…)` in the source that has a `variants` entry, as name → its axis names
 * (readable or not — an unreadable entry still means the cva has variants).
 */
export function cvaWithVariants(sourceText) {
  const found = new Map()
  const visit = (n) => {
    const config = ts.isVariableDeclaration(n) && n.initializer && isCvaCall(n.initializer) && n.initializer.arguments[1]
    const variants = config && ts.isObjectLiteralExpression(config) &&
      config.properties.find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === 'variants')
    if (variants) {
      const axes = ts.isObjectLiteralExpression(variants.initializer)
        ? variants.initializer.properties.map((a) => (a.name ? nameOf(a.name) : null)).filter(Boolean) : []
      found.set(nameOf(n.name), new Set(axes))
    }
    ts.forEachChild(n, visit)
  }
  visit(ts.createSourceFile('x.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX))
  return found
}

/** The cva a component owns, by the shadcn convention: `Button` → `buttonVariants`. */
export const ownedCvaName = (component) => `${component[0].toLowerCase()}${component.slice(1)}Variants`

/**
 * Why a `cva: none` spec is wrong, or null. `none` is for a component with no cva of its own — not a way
 * to opt a real one out. So it fails when the component's own cva has variants, or when an `own:` axis is
 * defined by any cva in the file. A cva-less component sharing a file with another's cva stays valid.
 */
export function noneViolation(sourceText, component, ownAxes) {
  const all = cvaWithVariants(sourceText)
  const owned = ownedCvaName(component)
  if (all.has(owned)) return `\`cva: none\` but \`${owned}\` has variants — name it in \`cva:\``
  const real = ownAxes.filter((a) => [...all.values()].some((axes) => axes.has(a)))
  return real.length ? `\`cva: none\` but a cva in the source defines ${real.join(', ')}` : null
}

/** `{ axis: [values] }` from each `### \`axis\`` heading and the first column of the table below it. */
export function specAxes(markdown) {
  const axes = {}
  let current = null
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const heading = /^###\s+`([^`]+)`\s*$/.exec(line)
    if (heading) {
      current = heading[1]
      if (axes[current]) throw new Error(`axis \`${current}\` has two sections`)
      axes[current] = []
      continue
    }
    if (/^#{1,6}\s/.test(line)) { current = null; continue }
    const cell = current && /^\|\s*`([^`]+)`\s*\|/.exec(line)
    if (cell) axes[current].push(cell[1])
  }
  return axes
}

export function frontmatter(markdown) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(markdown)
  if (!m) return {}
  return Object.fromEntries(m[1].split('\n').map((l) => l.split(/:\s*/, 2)).filter((kv) => kv.length === 2))
}

/** Differences between code and spec, as readable lines. Empty means they agree. */
export function drift(code, spec, own = []) {
  const out = []
  for (const axis of Object.keys(spec)) {
    if (!(axis in code) && !own.includes(axis)) out.push(`axis \`${axis}\` is in the spec, not in code, and not declared in \`own:\``)
  }
  for (const [axis, values] of Object.entries(code)) {
    const written = spec[axis]
    if (!written) { out.push(`axis \`${axis}\` has no "### \`${axis}\`" section`); continue }
    for (const v of values) if (!written.includes(v)) out.push(`${axis}: \`${v}\` is in code, missing from the spec`)
    for (const v of written) if (!values.includes(v)) out.push(`${axis}: \`${v}\` is in the spec, not in code`)
  }
  return out
}

const specs = readdirSync(specDir, { recursive: true }).filter((f) => f.endsWith('.md'))

describe('component specs match the cva they name', () => {
  it('finds at least one spec', () => expect(specs.length).toBeGreaterThan(0))

  for (const file of specs) {
    it(file, () => {
      const md = readFileSync(join(specDir, file), 'utf8')
      const { component, source, cva, own = '' } = frontmatter(md)
      expect(component, `${file}: frontmatter needs \`component\``).toBeTruthy()
      expect(source, `${file}: frontmatter needs \`source\``).toBeTruthy()
      expect(cva, `${file}: frontmatter needs \`cva\` (or \`cva: none\`)`).toBeTruthy()
      const text = readFileSync(join(dashboard, source), 'utf8')
      const ownAxes = own.split(/[\s,]+/).filter(Boolean)
      if (cva === 'none') expect(noneViolation(text, component, ownAxes), file).toBeNull()
      const code = cva === 'none' ? {} : cvaAxes(text, cva)
      expect(drift(code, specAxes(md), ownAxes)).toEqual([])
    })
  }
})

describe('DESIGN.md links every spec, and every link resolves', () => {
  const design = readFileSync(join(dashboard, 'DESIGN.md'), 'utf8')
  const linked = [...design.matchAll(/\]\((?:\.\/)?design\/components\/([\w/-]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1])

  it('links at least one spec', () => expect(linked.length).toBeGreaterThan(0))
  for (const f of linked) it(`${f} exists`, () => expect(existsSync(join(specDir, f))).toBe(true))
  for (const f of specs) it(`${f} is linked`, () => expect(linked).toContain(f))
})

// The parsers above decide what "agree" means, so they are held to cases where the answer is known.
describe('the check itself', () => {
  const source = `const v = cva('b', { variants: { size: { sm: '', 'icon-sm': '' }, tone: { a: '' } } })`

  it('reads identifier and string-literal keys', () => {
    expect(cvaAxes(source, 'v')).toEqual({ size: ['sm', 'icon-sm'], tone: ['a'] })
  })
  it('throws on a cva name that is not there, instead of comparing nothing', () => {
    expect(() => cvaAxes(source, 'gone')).toThrow(/no cva variants/)
  })
  it('throws when the variants are not a literal it can read', () => {
    expect(() => cvaAxes(`const v = cva('b', { variants: shared })`, 'v')).toThrow(/no cva variants/)
  })
  it('throws on one unreadable axis or value, instead of dropping it', () => {
    expect(() => cvaAxes(`const v = cva('b', { variants: { a: { x: '' }, size: sizes } })`, 'v')).toThrow(/not a literal axis/)
    expect(() => cvaAxes(`const v = cva('b', { variants: { size: { x: '' } as const } })`, 'v')).toThrow(/not a literal axis/)
    expect(() => cvaAxes(`const v = cva('b', { variants: { a: { x: '' }, ...shared } })`, 'v')).toThrow(/not a literal axis/)
    expect(() => cvaAxes(`const v = cva('b', { variants: { size: { x: '', [K.y]: '' } } })`, 'v')).toThrow(/not a literal key/)
  })
  it('reports an axis only the spec has unless it is declared own', () => {
    const spec = specAxes('### `size`\n| `sm` |\n| `icon-sm` |\n### `tone`\n| `a` |\n### `state`\n| `hover` |\n')
    expect(drift(cvaAxes(source, 'v'), spec)).toEqual(['axis `state` is in the spec, not in code, and not declared in `own:`'])
    expect(drift(cvaAxes(source, 'v'), spec, ['state'])).toEqual([])
  })
  it('does not take a different factory for cva', () => {
    expect(() => cvaAxes(`const v = tv('b', { variants: { size: { sm: '' } } })`, 'v')).toThrow(/no cva variants/)
  })
  it('refuses `cva: none` for a component whose own cva has variants, even with no `own:` axis', () => {
    const button = `const buttonVariants = cva('b', { variants: { variant: { default: '' }, size: { sm: '' } } })`
    expect(noneViolation(button, 'Button', ['state'])).toMatch(/buttonVariants/)
    const card = `const cardVariants = cva('b', { variants: { level: { 1: '', 2: '' } } })\nconst l = cva('x')`
    expect(noneViolation(card, 'Label', ['level'])).toMatch(/defines level/)
  })
  it('allows `cva: none` for a cva-less component sharing a file with another cva', () => {
    const sidebar = `const sidebarMenuButtonVariants = cva('b', { variants: { size: { sm: '' } } })`
    expect(noneViolation(sidebar, 'SidebarGroup', [])).toBeNull()
    expect(noneViolation(`const labelVariants = cva('x')`, 'Label', ['hint'])).toBeNull()
  })
  it('rejects a second section for one axis, and ignores fenced and deeper-heading tables', () => {
    expect(() => specAxes('### `size`\n| `sm` |\n### `size`\n| `xl` |\n')).toThrow(/two sections/)
    expect(specAxes('### `size`\n| `sm` |\n```\n| `fenced` |\n```\n#### Note\n| `deeper` |\n')).toEqual({ size: ['sm'] })
  })
  it('reports a value missing from the spec, one the code lacks, and an absent axis', () => {
    const spec = specAxes('### `size`\n\n| Value |\n|---|\n| `sm` |\n| `xl` |\n\n## Usage\n| `ignored` |\n')
    expect(drift(cvaAxes(source, 'v'), spec)).toEqual([
      'size: `icon-sm` is in code, missing from the spec',
      'size: `xl` is in the spec, not in code',
      'axis `tone` has no "### `tone`" section',
    ])
  })
})
