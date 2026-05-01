"use client";

import { useEffect, useState } from "react";
import type { FanEditWithTitle } from "@/lib/queries/titles";
import FanEditCard from "./FanEditCard";
import { useDragScroll } from "@/hooks/useDragScroll";

type Props = {
  title: string;
  fanEdits: FanEditWithTitle[];
};

export default function FanEditCarousel({ title, fanEdits }: Props) {
  const scrollRef = useDragScroll();
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setShowLeftFade(el.scrollLeft > 10);
      setShowRightFade(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollRef]);

  if (fanEdits.length === 0) return null;

  return (
    <section className="w-full">
      <h2 className="mb-4 px-6 text-caption font-medium uppercase tracking-wider text-moonbeem-lime">
        {title}
      </h2>

      <div className="relative">
        <div
          ref={scrollRef}
          className="flex select-none snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-2 [scrollbar-width:none] [-webkit-user-drag:none] [&::-webkit-scrollbar]:hidden"
          role="list"
          onDragStart={(e) => e.preventDefault()}
        >
          {fanEdits.map((fe) => (
            <div
              key={fe.id}
              role="listitem"
              className="w-[200px] shrink-0 snap-start md:w-[260px] lg:w-[280px]"
            >
              <FanEditCard fanEdit={fe} />
            </div>
          ))}
        </div>

        <div
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-20 bg-gradient-to-r from-moonbeem-black to-transparent transition-opacity duration-200 ${
            showLeftFade ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-20 bg-gradient-to-l from-moonbeem-black to-transparent transition-opacity duration-200 ${
            showRightFade ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>
    </section>
  );
}
