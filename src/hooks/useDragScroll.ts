import { useEffect, useRef } from "react";

const DRAG_THRESHOLD = 5;
// 1:1 mapping from wheel deltaY → horizontal scrollLeft. Trackpad
// users with smooth-scroll deltas naturally produce small values
// (feels weighted); standard wheel mice produce ~100/click which
// advances roughly half a card per click. Both feel right.
const WHEEL_SCALE = 1.0;

export function useDragScroll() {
  const ref = useRef<HTMLDivElement>(null);
  // Refs (not state) so the capture-phase click handler always reads the
  // live value — state would lag a render behind the mouseup→click sequence.
  const isDraggingRef = useRef(false);
  const hasDraggedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startX = 0;
    let scrollLeft = 0;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      isDraggingRef.current = true;
      hasDraggedRef.current = false;
      startX = e.pageX - el.offsetLeft;
      scrollLeft = el.scrollLeft;
      // Disable snap during drag so the carousel doesn't fight the cursor.
      el.style.scrollSnapType = "none";
      el.style.cursor = "grabbing";
    };

    const endDrag = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      // Restore snap (clearing the inline style reverts to the class-defined value).
      el.style.scrollSnapType = "";
      el.style.cursor = "grab";
      // Clear hasDragged after the click event has had a chance to fire,
      // so the click-capture handler can still see the drag.
      window.setTimeout(() => {
        hasDraggedRef.current = false;
      }, 0);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const x = e.pageX - el.offsetLeft;
      const walk = x - startX;
      if (Math.abs(walk) > DRAG_THRESHOLD) {
        hasDraggedRef.current = true;
      }
      if (hasDraggedRef.current) {
        e.preventDefault();
        el.scrollLeft = scrollLeft - walk;
      }
    };

    const onClickCapture = (e: MouseEvent) => {
      if (hasDraggedRef.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Translate vertical wheel into horizontal scroll for wheel-mouse
    // users (trackpad horizontal pan is already handled natively by
    // overflow-x-auto, so we explicitly defer to it via the
    // |deltaY| > |deltaX| check).
    //
    // shift+wheel is a power-user idiom for horizontal scrolling and
    // many users have muscle memory for it — we pass that through
    // untouched so the native shift+wheel behavior is preserved.
    //
    // Scroll-chaining: when the carousel is at an edge in the wheel
    // direction, release the event so the page can vertical-scroll
    // past the section. Without this, users get stuck on a carousel
    // section that's tall enough to fill the viewport.
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const atStart = el.scrollLeft <= 0;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      if (e.deltaY > 0 && atEnd) return;
      if (e.deltaY < 0 && atStart) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY * WHEEL_SCALE;
    };

    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("mouseleave", endDrag);
    el.addEventListener("mouseup", endDrag);
    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("click", onClickCapture, true);
    // passive: false required so preventDefault() actually suppresses
    // the page's vertical scroll.
    el.addEventListener("wheel", onWheel, { passive: false });

    el.style.cursor = "grab";

    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("mouseleave", endDrag);
      el.removeEventListener("mouseup", endDrag);
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("click", onClickCapture, true);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  return ref;
}
