"use client";

// Unified top-bar "Admin" dropdown. Replaces the previous standalone
// super-admin "Admin" link AND the PartnersNavDropdown (slice 2).
// One nav entry for every admin/membership combination — super_admin
// only, partner only, both, or none.
//
// Caller (TopNav) decides whether to mount this at all: render only
// when `isSuperAdmin || memberships.length > 0`. If neither
// condition holds, the component has nothing useful to show.
//
// Section order in the panel: Super admin row first (if applicable),
// then a hairline divider when both sections present, then one
// partner-dashboard row per membership in order received.
//
// Click-outside-to-close + ESC-to-close, same as AccountMenu. Always
// a dropdown — even for a single entry — so the visual shape is
// consistent across role combinations.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PartnerMembership } from "@/lib/dal";

type Props = {
  isSuperAdmin: boolean;
  memberships: PartnerMembership[];
};

export default function AdminNavDropdown({
  isSuperAdmin,
  memberships,
}: Props) {
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

  const showDivider = isSuperAdmin && memberships.length > 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-body-sm text-moonbeem-pink hover:opacity-80 transition-opacity"
      >
        Admin ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-64 rounded-xl bg-moonbeem-black/95 backdrop-blur-md border border-white/10 shadow-2xl shadow-black/50 py-2 z-30"
        >
          {isSuperAdmin && (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-body-sm text-moonbeem-pink hover:bg-white/5 transition-colors"
            >
              Super admin
            </Link>
          )}
          {showDivider && <div className="my-1 border-t border-white/5" />}
          {memberships.map((m) => (
            <Link
              key={m.partner_id}
              href={`/p/${m.partner_slug}/dashboard`}
              onClick={() => setOpen(false)}
              className="flex items-center justify-between gap-3 px-4 py-2 text-body-sm text-moonbeem-ink hover:bg-white/5 transition-colors"
            >
              <span className="truncate">{m.partner_name} dashboard</span>
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
