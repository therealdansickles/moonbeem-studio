"use client";

// Partner dashboard card that lists existing campaigns and (for
// admins) opens the CampaignWizard. Mirrors PartnerRatesCard's shape:
// data passed in as props from the server component, optional
// interactive editing gated on isAdmin, viewer fallback line for
// non-admins.

import { useState } from "react";
import CampaignWizard from "./CampaignWizard";

type CampaignSummary = {
  id: string;
  name: string;
  status: string;
  cpm_rate_cents: number;
  budget_pool_cents: number;
  settling_days: number;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  title_count: number;
};

type PartnerTitle = {
  id: string;
  slug: string;
  title: string;
  poster_url: string | null;
  is_active: boolean;
};

type Props = {
  partnerSlug: string;
  isAdmin: boolean;
  campaigns: CampaignSummary[];
  titles: PartnerTitle[];
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function statusPillClass(status: string): string {
  switch (status) {
    case "draft":
      return "bg-white/5 text-moonbeem-ink-muted";
    case "funded":
      return "bg-moonbeem-violet/20 text-moonbeem-violet-soft";
    case "live":
      return "bg-moonbeem-pink/15 text-moonbeem-pink";
    case "paused":
      return "bg-yellow-700/20 text-yellow-300";
    case "completed":
      return "bg-emerald-700/20 text-emerald-300";
    default:
      return "bg-white/5 text-moonbeem-ink-muted";
  }
}

export default function CampaignsCard({
  partnerSlug,
  isAdmin,
  campaigns,
  titles,
}: Props) {
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-moonbeem-pink/15 px-2.5 py-0.5 text-caption font-medium text-moonbeem-pink">
            Campaigns
          </span>
          <span className="text-caption text-moonbeem-ink-subtle">
            CPM with a cap
          </span>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90"
          >
            + Create campaign
          </button>
        )}
      </div>

      <div className="mt-4">
        {campaigns.length === 0 ? (
          <p className="text-body-sm text-moonbeem-ink-subtle">
            No campaigns yet.{" "}
            {isAdmin
              ? "Click Create campaign to set the first one up."
              : "An admin on this partner can create the first one."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-caption text-moonbeem-ink-subtle">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">CPM</th>
                  <th className="px-3 py-2">Budget</th>
                  <th className="px-3 py-2">Titles</th>
                  <th className="px-3 py-2">Window</th>
                  <th className="px-3 py-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-white/5 last:border-b-0"
                  >
                    <td className="px-3 py-2 text-moonbeem-ink">
                      {c.name}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-caption uppercase tracking-wider ${statusPillClass(c.status)}`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-moonbeem-ink">
                      {formatCents(c.cpm_rate_cents)} / 1k
                    </td>
                    <td className="px-3 py-2 text-moonbeem-ink">
                      {formatCents(c.budget_pool_cents)}
                    </td>
                    <td className="px-3 py-2 text-moonbeem-ink">
                      {c.title_count}
                    </td>
                    <td className="px-3 py-2 text-moonbeem-ink-subtle">
                      {c.starts_at || c.ends_at
                        ? `${c.starts_at ? formatDate(c.starts_at) : "open"} → ${c.ends_at ? formatDate(c.ends_at) : "open"}`
                        : "open-ended"}
                    </td>
                    <td className="px-3 py-2 text-moonbeem-ink-subtle">
                      {formatDate(c.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!isAdmin && (
        <p className="mt-4 text-caption text-moonbeem-ink-subtle">
          You have viewer access to this partner. Contact an admin to
          create or fund campaigns.
        </p>
      )}

      {wizardOpen && (
        <CampaignWizard
          partnerSlug={partnerSlug}
          titles={titles}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </div>
  );
}
