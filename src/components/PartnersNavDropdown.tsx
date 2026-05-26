"use client";

// Top-bar dropdown for users who are members of two or more partner
// teams. Single-membership users see a plain link inline in TopNav
// instead — this component is only mounted when memberships.length
// >= 2. Click-outside-to-close, ESC-to-close. Same visual treatment
// as AccountMenu's panel for visual coherence on the right side of
// the header.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PartnerMembership } from "@/lib/dal";

type Props = { memberships: PartnerMembership[] };

export default function PartnersNavDropdown({ memberships }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-ink transition-colors"
      >
        Your partners ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-64 rounded-xl bg-moonbeem-black/95 backdrop-blur-md border border-white/10 shadow-2xl shadow-black/50 py-2 z-30"
        >
          <p className="px-4 pb-2 text-caption text-moonbeem-ink-subtle border-b border-white/5">
            Your partners
          </p>
          {memberships.map((m) => (
            <Link
              key={m.partner_id}
              href={`/p/${m.partner_slug}/dashboard`}
              onClick={() => setOpen(false)}
              className="flex items-center justify-between gap-3 px-4 py-2 text-body-sm text-moonbeem-ink hover:bg-white/5 transition-colors"
            >
              <span className="truncate">{m.partner_name}</span>
              <span className="shrink-0 text-caption text-moonbeem-ink-subtle">
                {m.role}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
