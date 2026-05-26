// /admin/homepage — hub for every homepage curation surface. Two
// distinct functions on one page:
//
//   1. SECTION ORDER (slice D, top of the page) — drag-to-reorder
//      the vertical layout of the five carousels. Saves immediately
//      via POST /api/admin/homepage/sections/reorder.
//
//   2. PER-SECTION CURATION (slices A/B/C/featured/marquee, below)
//      — entry-point cards that link to each section's own curator
//      (/admin/marquee, /admin/featured, /admin/recent-edits,
//      /admin/all-films, /admin/trending-edits).

import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { getHomepageSectionOrder } from "@/lib/homepage-sections";
import HomepageSectionsReorder from "./HomepageSectionsReorder";

export const metadata: Metadata = {
  title: "Homepage curation · Moonbeem admin",
  robots: { index: false, follow: false },
};

type CuratorEntry = {
  href: string | null;
  label: string;
  description: string;
  status: "live" | "coming-soon";
};

const ENTRIES: CuratorEntry[] = [
  {
    href: "/admin/marquee",
    label: "Marquee partners",
    description: "Distribution partner logo strip at the top of the homepage.",
    status: "live",
  },
  {
    href: "/admin/featured",
    label: "Featured Films",
    description: "Editorial-pick title carousel below the partner strip.",
    status: "live",
  },
  {
    href: "/admin/recent-edits",
    label: "Recent Edits",
    description: "Per-fan_edit pin + hide overrides on the recency carousel.",
    status: "live",
  },
  {
    href: "/admin/all-films",
    label: "All Films",
    description: "Per-title pin + hide overrides on the comprehensive catalog carousel.",
    status: "live",
  },
  {
    href: "/admin/trending-edits",
    label: "Trending Edits",
    description:
      "Per-fan_edit pin + hide overrides layered onto the 24h-delta algorithm. Pin bypasses snapshot-coverage.",
    status: "live",
  },
];

export default async function AdminHomepagePage() {
  await requireSuperAdminOr404();
  const initialOrder = await getHomepageSectionOrder();
  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Homepage curation
          </h1>
          <Link
            href="/admin"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Back to admin
          </Link>
        </div>
        <p className="text-body text-moonbeem-ink-muted m-0">
          Curate every section of the homepage from one place. Reorder
          the section layout above; click into a section card below to
          curate its contents (pins float to the top of that section;
          hidden items drop out of that section only).
        </p>
        <HomepageSectionsReorder initialOrder={initialOrder} />
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-display-sm m-0">Section contents</h2>
            <p className="m-0 text-body-sm text-moonbeem-ink-muted">
              Per-section pin and hide controls.
            </p>
          </div>
        </div>
        <ul className="flex flex-col gap-3">
          {ENTRIES.map((e) =>
            e.href ? (
              <li key={e.label}>
                <Link
                  href={e.href}
                  className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition-colors hover:border-moonbeem-pink"
                >
                  <div className="min-w-0">
                    <div className="text-body font-medium text-moonbeem-ink">
                      {e.label}
                    </div>
                    <p className="m-0 mt-1 text-body-sm text-moonbeem-ink-muted">
                      {e.description}
                    </p>
                  </div>
                  <span className="shrink-0 text-body-sm text-moonbeem-pink">
                    Curate →
                  </span>
                </Link>
              </li>
            ) : (
              <li
                key={e.label}
                aria-disabled="true"
                className="flex items-center justify-between gap-4 rounded-2xl border border-white/5 bg-white/[0.01] p-5 opacity-60"
              >
                <div className="min-w-0">
                  <div className="text-body font-medium text-moonbeem-ink-muted">
                    {e.label}
                  </div>
                  <p className="m-0 mt-1 text-body-sm text-moonbeem-ink-subtle">
                    {e.description}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-white/5 px-2.5 py-0.5 text-caption text-moonbeem-ink-subtle">
                  coming soon
                </span>
              </li>
            ),
          )}
        </ul>
      </div>
    </div>
  );
}
