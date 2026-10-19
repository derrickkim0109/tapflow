/**
 * Which roles see each restricted settings page, read by both the sidebar and the route guard so the two
 * cannot disagree. A page not listed here is open to every signed-in member.
 *
 * Tokens is open to the roles that upload builds: Developer and QA need a CI token of their own, and
 * until this they had to borrow an Admin's, so the token belonged to the wrong person. The relay already
 * let any member create an API token; the `agent` scope stays Admin-only there. Viewer is read-only, and
 * a token of theirs could only view.
 */
const RESTRICTED: Record<string, readonly string[]> = {
  '/settings/team': ['Admin'],
  '/settings/tokens': ['Admin', 'Developer', 'QA'],
}

export function maySeeSettingsPage(path: string, role: string | undefined): boolean {
  const entry = Object.entries(RESTRICTED).find(([prefix]) => path.startsWith(prefix))
  return !entry || (role !== undefined && entry[1].includes(role))
}
