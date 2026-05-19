"use client";

// Partner dashboard card that lists existing campaigns and (for
// admins) opens the CampaignWizard or kicks off funding via Stripe
// Checkout. Mirrors PartnerRatesCard's shape: data passed in as
// props from the server component, optional interactive editing
// gated on isAdmin, viewer fallback line for non-admins.
//
// 3b additions:
// - Per-row "Fund" button on draft campaigns (admin only). Posts to
//   /api/p/[slug]/campaigns/[id]/fund and redirects to the returned
//   Stripe Checkout URL. 409 funding_already_in_progress is shown
//   as a readable message rather than a raw error.
// - Return-flag handling. Stripe Checkout's success_url / cancel_url
//   land back on the dashboard with ?campaign_funded=<id> or
//   ?campaign_funding_cancelled=<id>. On detection, the card briefly
//   shows a banner and calls router.refresh() so the now-funded
//   campaign re-renders with its updated status. The URL flag is
//   then cleared via router.replace() so a manual reload doesn't
//   re-trigger.

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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

function friendlyFundError(code: string): string {
  switch (code) {
    case "funding_already_in_progress":
      return "A funding payment is already in progress for this campaign. Finish or cancel it before starting a new one.";
    case "invalid_state":
      return "This campaign is no longer a draft. Refresh the dashboard.";
    case "not_authorized":
      return "You don't have admin access on this partner.";
    case "not_authenticated":
      return "Please sign in again.";
    case "campaign_not_found":
      return "Campaign not found.";
    case "stripe_error":
      return "Stripe couldn't open a checkout session. Please try again.";
    case "customer_persist_failed":
      return "Couldn't save the Stripe customer. Please try again.";
    default:
      return code;
  }
}

export default function CampaignsCard({
  partnerSlug,
  isAdmin,
  campaigns,
  titles,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [banner, setBanner] = useState<
    { kind: "success" | "info"; text: string } | null
  >(null);
  const returnHandled = useRef(false);

  const fundedFlag = searchParams.get("campaign_funded");
  const cancelledFlag = searchParams.get("campaign_funding_cancelled");

  // Handle return from Stripe Checkout. Only runs once per mount —
  // after detection, we clean the query params with router.replace()
  // (which leaves the rest of the URL intact) and call router.refresh()
  // so the server component re-fetches campaign rows. The ref guards
  // against an Effect re-run loop in case router.refresh() doesn't
  // immediately stabilize the searchParams reference.
  useEffect(() => {
    if (returnHandled.current) return;
    if (!fundedFlag && !cancelledFlag) return;
    returnHandled.current = true;
    if (fundedFlag) {
      setBanner({
        kind: "success",
        text: "Payment received. Your campaign is funded.",
      });
    } else if (cancelledFlag) {
      setBanner({
        kind: "info",
        text: "Funding cancelled. You can try again any time.",
      });
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete("campaign_funded");
    params.delete("campaign_funding_cancelled");
    const newSearch = params.toString();
    router.replace(
      `${window.location.pathname}${newSearch ? `?${newSearch}` : ""}`,
      { scroll: false },
    );
    router.refresh();
  }, [fundedFlag, cancelledFlag, searchParams, router]);

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

      {banner && (
        <div
          className={`mt-4 rounded-lg border px-3 py-2 text-caption ${
            banner.kind === "success"
              ? "border-emerald-700/40 bg-emerald-700/10 text-emerald-300"
              : "border-white/10 bg-white/5 text-moonbeem-ink-subtle"
          }`}
        >
          {banner.text}
        </div>
      )}

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
                  {isAdmin && <th className="px-3 py-2">Actions</th>}
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
                    {isAdmin && (
                      <td className="px-3 py-2">
                        {c.status === "draft" ? (
                          <FundCampaignButton
                            partnerSlug={partnerSlug}
                            campaignId={c.id}
                          />
                        ) : (
                          <span className="text-caption text-moonbeem-ink-subtle">
                            —
                          </span>
                        )}
                      </td>
                    )}
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

function FundCampaignButton({
  partnerSlug,
  campaignId,
}: {
  partnerSlug: string;
  campaignId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fund() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/p/${partnerSlug}/campaigns/${campaignId}/fund`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        checkout_url?: string;
      };
      if (!res.ok || !json.ok || !json.checkout_url) {
        setError(friendlyFundError(json.error ?? `request_failed_${res.status}`));
        setBusy(false);
        return;
      }
      window.location.href = json.checkout_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "network_error");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={fund}
        disabled={busy}
        className="rounded-md bg-moonbeem-pink px-3 py-1.5 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Opening Stripe…" : "Fund campaign"}
      </button>
      {error && (
        <p className="text-caption text-moonbeem-magenta max-w-xs">{error}</p>
      )}
    </div>
  );
}
