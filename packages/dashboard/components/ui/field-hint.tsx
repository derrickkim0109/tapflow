import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A standing instruction under a field — present before anything is typed, unlike `FieldError`, which
 *  takes its place on a refusal. Same size as the error so the swap does not change the line. */
export function FieldHint({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return <p id={id} className={cn('text-sm text-muted-foreground', className)}>{children}</p>
}
