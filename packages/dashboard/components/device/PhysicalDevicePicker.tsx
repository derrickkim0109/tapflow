import { useState } from 'react'
import { Usb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { holderKindLabel } from '@/lib/aiSession'
import { shownName } from '@/lib/deviceGroups'
import { minutesLeft } from '@/lib/resumeEntry'
import type { DeviceSummary, SessionInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

const PHONES: Record<string, string> = { ios: 'iPhones', android: 'Android phones' }
const PHONE: Record<string, string> = { ios: 'iPhone', android: 'Android phone' }
const SETUP_DOCS: Record<string, string> = {
  ios: 'https://www.tapflow.dev/operate/usb-iphone',
  android: 'https://www.tapflow.dev/operate/android-usb-devices',
}

interface Props {
  /** Every Mac's listing. A phone belongs to the Mac it is plugged into, and the tester picks the phone, not the Mac. */
  sessions: SessionInfo[]
  /** The build's platform: an iOS build is offered iPhones and iPads, an Android build Android phones. */
  os: string
  /** Nothing can be opened while another device is booting or the relay is away. */
  disabled: boolean
  /** The phone picked, with the Mac it is on. The page decides what a pick means — start, resume or take over — as it
   *  does for a simulator's card. */
  onPick: (agentName: string, device: DeviceSummary, opener: HTMLElement) => void
}

/**
 * **Connect Physical Device** (#152): the phones plugged into any Mac, apart from the Macs' simulators and emulators.
 * A phone runs nothing on the Mac it is plugged into, so which Mac is a detail of the pick rather than a choice made
 * first — and a Mac over its load still opens for its phones, which the relay never holds to that load.
 */
export function PhysicalDevicePicker({ sessions, os, disabled, onPick }: Props) {
  const [open, setOpen] = useState(false)
  // Hidden is for simulators an Admin set aside; a phone on the desk is either plugged in or not listed at all.
  // A Mac is picked by its name, so one that reports none cannot be opened from here either.
  const phones = sessions.flatMap(({ agentName, devices }) => agentName === undefined ? [] : devices
    .filter((d) => d.platform === os && d.kind === 'physical' && !d.hidden)
    .map((d) => ({ agentName, device: d })))
  const kind = PHONES[os] ?? 'Phones'

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Usb aria-hidden />
          Connect Physical Device
        </Button>
      </DialogTrigger>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Connect Physical Device</DialogTitle>
          <DialogDescription>{kind} plugged into a Mac by USB. Pick one to open a session on it.</DialogDescription>
        </DialogHeader>
        {phones.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No {PHONE[os] ?? 'phone'} is connected. Plug one into a Mac running the agent, unlock it and
            trust the Mac.{' '}
            {SETUP_DOCS[os] && (
              <a href={SETUP_DOCS[os]} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                How to set one up
              </a>
            )}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={`Connected ${kind}`}>
            {phones.map(({ agentName, device: d }) => {
              const yours = d.waiting?.yours === true
              const othersWait = d.waiting && !yours ? d.waiting : null
              const status = d.busy
                ? (d.holder ? `${holderKindLabel(d.holder.kind)} is driving it` : 'In use')
                : yours ? 'Your session is waiting for you'
                : othersWait ? `Waiting for ${othersWait.name} to return${othersWait.remainingMs !== undefined ? ` · about ${minutesLeft(othersWait.remainingMs)} min` : ''}`
                : 'Connected'
              return (
                <li key={`${agentName}:${d.id}`}>
                  <button
                    type="button"
                    disabled={d.busy || disabled}
                    onClick={(e) => { setOpen(false); onPick(agentName, d, e.currentTarget) }}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors',
                      'hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium leading-tight">{shownName(d)}</span>
                      <span className="text-xs text-muted-foreground">
                        {d.osVersion ? `${d.osVersion} · ` : ''}on {agentName}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={cn('inline-block h-1.5 w-1.5 rounded-full', d.busy || d.waiting ? 'bg-amber-400' : 'bg-emerald-400')} />
                      {status}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
