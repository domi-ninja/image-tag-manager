import { api } from './api';

const MAX_ACTIVE = 4;
let active = 0;
const pending: Array<() => void> = [];

/** Limit native decoding work and discard queued requests as their tiles leave the viewport. */
export function loadThumbnail(id: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    function cancel() {
      const index = pending.indexOf(start);
      if (index !== -1) pending.splice(index, 1);
      reject(new DOMException('Thumbnail no longer visible', 'AbortError'));
    }
    function start() {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) {
        cancel();
        return;
      }
      active++;
      void api
        .thumbnail(id)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pending.shift()?.();
        });
    }
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    if (active < MAX_ACTIVE) start();
    else pending.push(start);
  });
}
