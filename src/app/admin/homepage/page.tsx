// /admin/homepage — hub linking the five curators that shape the
// homepage. Two already exist (Marquee, Featured); one ships in this
// commit (Recent Edits); two are scoped for follow-ups (All Films,
// Trending Edits). Disabled placeholder rows show the eventual full
// shape so an admin scanning the page understands what's coming.

import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdminOr404 } from "@/lib/dal";

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
    href: null,
    label: "All Films",
    description: "Per-title pin + hide overrides on the comprehensive catalog carousel.",
    status: "coming-soon",
  },
  {
    href: null,
    label: "Trending Edits",
    description:
      "Per-fan_edit pin + hide overrides layered onto the 24h-delta algorithm.",
    status: "coming-soon",
  },
];

export default async function AdminHomepagePage() {
  await requireSuperAdminOr404();
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
          Curate every section of the homepage from one place. Each
          carousel has its own pin / hide controls — pins float to the
          top of the section, hidden items drop out of the section only
          (other carousels still surface them).
        </p>
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
