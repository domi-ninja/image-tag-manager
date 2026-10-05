import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_SIZE = 160;
const MAX_SIZE = 640;
const DEFAULT_SIZE = 320;
const STEP = 40;
const STORAGE_KEY = 'image-tag-manager.thumbnail-size';
const LEGACY_STORAGE_KEY = 'image-shelf.thumbnail-size';
const clamp = (value: number) => Math.max(MIN_SIZE, Math.min(MAX_SIZE, value));

export function useThumbnailSize(enabled: boolean) {
  const galleryRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
      const value = saved === null ? DEFAULT_SIZE : Number(saved);
      return Number.isFinite(value) ? clamp(value) : DEFAULT_SIZE;
    } catch {
      return DEFAULT_SIZE;
    }
  });
  const resize = useCallback((direction: number) => {
    setSize((current) => clamp(current + direction * STEP));
  }, []);

  useEffect(
    function persistThumbnailSize() {
      try {
        localStorage.setItem(STORAGE_KEY, String(size));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        /* Resizing still works when local storage is unavailable. */
      }
    },
    [size],
  );

  useEffect(
    function listenForThumbnailShortcuts() {
      if (!enabled) return;
      const gallery = galleryRef.current;
      let wheelDelta = 0;
      function onWheel(event: WheelEvent) {
        if (!event.ctrlKey || event.altKey || event.metaKey || !event.deltaY) return;
        event.preventDefault();
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1);
        if (Math.sign(delta) !== Math.sign(wheelDelta)) wheelDelta = 0;
        wheelDelta += delta;
        // Accumulate small touchpad movements; one mouse-wheel tick changes one step.
        if (Math.abs(wheelDelta) >= 40) {
          resize(wheelDelta < 0 ? 1 : -1);
          wheelDelta = 0;
        }
      }
      function onKeyDown(event: KeyboardEvent) {
        if (
          !event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.isComposing ||
          event.defaultPrevented
        )
          return;
        if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
          event.preventDefault();
          resize(1);
        } else if (event.key === '-' || event.code === 'NumpadSubtract') {
          event.preventDefault();
          resize(-1);
        }
      }
      gallery?.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('keydown', onKeyDown, { capture: true });
      return () => {
        gallery?.removeEventListener('wheel', onWheel);
        window.removeEventListener('keydown', onKeyDown, { capture: true });
      };
    },
    [enabled, resize],
  );

  return { size, resize, galleryRef, canShrink: size > MIN_SIZE, canGrow: size < MAX_SIZE };
}
