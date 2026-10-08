import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { LoaderCircle } from 'lucide-react';
import { Button } from './ui/button';

type UpdateStatus = {
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'current'
    | 'error'
    | 'unsupported';
  version: string;
  downloaded: number;
  total: number | null;
  error: string | null;
};
export function AppUpdates() {
  const client = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const status = useQuery({
    queryKey: ['update-status'],
    queryFn: () => invoke<UpdateStatus>('update_status'),
    refetchInterval: 1000,
  });
  const action = useMutation({
    mutationFn: (command: 'check_update' | 'download_update') => invoke(command),
    onSettled: () => client.invalidateQueries({ queryKey: ['update-status'] }),
  });
  const update = status.data;
  const busy = action.isPending || update?.phase === 'checking' || update?.phase === 'downloading';
  const check = () => {
    setDismissed(false);
    action.mutate('check_update');
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!dismissed && update?.phase === 'available' && (
        <>
          <span role="status">Version {update.version} available</span>
          <Button disabled={busy} onClick={() => action.mutate('download_update')}>
            Download update
          </Button>
          <Button variant="ghost" onClick={() => setDismissed(true)}>
            Later
          </Button>
        </>
      )}
      {update?.phase === 'downloading' && (
        <span role="status" className="flex items-center gap-2">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          Downloading update{' '}
          {update.total
            ? `${Math.round((update.downloaded / update.total) * 100)}%`
            : `${Math.round(update.downloaded / 1048576)} MB`}
        </span>
      )}
      {update?.phase === 'ready' && <span role="status">Update ready · applies next launch</span>}
      {!dismissed && update?.phase === 'error' && (
        <span
          role="alert"
          className="max-w-80 truncate text-destructive"
          title={update.error ?? undefined}
        >
          {update.error}
        </span>
      )}
      {update?.phase === 'current' && <span role="status">Up to date</span>}
      {update?.phase !== 'ready' &&
        update?.phase !== 'downloading' &&
        update?.phase !== 'unsupported' && (
          <Button variant="ghost" disabled={busy} onClick={check}>
            {busy ? 'Checking…' : 'Check for updates'}
          </Button>
        )}
    </div>
  );
}
