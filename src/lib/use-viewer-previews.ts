import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api, type Filter, type Photo } from './api';
import { loadPreview, prioritizePreview } from './preview-loader';

/** A sliding window of 21 decoded previews, released on navigation or viewer close. */
export function useViewerPreviews(
  current: { photo: Photo; index: number },
  filter: Filter,
  total: number,
) {
  const start = Math.max(0, current.index - 10);
  const end = Math.min(total - 1, current.index + 10);
  const firstPage = Math.floor(start / 48);
  const pages = useQueries({
    queries: Array.from({ length: Math.floor(end / 48) - firstPage + 1 }, (_, offset) => {
      const page = firstPage + offset;
      return {
        queryKey: ['photos', { ...filter, page }],
        queryFn: () => api.search({ ...filter, page }),
        staleTime: Infinity,
        gcTime: 0,
      };
    }),
  });
  function photoAt(index: number) {
    return pages[Math.floor(index / 48) - firstPage]?.data?.images[index % 48];
  }
  const neighbors = Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => {
    const index = start + offset;
    return { index, photo: index === current.index ? current.photo : photoAt(index) };
  })
    .filter((item): item is { index: number; photo: Photo } => Boolean(item.photo))
    .sort((a, b) => Math.abs(a.index - current.index) - Math.abs(b.index - current.index));
  const previews = useQueries({
    queries: neighbors.map(({ photo }) => ({
      queryKey: ['preview', photo.id, photo.modified],
      queryFn: ({ signal }: { signal: AbortSignal }) => loadPreview(photo.id, signal),
      staleTime: Infinity,
      gcTime: 0,
    })),
  });
  useEffect(
    function prioritizeCurrentPreview() {
      prioritizePreview(current.photo.id);
    },
    [current.photo.id],
  );
  const preview = previews[neighbors.findIndex(({ photo }) => photo.id === current.photo.id)];
  const ready = preview?.data;
  const [previous, setPrevious] = useState<{ src: string; photo: Photo }>();
  useEffect(
    function retainLastVisiblePreview() {
      if (ready) setPrevious({ src: ready.src, photo: current.photo });
    },
    [ready, current.photo],
  );
  return {
    photoAt,
    displayed: ready ? { src: ready.src, photo: current.photo } : previous,
    loading: !ready && !preview?.isError,
    failed: preview?.isError ?? false,
  };
}
