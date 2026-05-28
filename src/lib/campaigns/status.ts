// Source of truth for campaigns.status values + partner-facing copy.
//
// Mirrors the CHECK constraint on public.campaigns.status and the
// Edge Function's lifecycle transitions (funded → live when first
// positive billing fires; live → completed when the pool drains).
//
// Use campaignStatusCopy() everywhere the partner sees a status —
// the pill in the dashboard list, the header on the detail page,
// any future status indicator. Keeping the copy in one place
// prevents the "funded reads as running" perception bug from
// re-emerging on a new surface.

export const CAMPAIGN_STATUSES = [
  "draft",
  "funded",
  "live",
  "paused",
  "completed",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export type CampaignStatusCopy = {
  label: string;
  description: string;
  pillClass: string;
};

// ctx.rolloverCents is the SUM of amount_cents from any
// partner_credits row where source_campaign_id = this campaign.
// Pass it on completed campaigns to surface "Rolled over $X.XX"
// vs the generic "Pool drained" fallback. Other statuses ignore
// ctx; callers without the data can pass nothing.
export function campaignStatusCopy(
  status: string,
  ctx?: { rolloverCents?: number | null },
): CampaignStatusCopy {
  switch (status) {
    case "draft":
      return {
        label: "Draft",
        description: "Not yet funded",
        pillClass: "bg-white/5 text-moonbeem-ink-muted",
      };
    case "funded":
      return {
        label: "Funded",
        description: "Escrowed — waiting for first metered run",
        pillClass: "bg-moonbeem-violet/20 text-moonbeem-violet-soft",
      };
    case "live":
      return {
        label: "Live",
        description: "Paying creators daily",
        pillClass: "bg-moonbeem-pink/15 text-moonbeem-pink",
      };
    case "paused":
      return {
        label: "Paused",
        description: "Metering skipped",
        pillClass: "bg-yellow-700/20 text-yellow-300",
      };
    case "completed": {
      const rollover = ctx?.rolloverCents ?? 0;
      const description =
        rollover > 0
          ? `Rolled over $${(rollover / 100).toFixed(2)} to partner credit`
          : "Pool drained";
      return {
        label: "Completed",
        description,
        pillClass: "bg-emerald-700/20 text-emerald-300",
      };
    }
    default:
      return {
        label: status,
        description: "",
        pillClass: "bg-white/5 text-moonbeem-ink-muted",
      };
  }
}
