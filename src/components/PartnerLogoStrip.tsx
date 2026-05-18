"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import type { MarqueePartner } from "@/lib/queries/partners";
import { useDragScroll } from "@/hooks/useDragScroll";
import { fadeIn, noMotion, staggerReverse } from "@/lib/motion";

// Logo render height. All partner logos are spec'd as 16:9 (Phase A
// admin upload enforcement, 2026-05-12), so width = height × 16/9 ≈
// 170px per logo at 96px tall — uniform across all six cells.
const LOGO_HEIGHT_PX = 96;

type Props = {
  partners: MarqueePartner[];
};

export default function PartnerLogoStrip({ partners }: Props) {
  const scrollRef = useDragScroll();
  const reduce = useReducedMotion();
  // Opacity-only entrance on the wrapper (0 → 1). The Link inside
  // keeps its Tailwind opacity-[0.85] resting + hover:opacity-100
  // affordance; CSS opacity compounds through nesting, so the
  // visible resting opacity is 1 × 0.85 = 0.85 and hover is
  // 1 × 1.0 = 1.0 — preserving the existing hover punch. No
  // translate: this strip sits above the title carousels which
  // morph on click; a non-moving entrance keeps the hero region
  // geometrically calm.
  const logoVariant = reduce ? noMotion : fadeIn;
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(true);

  // Toggle edge fades based on scroll position, matching the
  // TitleCarousel pattern site-wide. Both fades hidden when the
  // content fits within the viewport (no scroll possible).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const overflow = el.scrollWidth > el.clientWidth + 1;
      setShowLeftFade(overflow && el.scrollLeft > 10);
      setShowRightFade(
        overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      );
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

  if (partners.length === 0) return null;

  return (
    <section
      className="relative w-full"
      aria-label="Distribution partners"
    >
      <motion.div
        ref={scrollRef}
        // gap-4 matches the Featured / Recent Remixes carousels for
        // site-wide consistency. Cursor grab feedback indicates the
        // drag affordance; useDragScroll swaps to grabbing on
        // mousedown.
        className="flex select-none items-center gap-4 overflow-x-auto px-6 py-4 [scrollbar-width:none] [-webkit-user-drag:none] [&::-webkit-scrollbar]:hidden cursor-grab"
        role="list"
        onDragStart={(e) => e.preventDefault()}
        variants={staggerReverse}
        initial="hidden"
        animate="visible"
      >
        {partners.map((p) => (
          // motion.div wraps the Link so framer-motion can drive the
          // entrance opacity without touching the Link's own props.
          // shrink-0 hoists from the Link — the wrapper is now the
          // flex item, so it owns the no-shrink behavior.
          <motion.div
            key={p.slug}
            variants={logoVariant}
            className="shrink-0"
          >
            <Link
              href={`/p/${p.slug}`}
              role="listitem"
              aria-label={p.name}
              // overflow-hidden + rounded-lg on the cell clips each
              // logo's per-asset background (Oscilloscope on black,
              // Topic on white, etc.) into a uniform rounded shape so
              // the strip reads as one consistent surface rather than
              // a row of independent rectangles. Matches the Featured /
              // Recent Remixes card corner treatment.
              className="flex shrink-0 items-center overflow-hidden rounded-lg opacity-[0.85] transition-opacity duration-200 hover:opacity-100"
            >
              {/* Plain <img>: avoids needing to add the R2 host to
                  next.config remotePatterns for every uploaded
                  logo. Browser downscaling from the source PNG is
                  fine at 72px display height. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.logo_url}
                alt={p.name}
                height={LOGO_HEIGHT_PX}
                style={{ height: `${LOGO_HEIGHT_PX}px`, width: "auto" }}
                draggable={false}
              />
            </Link>
          </motion.div>
        ))}
      </motion.div>

      {/* Edge fades — same w-20 (80px) gradient pattern as the
          Featured/Recent Remixes carousels, fading from
          moonbeem-black to transparent. */}
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
    </section>
  );
}
