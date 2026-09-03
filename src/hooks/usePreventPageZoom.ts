import { useEffect, type RefObject } from "react";

/**
 * Prevents page zoom (pinch + double-tap) inside the given element.
 *
 * The game UI must not zoom: a zoomed-in page makes the board grow past the
 * phone screen. Android Chrome honors `maximum-scale=1` in the viewport meta,
 * but iOS Safari ignores it, so we also block the zoom gestures in JS:
 *   - `gesturestart`        → Safari's pinch gesture
 *   - `touchstart`/`touchmove` (2+ touches) → pinch on all mobile Safari
 *   - `dblclick`            → double-tap zoom
 *   - `wheel` with ctrlKey  → trackpad pinch (incl. Chrome DevTools touch emulation)
 */
export function usePreventPageZoom(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onGesture = (e: Event) => e.preventDefault();
    const onMultiTouch = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const onDblClick = (e: Event) => e.preventDefault();
    el.addEventListener("gesturestart", onGesture);
    el.addEventListener("touchstart", onMultiTouch, { passive: false });
    el.addEventListener("touchmove", onMultiTouch, { passive: false });
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("dblclick", onDblClick);
    return () => {
      el.removeEventListener("gesturestart", onGesture);
      el.removeEventListener("touchstart", onMultiTouch);
      el.removeEventListener("touchmove", onMultiTouch);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("dblclick", onDblClick);
    };
  }, [ref]);
}
