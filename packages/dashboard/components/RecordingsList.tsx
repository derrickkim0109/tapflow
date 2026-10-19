'use client';

import { useQuery } from '@tanstack/react-query';
import { getRecordings, queryKeys } from '@/lib/queries';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Recording } from '@/lib/types';
import { useShownAfter } from '@/hooks/useShownAfter';

interface Props {
  buildId: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatExpiry(iso: string): { label: string; urgent: boolean } {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return { label: 'Expired', urgent: true };
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return { label: '< 1 hour left', urgent: true };
  if (h < 24) return { label: `Expires in ${h}h`, urgent: h < 6 };
  return { label: `Expires in ${Math.floor(h / 24)}d`, urgent: false };
}

export function RecordingsList({ buildId }: Props) {
  // Refreshed by invalidating this key when a recording finishes uploading (QASession).
  const query = useQuery({ queryKey: queryKeys.recordings(buildId), queryFn: () => getRecordings(buildId) });
  const recordings: Recording[] = query.data ?? [];
  const showLoading = useShownAfter(query.isPending, 250, buildId);

  if (query.isPending) {
    return showLoading ? <p className="text-xs text-muted-foreground">Loading recordings…</p> : null;
  }

  // Only a failure with nothing to show. A refresh that fails keeps the rows it had (see `listView`).
  if (query.isError && !query.data) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Couldn&apos;t load recordings.</p>;
  }

  if (recordings.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">No recordings yet.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {recordings.map((rec) => {
        const expiry = formatExpiry(rec.expiresAt);
        return (
          <div
            key={rec.id}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-xs font-medium truncate">{formatDate(rec.createdAt)}</span>
              <span className={`text-xs ${expiry.urgent ? 'text-destructive' : 'text-muted-foreground'}`}>
                {expiry.label} · {formatBytes(rec.fileSize)}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 ml-2"
              title="Download"
              onClick={() => {
                const a = document.createElement('a');
                a.href = rec.url;
                a.download = '';
                a.click();
              }}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
