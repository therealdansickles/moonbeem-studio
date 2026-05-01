import { useEffect, useRef } from "react";

const DRAG_THRESHOLD = 5;

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

    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("mouseleave", endDrag);
    el.addEventListener("mouseup", endDrag);
    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("click", onClickCapture, true);

    el.style.cursor = "grab";

    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("mouseleave", endDrag);
      el.removeEventListener("mouseup", endDrag);
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  return ref;
}
