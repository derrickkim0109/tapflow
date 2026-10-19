/** Which view a table's body is showing — named once, so `useFocusAfterSwap` and the render agree. */
export type ListView = 'loading' | 'error' | 'empty' | 'list'

/**
 * Rows once there are any, else what stands in for them. **Rows held from before a failed refresh
 * still count as the list**: a table that blanks on one missed answer reports an outage that did not
 * happen. Only a failure with nothing to show is the error view.
 */
export function listView(query: { data: readonly unknown[] | undefined; isError: boolean }): ListView {
  if (query.data) return query.data.length > 0 ? 'list' : 'empty'
  return query.isError ? 'error' : 'loading'
}
