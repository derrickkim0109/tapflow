import type { UIElement } from '@tapflowio/agent-core'
import type { Selector } from './schema.js'

// Selector resolution: explicit id → identifier only; explicit label → exact then partial; bare text →
// exact identifier, then exact label, then partial label. role then narrows by element kind, and index
// (0-based) picks one of the remaining matches — so a label shared by e.g. a button and its inner text
// can be disambiguated with { label, role: button }, and a label-less row with { role: cell, index }.
export function matchSelector(tree: UIElement[], sel: Selector): UIElement[] {
  let pool: UIElement[]
  if (sel.text !== undefined) {
    const byId = tree.filter((e) => e.identifier === sel.text)
    const exact = tree.filter((e) => e.label === sel.text)
    pool = byId.length > 0
      ? byId
      : exact.length > 0
        ? exact
        : tree.filter((e) => sel.text !== undefined && sel.text.length > 0 && e.label.includes(sel.text))
  } else {
    pool = tree
    if (sel.id !== undefined) pool = pool.filter((e) => e.identifier === sel.id)
    if (sel.label !== undefined) {
      const label = sel.label
      const exact = pool.filter((e) => e.label === label)
      pool = exact.length > 0 ? exact : pool.filter((e) => e.label.includes(label))
    }
  }
  if (sel.role !== undefined) pool = pool.filter((e) => e.role === sel.role)
  if (sel.index !== undefined) {
    const el = pool[sel.index]
    return el ? [el] : []
  }
  return pool
}
