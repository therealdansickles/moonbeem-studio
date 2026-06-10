"use client";

// Phase 1A — star rating primitive. No external library; raw SVG + the
// @theme color tokens from globals.css. Two modes:
//   StarRatingDisplay — read-only, half-star fill rendering.
//   StarRatingInput   — hover preview + click-to-set, half-step on the left
//                       half of a star; keyboard accessible (role="slider").
//
// Star fill color is moonbeem-violet (one line, FILL_COLOR, to change later
// per the ruling); empty stars are moonbeem-ink-subtle.

import { useRef, useState } from "react";

// One-line accent swap point.
const FILL_COLOR = "var(--color-moonbeem-violet)";
const EMPTY_COLOR = "var(--color-moonbeem-ink-subtle)";

// Material star path in a 24x24 viewBox.
const STAR_PATH =
  "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";

function Star({ fill, size }: { fill: number; size: number }) {
  const pct = Math.max(0, Math.min(1, fill)) * 100;
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className="absolute inset-0"
      >
        <path d={STAR_PATH} fill={EMPTY_COLOR} />
      </svg>
      <span
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${pct}%` }}
      >
        <svg viewBox="0 0 24 24" width={size} height={size}>
          <path d={STAR_PATH} fill={FILL_COLOR} />
        </svg>
      </span>
    </span>
  );
}

export function StarRatingDisplay({
  value,
  size = 18,
}: {
  value: number;
  size?: number;
}) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={`${value.toFixed(1)} out of 5 stars`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <Star key={i} fill={value - i} size={size} />
      ))}
    </span>
  );
}

export function StarRatingInput({
  value,
  onChange,
  size = 28,
  disabled = false,
}: {
  value: number | null;
  onChange: (value: number) => void;
  size?: number;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;

  function valueFromClientX(clientX: number): number {
    const el = ref.current;
    if (!el) return 0.5;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const star = Math.floor(x / size); // 0..4
    const within = x - star * size;
    const half = within < size / 2 ? 0.5 : 1;
    return Math.min(5, Math.max(0.5, star + half));
  }

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Your rating"
      aria-valuemin={0.5}
      aria-valuemax={5}
      aria-valuenow={value ?? undefined}
      aria-valuetext={value ? `${value.toFixed(1)} stars` : "not rated"}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      className="inline-flex cursor-pointer items-center gap-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-violet aria-disabled:cursor-default aria-disabled:opacity-60"
      onMouseMove={(e) => {
        if (!disabled) setHover(valueFromClientX(e.clientX));
      }}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        if (!disabled) onChange(valueFromClientX(e.clientX));
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") {
          e.preventDefault();
          onChange(Math.min(5, (value ?? 0) + 0.5));
        } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
          e.preventDefault();
          onChange(Math.max(0.5, (value ?? 1) - 0.5));
        } else if (e.key === "Home") {
          e.preventDefault();
          onChange(0.5);
        } else if (e.key === "End") {
          e.preventDefault();
          onChange(5);
        }
      }}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <Star key={i} fill={shown - i} size={size} />
      ))}
    </div>
  );
}
