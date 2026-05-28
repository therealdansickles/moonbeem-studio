"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { Title } from "@/lib/queries/titles";
import TitleCard from "./TitleCard";
import { useDragScroll } from "@/hooks/useDragScroll";
import { fadeIn, noMotion, stagger } from "@/lib/motion";

type CarouselTitle = Pick<Title, "id" | "slug" | "title" | "poster_url"> & {
  cpmDisplay?: string | null;
};

type Props = {
  // Section header above the carousel. Omit / empty string to render
  // the carousel without a header (e.g. partner-catalog page where
  // the hero already names the section).
  title?: string;
  titles: CarouselTitle[];
};

export default function TitleCarousel({ title, titles }: Props) {
  const scrollRef = useDragScroll();
  const reduce = useReducedMotion();
  // Opacity-only entrance — does NOT animate translateY. The
  // poster <ViewTransition> inside TitleCard captures the
  // element's painted RECT on click; a translate on an ancestor
  // would shift that rect mid-entrance and start the cross-route
  // morph from the wrong position. Fading only is geometry-safe.
  const cardVariant = reduce ? noMotion : fadeIn;
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

  if (titles.length === 0) return null;

  return (
    <section className="w-full">
      {title && (
        <h2 className="mb-4 px-6 text-caption font-medium uppercase tracking-wider text-moonbeem-pink">
          {title}
        </h2>
      )}

      <div className="relative">
        <motion.div
          ref={scrollRef}
          className="flex select-none snap-x snap-proximity gap-4 overflow-x-auto px-6 pb-2 [scrollbar-width:none] [scroll-behavior:auto] [touch-action:pan-x] [scroll-padding-left:1.5rem] [-webkit-user-drag:none] [&::-webkit-scrollbar]:hidden"
          role="list"
          onDragStart={(e) => e.preventDefault()}
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          {titles.map((t) => (
            <motion.div
              key={t.id}
              role="listitem"
              className="w-[160px] shrink-0 snap-start md:w-[220px] lg:w-[240px]"
              variants={cardVariant}
            >
              <TitleCard title={t} cpmDisplay={t.cpmDisplay ?? null} />
            </motion.div>
          ))}
        </motion.div>

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
