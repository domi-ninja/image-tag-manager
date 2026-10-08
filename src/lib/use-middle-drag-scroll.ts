import { useEffect, type RefObject } from 'react';

/** Scroll continuously while the middle mouse button is held over the gallery. */
export function useMiddleDragScroll(scrollRef: RefObject<HTMLDivElement | null>) {
  useEffect(
    function enableMiddleDragScroll() {
      const element = scrollRef.current;
      if (!element) return;
      const gallery = element;

      let drag: { pointerId: number; startY: number; currentY: number; lastFrame: number } | null =
        null;
      let frame = 0;
      let previousCursor = '';
      let previousUserSelect = '';

      function stop() {
        if (!drag) return;
        const pointerId = drag.pointerId;
        drag = null;
        cancelAnimationFrame(frame);
        gallery.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        if (gallery.hasPointerCapture(pointerId)) gallery.releasePointerCapture(pointerId);
      }

      function scroll(time: number) {
        if (!drag) return;
        const distance = drag.currentY - drag.startY;
        const speed =
          Math.sign(distance) * Math.min(2400, Math.max(0, Math.abs(distance) - 12) * 10);
        if (drag.lastFrame)
          gallery.scrollTop += (speed * Math.min(time - drag.lastFrame, 64)) / 1000;
        drag.lastFrame = time;
        frame = requestAnimationFrame(scroll);
      }

      function onPointerDown(event: PointerEvent) {
        if (event.pointerType !== 'mouse' || event.button !== 1 || drag) return;
        event.preventDefault();
        previousCursor = gallery.style.cursor;
        previousUserSelect = document.body.style.userSelect;
        gallery.style.cursor = 'all-scroll';
        document.body.style.userSelect = 'none';
        drag = {
          pointerId: event.pointerId,
          startY: event.clientY,
          currentY: event.clientY,
          lastFrame: 0,
        };
        gallery.setPointerCapture(event.pointerId);
        frame = requestAnimationFrame(scroll);
      }

      function onPointerMove(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!(event.buttons & 4)) {
          stop();
          return;
        }
        drag.currentY = event.clientY;
      }

      function onPointerEnd(event: PointerEvent) {
        if (event.pointerId === drag?.pointerId) stop();
      }

      function onAuxClick(event: MouseEvent) {
        if (event.button === 1) event.preventDefault();
      }

      gallery.addEventListener('pointerdown', onPointerDown);
      gallery.addEventListener('pointermove', onPointerMove);
      gallery.addEventListener('pointerup', onPointerEnd);
      gallery.addEventListener('pointercancel', onPointerEnd);
      gallery.addEventListener('lostpointercapture', onPointerEnd);
      gallery.addEventListener('auxclick', onAuxClick);
      window.addEventListener('blur', stop);
      return () => {
        stop();
        gallery.removeEventListener('pointerdown', onPointerDown);
        gallery.removeEventListener('pointermove', onPointerMove);
        gallery.removeEventListener('pointerup', onPointerEnd);
        gallery.removeEventListener('pointercancel', onPointerEnd);
        gallery.removeEventListener('lostpointercapture', onPointerEnd);
        gallery.removeEventListener('auxclick', onAuxClick);
        window.removeEventListener('blur', stop);
      };
    },
    [scrollRef],
  );
}
