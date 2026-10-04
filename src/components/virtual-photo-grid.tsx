import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { LoaderCircle } from 'lucide-react';
import { api, type Filter, type Photo } from '../lib/api';

const PAGE_SIZE = 48;

/** Keep only visible rows, a small overscan, and their database pages in memory. */
export function VirtualPhotoGrid({
  filter,
  total,
  size,
  scrollRef,
  renderPhoto,
}: {
  filter: Filter;
  total: number;
  size: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  renderPhoto: (photo: Photo, index: number) => ReactNode;
}) {
  const [width, setWidth] = useState(() => scrollRef.current?.clientWidth ?? size);
  useEffect(
    function observeGalleryWidth() {
      const element = scrollRef.current;
      if (!element) return;
      const observer = new ResizeObserver(() => setWidth(element.clientWidth));
      observer.observe(element);
      return () => observer.disconnect();
    },
    [scrollRef],
  );
  const tileWidth = Math.min(size, width);
  const columns = Math.max(1, Math.floor(width / size));
  const rowHeight = tileWidth * 0.75;
  const virtualizer = useVirtualizer({
    count: Math.ceil(total / columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 2,
  });
  useEffect(
    function updateRowSize() {
      virtualizer.measure();
    },
    [virtualizer, rowHeight],
  );
  const rows = virtualizer.getVirtualItems();
  const firstIndex = (rows[0]?.index ?? 0) * columns;
  const lastIndex = Math.min(total - 1, ((rows.at(-1)?.index ?? 0) + 1) * columns - 1);
  const firstPage = Math.floor(firstIndex / PAGE_SIZE);
  const pageNumbers = Array.from(
    { length: Math.floor(lastIndex / PAGE_SIZE) - firstPage + 1 },
    (_, index) => firstPage + index,
  );
  const pages = useQueries({
    queries: pageNumbers.map((page) => ({
      queryKey: ['photos', { ...filter, page }],
      queryFn: () => api.search({ ...filter, page }),
      staleTime: Infinity,
      gcTime: 0,
    })),
  });
  return (
    <div
      aria-label="Image grid"
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {rows.map((row) => (
        <div
          key={row.key}
          className="absolute left-0 top-0 grid"
          style={{
            transform: `translateY(${row.start}px)`,
            height: rowHeight,
            gridTemplateColumns: `repeat(${columns}, ${tileWidth}px)`,
          }}
        >
          {Array.from({ length: Math.min(columns, total - row.index * columns) }, (_, column) => {
            const index = row.index * columns + column;
            const page = pages[Math.floor(index / PAGE_SIZE) - firstPage];
            const photo = page?.data?.images[index % PAGE_SIZE];
            return photo ? (
              renderPhoto(photo, index)
            ) : (
              <div
                key={`pending-${index}`}
                className="flex aspect-[4/3] flex-col items-center justify-center gap-3 border border-background bg-muted p-3 text-muted-foreground"
              >
                {page?.isError ? (
                  <button className="underline" onClick={() => void page.refetch()}>
                    Could not load images. Retry
                  </button>
                ) : (
                  <>
                    <LoaderCircle aria-hidden className="size-6 motion-safe:animate-spin" />
                    <span>Loading images…</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
