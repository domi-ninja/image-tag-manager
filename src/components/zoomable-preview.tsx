import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Minus, Plus } from 'lucide-react';
import type { Photo } from '../lib/api';
import { Button } from './ui/button';
import { PhotoContextMenu } from './photo-context-menu';

type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };
const MAX_ZOOM = 8;

export function ZoomablePreview({
  photoId,
  displayed,
  loading,
  failed,
  onError,
}: {
  photoId: number;
  displayed?: { src: string; photo: Photo };
  loading: boolean;
  failed: boolean;
  onError: (error: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [view, setView] = useState(FIT);
  const [dragging, setDragging] = useState(false);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  useEffect(function measurePreviewViewport() {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setBounds({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = imageSize.width
    ? Math.min(bounds.width / imageSize.width, bounds.height / imageSize.height)
    : 1;
  function constrain(next: View): View {
    const maxX = Math.max(0, (imageSize.width * fit * next.scale - bounds.width) / 2);
    const maxY = Math.max(0, (imageSize.height * fit * next.scale - bounds.height) / 2);
    return {
      scale: next.scale,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }
  const shown = constrain(view);
  function zoom(factor: number, x = 0, y = 0) {
    setView((previous) => {
      const old = constrain(previous);
      const scale = Math.max(1, Math.min(MAX_ZOOM, old.scale * factor));
      return constrain({
        scale,
        x: x - ((x - old.x) * scale) / old.scale,
        y: y - ((y - old.y) * scale) / old.scale,
      });
    });
  }
  useEffect(
    function zoomWithWheel() {
      const element = viewport.current;
      if (!element || !displayed) return;
      function onWheel(event: WheelEvent) {
        event.preventDefault();
        if ((event.target as HTMLElement).closest('[data-zoom-controls]')) return;
        const rect = element!.getBoundingClientRect();
        const delta =
          event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
        zoom(
          Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002),
          event.clientX - rect.left - rect.width / 2,
          event.clientY - rect.top - rect.height / 2,
        );
      }
      element.addEventListener('wheel', onWheel, { passive: false });
      return () => element.removeEventListener('wheel', onWheel);
    },
    [displayed, bounds.width, bounds.height, imageSize.width, imageSize.height],
  );
  return (
    <PhotoContextMenu photoId={photoId} onError={onError}>
      <div
        ref={viewport}
        aria-label="Image preview"
        aria-busy={loading}
        tabIndex={0}
        className="relative grid min-h-0 min-w-0 touch-none select-none place-items-center overflow-hidden bg-muted"
        style={{ cursor: shown.scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in' }}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('[data-zoom-controls]')) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (shown.scale > 1) setView(FIT);
          else
            zoom(
              2,
              event.clientX - rect.left - rect.width / 2,
              event.clientY - rect.top - rect.height / 2,
            );
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (
            event.shiftKey &&
            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
          ) {
            event.preventDefault();
            event.stopPropagation();
            const dx = event.key === 'ArrowLeft' ? 60 : event.key === 'ArrowRight' ? -60 : 0;
            const dy = event.key === 'ArrowUp' ? 60 : event.key === 'ArrowDown' ? -60 : 0;
            setView((current) => {
              const old = constrain(current);
              return constrain({ ...old, x: old.x + dx, y: old.y + dy });
            });
          }
          if (['+', '=', '-', '0'].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === '0') setView(FIT);
            else zoom(event.key === '-' ? 1 / 1.25 : 1.25);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('[data-zoom-controls]'))
            return;
          event.currentTarget.focus();
          if (shown.scale <= 1) return;
          event.preventDefault();
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const previous = drag.current;
          if (!previous || previous.id !== event.pointerId) return;
          const dx = event.clientX - previous.x;
          const dy = event.clientY - previous.y;
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          setView((current) => {
            const old = constrain(current);
            return constrain({ ...old, x: old.x + dx, y: old.y + dy });
          });
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        {displayed && (
          <img
            src={displayed.src}
            alt={displayed.photo.caption || displayed.photo.filename}
            draggable={false}
            onLoad={(event) => {
              setImageSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
              setView(FIT);
            }}
            className="block size-full object-contain"
            style={{ transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.scale})` }}
          />
        )}
        {loading && (
          <div
            role="status"
            aria-label="Loading preview"
            className="pointer-events-none absolute inset-0 grid place-items-center bg-black/10"
          >
            <span className="rounded-full bg-background/90 p-3 shadow">
              <LoaderCircle aria-hidden className="size-6 motion-safe:animate-spin" />
            </span>
          </div>
        )}
        {failed && (
          <p role="alert" className="absolute top-4 rounded bg-background/95 p-3">
            Image could not be opened. It may have moved.
          </p>
        )}
        {displayed && (
          <div
            data-zoom-controls
            role="group"
            aria-label="Image zoom"
            className="absolute bottom-3 flex items-center gap-2 rounded-md border bg-background/95 p-1 shadow"
          >
            <Button
              variant="ghost"
              aria-label="Zoom out"
              disabled={shown.scale <= 1}
              onClick={() => zoom(1 / 1.25)}
            >
              <Minus aria-hidden />
            </Button>
            <span className="min-w-12 text-center tabular-nums" aria-label="Zoom level">
              {Math.round(shown.scale * 100)}%
            </span>
            <Button
              variant="ghost"
              aria-label="Zoom in"
              disabled={shown.scale >= MAX_ZOOM}
              onClick={() => zoom(1.25)}
            >
              <Plus aria-hidden />
            </Button>
            <Button variant="ghost" onClick={() => setView(FIT)} title="Fit image (0)">
              Fit
            </Button>
          </div>
        )}
      </div>
    </PhotoContextMenu>
  );
}
