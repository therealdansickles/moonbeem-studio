"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { FanEditWithTitle } from "@/lib/queries/titles";
import FanEditCard from "./FanEditCard";
import { useDragScroll } from "@/hooks/useDragScroll";
import { fadeInUp, noMotion, stagger } from "@/lib/motion";

type Props = {
  title: string;
  fanEdits: FanEditWithTitle[];
};

export default function FanEditCarousel({ title, fanEdits }: Props) {
  const scrollRef = useDragScroll();
  const reduce = useReducedMotion();
  // Reduced-motion users get an instant render via noMotion; the
  // stagger parent variant is harmless either way (it only
  // sequences children — with noMotion children there is nothing
  // to visually sequence).
  const cardVariant = reduce ? noMotion : fadeInUp;
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
      <h2 className="mb-4 px-6 text-caption font-medium uppercase tracking-wider text-moonbeem-pink">
        {title}
      </h2>

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
          {fanEdits.map((fe, idx) => (
            <motion.div
              key={fe.id}
              role="listitem"
              className="w-[200px] shrink-0 snap-start md:w-[260px] lg:w-[280px]"
              variants={cardVariant}
            >
              <FanEditCard
                fanEdit={fe}
                siblings={fanEdits}
                siblingIndex={idx}
              />
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
