import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  ACTIVE_CAMPAIGN_STATUSES,
  type CampaignStatus,
} from "@/lib/campaigns/status";

// Public /t/[slug]/campaign page query. Service-role (campaigns +
// campaign_titles are deny-all under RLS, same posture as the title-page
// pill check). Returns ONLY display-safe fields — never budget_pool_cents
// or any *_cents besides cpm_rate_cents — so the budget / remaining figure
// can never leak onto a public surface.
//
// Selection precedence:
//   1. newest ACTIVE campaign (funded|live), funded_at desc nulls last
//   2. else newest ENDED campaign (completed|paused) → ended:true
//   3. else null (draft-only / unlinked titles → page redirects to /t/[slug])
// Draft campaigns are deliberately invisible (neither active nor ended).

const ENDED_CAMPAIGN_STATUSES = ["completed", "paused"] as const;

const ACTIVE = new Set<string>(ACTIVE_CAMPAIGN_STATUSES);
const ENDED = new Set<string>(ENDED_CAMPAIGN_STATUSES);

export type CampaignForTitlePage = {
  id: string;
  name: string;
  status: CampaignStatus;
  cpmRateCents: number;
  settlingDays: number;
  brief: string | null;
  partnerName: string;
  ended: boolean;
};

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  cpm_rate_cents: number;
  settling_days: number;
  brief: string | null;
  funded_at: string | null;
  created_at: string;
  partner: { name: string } | null;
};

type JoinRow = { campaign: CampaignRow | null };

export async function getCampaignForTitlePage(
  titleId: string,
): Promise<CampaignForTitlePage | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("campaign_titles")
    .select(
      "campaign:campaigns!inner(id, name, status, cpm_rate_cents, settling_days, brief, funded_at, created_at, partner:partners!inner(name))",
    )
    .eq("title_id", titleId);
  if (error || !data) return null;

  const campaigns = (data as unknown as JoinRow[])
    .map((r) => r.campaign)
    .filter((c): c is CampaignRow => c != null);

  const toShape = (c: CampaignRow, ended: boolean): CampaignForTitlePage => ({
    id: c.id,
    name: c.name,
    status: c.status as CampaignStatus,
    cpmRateCents: c.cpm_rate_cents,
    settlingDays: c.settling_days,
    brief: c.brief,
    partnerName: c.partner?.name ?? "",
    ended,
  });

  // Newest ACTIVE — funded_at desc, nulls last.
  const active = campaigns
    .filter((c) => ACTIVE.has(c.status))
    .sort((a, b) => {
      const ra = a.funded_at ? Date.parse(a.funded_at) : null;
      const rb = b.funded_at ? Date.parse(b.funded_at) : null;
      if (ra === rb) return 0;
      if (ra === null) return 1; // a sorts after b (nulls last)
      if (rb === null) return -1; // b sorts after a
      return rb - ra; // descending
    });
  if (active.length > 0) return toShape(active[0], false);

  // Newest ENDED — created_at desc.
  const ended = campaigns
    .filter((c) => ENDED.has(c.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (ended.length > 0) return toShape(ended[0], true);

  return null;
}
