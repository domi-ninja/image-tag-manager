import { api } from './api';

type Job = { id: number; start: () => void };
const pending: Job[] = [];
let active = 0;

export function prioritizePreview(id: number) {
  const index = pending.findIndex((job) => job.id === id);
  if (index > 0) pending.unshift(...pending.splice(index, 1));
}

/** Decode before exposing a preview; retain the image while its cache entry is observed. */
export function loadPreview(id: number, signal: AbortSignal) {
  return new Promise<{ src: string; image: HTMLImageElement }>((resolve, reject) => {
    const job: Job = { id, start };
    function cancel() {
      const index = pending.indexOf(job);
      if (index !== -1) pending.splice(index, 1);
      reject(new DOMException('Preview outside preload window', 'AbortError'));
    }
    async function start() {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) {
        cancel();
        return;
      }
      active++;
      try {
        const src = await api.preview(id);
        signal.throwIfAborted();
        const image = new Image();
        image.src = src;
        await image.decode();
        signal.throwIfAborted();
        resolve({ src, image });
      } catch (error) {
        reject(error);
      } finally {
        active--;
        pending.shift()?.start();
      }
    }
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    if (active < 2) void start();
    else pending.push(job);
  });
}
