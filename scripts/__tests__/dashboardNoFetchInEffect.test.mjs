// The lint that keeps server data out of effects in the dashboard (#845).
//
// **A check whose whole job is an absence passes when it has stopped working** — a config that no
// longer applies to the file, a selector that no longer matches after a refactor of the rule list.
// So this lints planted code through the repo's own config and asserts the rule *fires*, beside the
// twin that must not: the same call outside an effect.
import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')
const eslint = new ESLint({ cwd: root })
// A path the dashboard block applies to; the file need not exist for lintText.
const filePath = join(root, 'packages/dashboard/hooks/__planted__.tsx')

async function flagged(code) {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.line)
}

const header = `import { useEffect, useLayoutEffect, useState } from 'react'\nimport { api } from '@/lib/api'\n`

describe('fetching in an effect fails the dashboard lint', () => {
  it('flags fetch inside useEffect', async () => {
    const code = header + `export function useX() {
  const [v, setV] = useState<unknown>(null)
  useEffect(() => { fetch('/api/v1/x').then((r) => r.json()).then(setV) }, [])
  return v
}\n`
    expect(await flagged(code)).toEqual([5])
  })

  it('flags api.* inside useLayoutEffect', async () => {
    const code = header + `export function useY() {
  const [v, setV] = useState<unknown>(null)
  useLayoutEffect(() => { void api.get('/api/v1/y').then(({ data }) => setV(data)) }, [])
  return v
}\n`
    expect(await flagged(code)).toEqual([5])
  })

  it('flags the React.useEffect form the shadcn primitives use', async () => {
    const code = `import * as React from 'react'\nexport function useZ() {
  const [v, setV] = React.useState<unknown>(null)
  React.useEffect(() => { fetch('/api/v1/z').then((r) => r.json()).then(setV) }, [])
  return v
}\n`
    expect(await flagged(code)).toEqual([4])
  })

  it('leaves the same calls alone outside an effect', async () => {
    // The twin: identical calls in an event handler, which is where a request on a user action lives.
    const code = header + `export function Button() {
  const [v, setV] = useState<unknown>(null)
  const onClick = () => { void fetch('/api/v1/x', { method: 'POST' }); void api.get('/api/v1/y') }
  return <button onClick={onClick}>{String(v)}{String(setV)}</button>
}\n`
    expect(await flagged(code)).toEqual([])
  })
})
