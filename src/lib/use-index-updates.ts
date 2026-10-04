import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Status } from './api';

/** Refresh indexed data when the native worker reports progress, including its final image. */
export function useIndexUpdates(status: Status | undefined) {
  const client = useQueryClient();
  const revision = status?.revision;
  const phase = status?.phase;
  useEffect(
    function refreshAfterWorkerProgress() {
      if (revision === undefined || phase === 'download') return;
      void client.invalidateQueries({
        predicate: (query) =>
          ['folders', 'stats', 'photos', 'tags'].includes(String(query.queryKey[0])),
      });
    },
    [client, revision, phase],
  );
}
