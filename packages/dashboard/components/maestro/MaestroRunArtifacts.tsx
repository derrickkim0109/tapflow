// the files a `tapflow maestro` run attached — every screenshot
// the Maestro flow took, in order, and Maestro's log. Renders nothing for a run that attached none, which is every
// `tapflow flow run` run.
import { useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'

interface Artifact { name: string; kind: 'image' | 'log'; bytes: number }

const base = (runId: string) => `/api/v1/maestro/runs/${encodeURIComponent(runId)}/artifacts`

async function getArtifacts(runId: string, signal?: AbortSignal): Promise<Artifact[]> {
  const res = await fetch(base(runId), { credentials: 'include', signal })
  // A relay without the route answers with the dashboard's index.html; nothing to show either way.
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) return []
  const body = await res.json() as { items?: Artifact[] }
  return body.items ?? []
}

export function MaestroRunArtifacts({ runId, running }: { runId: string; running: boolean }) {
  const items = useQuery({
    // `running` in the key: the moment the run finishes, the list is read once more — the CLI attaches its last
    // files just before finishing, after the last 3-second look may have passed.
    queryKey: ['maestro', 'run-artifacts', runId, running],
    queryFn: ({ signal }) => getArtifacts(runId, signal),
    refetchInterval: running ? 3000 : false,
  }).data ?? []
  if (items.length === 0) return null
  const images = items.filter((a) => a.kind === 'image')
  const logs = items.filter((a) => a.kind === 'log')
  return (
    <section className="flex flex-col gap-2" aria-label="Maestro output">
      <h2 className="text-sm font-medium">Maestro output</h2>
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-3">
          {images.map((a) => (
            <li key={a.name} className="flex w-40 flex-col gap-1">
              <a href={`${base(runId)}/${encodeURIComponent(a.name)}`} target="_blank" rel="noreferrer" className="block">
                <img src={`${base(runId)}/${encodeURIComponent(a.name)}`} alt={a.name} loading="lazy" className="max-h-72 rounded-md border" />
              </a>
              <span className="truncate text-xs text-muted-foreground" title={a.name}>{a.name}</span>
            </li>
          ))}
        </ul>
      )}
      {logs.map((a) => (
        <a
          key={a.name} href={`${base(runId)}/${encodeURIComponent(a.name)}`} target="_blank" rel="noreferrer"
          className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden />{a.name}
        </a>
      ))}
    </section>
  )
}
