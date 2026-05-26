"use client";

// Mobile hamburger nav. Below md, the desktop <nav> in TopNav is
// display:none, so this provides the navigation affordance.
//
// Auth handling: TopNav (server) computes the booleans + membership
// list once and passes them in. We deliberately do NOT call
// getCurrentProfile() or any auth helper here — one source of truth
// for "what admin surfaces does this user see" lives in TopNav.
//
// Admin section mirrors the desktop AdminNavDropdown — same row
// composition (Super admin + per-partner rows), same divider when
// both sections are present, same visual weight (Super admin in
// pink, partner rows in ink with muted role tags on the right).
// Flat-listed here instead of nested-in-a-dropdown because a
// dropdown inside a hamburger is awkward; the hamburger is
// already a panel.
//
// Overlay pattern (matches ConsentSettingsModal + AccountMenu +
// FanEditModal conventions): role="dialog" root, click-on-backdrop
// closes via target === currentTarget, ESC closes via document
// keydown listener, body-scroll-lock while open. Inline SVG for
// the hamburger glyph — repo has no icon library.

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PartnerMembership } from "@/lib/dal";

type Props = {
  showForYou: boolean;
  isSuperAdmin: boolean;
  memberships: PartnerMembership[];
};

export default function MobileNavMenu({
  showForYou,
  isSuperAdmin,
  memberships,
}: Props) {
  const showAdminSection = isSuperAdmin || memberships.length > 0;
  const showAdminDivider = isSuperAdmin && memberships.length > 0;
  const [open, setOpen] = useState(false);

  // ESC closes. Listener only attached while open so non-menu
  // ESC presses elsewhere on the page aren't intercepted.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Body-scroll-lock while open. Matches FanEditModal: capture the
  // previous overflow so we restore exactly what was there (handles
  // the case where something else already had the lock).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/10 text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink md:hidden"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          {/* Panel anchored beneath the sticky 64px header so the
              header chrome stays visible (the close affordance is
              the backdrop + ESC). */}
          <div className="absolute inset-x-0 top-16 border-b border-white/10 bg-moonbeem-black/95 backdrop-blur-md shadow-2xl shadow-black/40">
            <nav className="mx-auto flex max-w-5xl flex-col gap-1 px-4 py-4">
              <Link
                href="/browse"
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-3 text-body text-moonbeem-ink-muted hover:bg-white/5 hover:text-moonbeem-ink transition-colors"
              >
                Browse
              </Link>
              {showForYou && (
                <Link
                  href="/for-you"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-3 py-3 text-body text-moonbeem-ink-muted hover:bg-white/5 hover:text-moonbeem-ink transition-colors"
                >
                  For You
                </Link>
              )}
              {showAdminSection && (
                <>
                  {isSuperAdmin && (
                    <Link
                      href="/admin"
                      onClick={() => setOpen(false)}
                      className="rounded-md px-3 py-3 text-body text-moonbeem-pink hover:bg-white/5 hover:opacity-80 transition-opacity"
                    >
                      Super admin
                    </Link>
                  )}
                  {showAdminDivider && (
                    <div className="my-1 border-t border-white/5" />
                  )}
                  {memberships.map((m) => (
                    <Link
                      key={m.partner_id}
                      href={`/p/${m.partner_slug}/dashboard`}
                      onClick={() => setOpen(false)}
                      className="flex items-center justify-between gap-3 rounded-md px-3 py-3 text-body text-moonbeem-ink hover:bg-white/5 transition-colors"
                    >
                      <span className="truncate">
                        {m.partner_name} dashboard
                      </span>
                      <span className="shrink-0 text-caption text-moonbeem-ink-subtle">
                        {m.role}
                      </span>
                    </Link>
                  ))}
                </>
              )}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
