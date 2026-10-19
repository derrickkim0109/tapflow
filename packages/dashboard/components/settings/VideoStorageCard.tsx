import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldHint } from '@/components/ui/field-hint'
import { FormErrorCount } from '@/components/ui/form-error-count'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { queryKeys } from '@/lib/queries'
import type { WorkspaceSettings } from '@/lib/types'

const GB = 1024 * 1024 * 1024
/** The sliders' range. The relay accepts 0–365 days and 100 MB–10 TB; a value set outside these (by the API) widens
 *  the slider to reach it rather than being clamped on the next save. */
// A passed flow's video is evidence it passed, rarely opened after a sprint; a busy team (50 runs × 4 flows a day)
// uses ~3 GB a day, so two weeks fits under the top of the cap's range. The defaults (3 days, 20 GB) sit near a fifth.
const MAX_DAYS = 14
const MIN_CAP_GB = 1
const MAX_CAP_GB = 100

const schema = z.object({
  retentionDays: z.number().int().min(0).max(365),
  capGb: z.number().int().min(MIN_CAP_GB).max(10240),
})
type FormData = z.infer<typeof schema>

/** GB, or MB below one — a fresh install's few megabytes would otherwise read as "0.0 GB". */
function formatGb(bytes: number): string {
  if (bytes < GB) return `${Math.round(bytes / (1024 * 1024))} MB`
  const gb = bytes / GB
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`
}

/**
 * How long flow run videos are kept and how much room they may take (A4) — Admin only, like the workspace.
 * Failed flows' videos are kept as long as their run; only passed ones have a window. The bar measures use against
 * the limit in effect: the smaller of the setting and what the disk can give while keeping its floor free.
 */
export function VideoStorageCard({ settings }: { settings: WorkspaceSettings }) {
  const queryClient = useQueryClient()
  const savedDays = settings.video_pass_retention_days ?? 3
  const savedCapGb = Math.max(MIN_CAP_GB, Math.round((settings.video_storage_cap_mb ?? 20480) / 1024))
  const form = useForm<FormData>({
    shouldFocusError: false, // FormErrorCount focuses, once the field is described (#824)
    resolver: zodResolver(schema),
    values: { retentionDays: savedDays, capGb: savedCapGb },
    resetOptions: { keepDirtyValues: true },
  })

  async function onSave(data: FormData) {
    // Only what was moved: the cap is shown in whole GB, and sending it back unmoved would round a value set in MB
    // through the API (1500 MB → 1024 MB) on a save that only changed the days.
    const dirty = form.formState.dirtyFields
    if (!dirty.retentionDays && !dirty.capGb) return
    const body = new FormData()
    if (dirty.retentionDays) body.append('video_pass_retention_days', String(data.retentionDays))
    if (dirty.capGb) body.append('video_storage_cap_mb', String(data.capGb * 1024))
    const sentDays = dirty.retentionDays === true
    const sentCap = dirty.capGb === true
    try {
      const res = await fetch('/api/v1/settings', { method: 'PATCH', credentials: 'include', body })
      if (!res.ok) { toast.error('Failed to update video storage'); return }
      // Saved, so no longer changed: `keepDirtyValues` keeps a field dirty through the refetch, and a later save of the
      // other field would send this one again — over a value another Admin may have set since. A field moved again
      // while the request was out stays dirty.
      if (sentDays && form.getValues('retentionDays') === data.retentionDays) form.resetField('retentionDays', { defaultValue: data.retentionDays })
      if (sentCap && form.getValues('capGb') === data.capGb) form.resetField('capGb', { defaultValue: data.capGb })
      toast.success('Video storage updated')
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings })
    } catch {
      toast.error('Failed to update video storage')
    }
  }

  // A relay older than flow videos has none of these fields: nothing to configure there.
  if (settings.video_storage_cap_mb === undefined) return null
  const capBytes = settings.video_storage_cap_mb * 1024 * 1024
  const effective = settings.video_effective_cap_bytes ?? capBytes
  const usage = settings.video_usage_bytes ?? 0
  const usedPct = effective > 0 ? Math.min(100, (usage / effective) * 100) : 0

  return (
    <Card>
      <CardHeader><CardTitle>Flow run videos</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSave)} className="flex flex-col gap-6">
          <div className="grid gap-2">
            <Progress value={usedPct} aria-label="Storage used by videos" aria-valuetext={`${formatGb(usage)} of ${formatGb(effective)}`} />
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{formatGb(usage)}</span> of {formatGb(effective)} used
              {effective < capBytes && ' — the disk has less room than the limit below, so that is the limit in effect'}
            </p>
          </div>
          <Controller
            name="retentionDays"
            control={form.control}
            render={({ field }) => (
              <div className="grid gap-3">
                <div className="flex items-baseline justify-between">
                  <Label id="video-retention-label">Keep passed flows&apos; videos for</Label>
                  <span className="text-sm tabular-nums">{field.value === 1 ? '1 day' : `${field.value} days`}</span>
                </div>
                <Slider
                  min={0}
                  max={Math.max(MAX_DAYS, savedDays)}
                  step={1}
                  value={[field.value]}
                  onValueChange={([v]) => field.onChange(v)}
                  aria-labelledby="video-retention-label"
                  aria-describedby="video-retention-hint"
                />
                <FieldHint id="video-retention-hint">A failed flow&apos;s video is kept as long as its run, unless storage runs out.</FieldHint>
              </div>
            )}
          />
          <Controller
            name="capGb"
            control={form.control}
            render={({ field }) => (
              <div className="grid gap-3">
                <div className="flex items-baseline justify-between">
                  <Label id="video-cap-label">Storage for videos</Label>
                  {/* The saved value as it is until the slider moves: a cap set in MB (100 MB) read as the slider's
                      whole GB would show ten times the policy. */}
                  <span className="text-sm tabular-nums">{form.formState.dirtyFields.capGb ? `${field.value} GB` : formatGb(capBytes)}</span>
                </div>
                <Slider
                  min={MIN_CAP_GB}
                  max={Math.max(MAX_CAP_GB, savedCapGb)}
                  step={1}
                  value={[field.value]}
                  onValueChange={([v]) => field.onChange(v)}
                  aria-labelledby="video-cap-label"
                  aria-describedby="video-cap-hint"
                />
                <FieldHint id="video-cap-hint">When full, the oldest passed flows&apos; videos go first.</FieldHint>
              </div>
            )}
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
          <FormErrorCount errors={form.formState.errors} submitCount={form.formState.submitCount} />
        </form>
      </CardContent>
    </Card>
  )
}
