// Per-campaign detail page at /p/[slug]/campaigns/[id]. Read-only
// visibility surface; no actions today (pause/cancel/edit are
// banked in the followup queue).
//
// Auth mirrors /p/[slug]/dashboard exactly — anonymous and signed-
// in non-members get notFound(). Partner-team members (admin OR
// viewer) and super-admins read everything. There's no admin-only
// write surface in this build, so no role gating beyond read.
//
// Partner scoping: the campaign's partner_id must match the slug's
// partner. A 404 path covers both "campaign doesn't exist" and
// "campaign belongs to a different partner" — never leak that the
// id is real but on a different partner.
//
// All numbers come from existing tables — `campaign_ledger.amount_cents`
// is the authoritative source for spent / pool_remaining per the
// 3c.2B comment ("re-read from the ledger SUM after the loop"). The
// alternative path via creator_earnings.earnings_cents agrees to the
// cent today; we still prefer the ledger so the page stays correct
// if a rollover_debit ever lands.

import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { campaignStatusCopy } from "@/lib/campaigns/status";
import DataTable, { type Column } from "@/components/dashboard/DataTable";
import InitialAvatar from "@/components/p/InitialAvatar";
import PlatformIcon from "@/components/PlatformIcon";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function formatDateShort(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  if (!UUID_RE.test(id)) return { title: "Campaign" };
  const supabase = createServiceRoleClient();
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("name")
    .eq("id", id)
    .maybeSingle();
  if (!campaign) return { title: "Campaign" };
  return {
    title: `${campaign.name as string} · Campaign · Moonbeem`,
    robots: { index: false, follow: false },
  };
}

type CampaignRow = {
  id: string;
  partner_id: string;
  name: string;
  brief: string | null;
  status: string;
  cpm_rate_cents: number;
  budget_pool_cents: number;
  settling_days: number;
  moonbeem_fee_pct: number;
  starts_at: string | null;
  ends_at: string | null;
  funded_at: string | null;
  launched_at: string | null;
  completed_at: string | null;
  created_at: string;
};

type CampaignTitle = {
  id: string;
  slug: string;
  title: string;
  poster_url: string | null;
};

type FundingRow = {
  id: string;
  amount_cents: number;
  fee_cents: number;
  stripe_payment_intent_id: string | null;
  status: string;
  created_at: string;
};

type MeteringRunRow = {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  rows_billed: number;
  total_billed_cents: number;
  pool_remaining_before_cents: number;
  pool_remaining_after_cents: number;
  prorata_factor: number | null;
};

type TopCreatorRow = {
  creator_id: string;
  handle: string;
  edit_count: number;
  total_cents: number;
};

type TopFanEditRow = {
  fan_edit_id: string;
  platform: "tiktok" | "instagram" | "twitter" | "youtube";
  thumbnail_url: string | null;
  creator_handle: string | null;
  title_slug: string;
  total_cents: number;
};

type PartnerCreditRow = {
  id: string;
  amount_cents: number;
  remaining_cents: number;
  applied_to_campaign_id: string | null;
  status: string;
  created_at: string;
};

export default async function CampaignDetailPage({ params }: PageProps) {
  const { slug, id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const user = await getUser();
  if (!user) notFound();

  const supabase = createServiceRoleClient();

  // Resolve partner first so we can scope-check the campaign.
  const { data: partner } = await supabase
    .from("partners")
    .select("id, slug, name, logo_url")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) notFound();

  // Same access pattern as /p/[slug]/dashboard — partner-team
  // member (admin OR viewer) OR super-admin reads everything.
  const profile = await getCurrentProfile();
  const isSuperAdmin = profile?.role === "super_admin";
  if (!isSuperAdmin) {
    const { data: membership } = await supabase
      .from("partner_users")
      .select("role")
      .eq("partner_id", partner.id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!membership) notFound();
  }

  const campaignRes = await supabase
    .from("campaigns")
    .select(
      "id, partner_id, name, brief, status, cpm_rate_cents, budget_pool_cents, " +
        "settling_days, moonbeem_fee_pct, starts_at, ends_at, " +
        "funded_at, launched_at, completed_at, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  // Supabase's typed-string select narrows loosely — cast the
  // result row through `unknown` to the projection we know we asked
  // for. Partner scoping: notFound either way ("doesn't exist" vs
  // "belongs to a different partner" — same response, no enumeration).
  const campaign =
    (campaignRes.data as unknown as CampaignRow | null) ?? null;
  if (!campaign || campaign.partner_id !== partner.id) {
    notFound();
  }

  // Parallel fan-out for everything else.
  const [
    titlesRes,
    fundingRes,
    runsRes,
    earningsRes,
    ledgerRes,
    creditsRes,
  ] = await Promise.all([
    supabase
      .from("campaign_titles")
      .select("title_id, titles(id, slug, title, poster_url)")
      .eq("campaign_id", id),
    supabase
      .from("campaign_funding")
      .select(
        "id, amount_cents, fee_cents, stripe_payment_intent_id, status, created_at",
      )
      .eq("campaign_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("campaign_metering_runs")
      .select(
        "id, started_at, completed_at, status, rows_billed, " +
          "total_billed_cents, pool_remaining_before_cents, " +
          "pool_remaining_after_cents, prorata_factor",
      )
      .eq("campaign_id", id)
      .order("started_at", { ascending: false })
      .limit(10),
    // Earnings rows drive both the per-creator and per-fan_edit
    // rollups; one fetch, two GROUP BYs in JS to avoid two round-trips.
    supabase
      .from("creator_earnings")
      .select("creator_id, fan_edit_id, earnings_cents")
      .eq("campaign_id", id),
    supabase
      .from("campaign_ledger")
      .select("entry_type, amount_cents, created_at")
      .eq("campaign_id", id),
    supabase
      .from("partner_credits")
      .select(
        "id, amount_cents, remaining_cents, applied_to_campaign_id, status, created_at",
      )
      .eq("source_campaign_id", id)
      .order("created_at", { ascending: true }),
  ]);

  // Supabase typing for FK-joined columns is array-shaped at runtime
  // even on a single-row FK; cast through unknown to project to the
  // single-row CampaignTitle we know the relationship guarantees.
  const titles: CampaignTitle[] = (
    (titlesRes.data ?? []) as unknown as Array<{
      titles: CampaignTitle | CampaignTitle[] | null;
    }>
  )
    .map((row) => (Array.isArray(row.titles) ? row.titles[0] : row.titles))
    .filter((t): t is CampaignTitle => !!t);

  // Same loose-typing pattern as campaignRow above — cast through
  // unknown for each parallel query result.
  const funding =
    (fundingRes.data as unknown as FundingRow[] | null) ?? [];
  const runs =
    (runsRes.data as unknown as MeteringRunRow[] | null) ?? [];
  const earnings =
    (earningsRes.data as unknown as Array<{
      creator_id: string | null;
      fan_edit_id: string | null;
      earnings_cents: number | null;
    }> | null) ?? [];
  const ledger =
    (ledgerRes.data as unknown as Array<{
      entry_type: string;
      amount_cents: number;
      created_at: string;
    }> | null) ?? [];
  const partnerCredits =
    (creditsRes.data as unknown as PartnerCreditRow[] | null) ?? [];

  // Budget math — ledger SUM is authoritative per 3c.2B.
  const ledgerSumAll = ledger.reduce((s, e) => s + e.amount_cents, 0);
  const payoutSum = ledger
    .filter((e) => e.entry_type === "payout")
    .reduce((s, e) => s + e.amount_cents, 0);
  const spentCents = -payoutSum;
  const poolRemainingCents = ledgerSumAll;
  const pctSpent = campaign.budget_pool_cents > 0
    ? Math.min(100, (spentCents / campaign.budget_pool_cents) * 100)
    : 0;
  const rolloverCents = partnerCredits.reduce(
    (s, c) => s + c.amount_cents,
    0,
  );

  // Status copy (honest label + description). Branches on rollover
  // when status='completed'.
  const statusCopy = campaignStatusCopy(campaign.status, {
    rolloverCents,
  });

  // ------- per-creator + per-fan_edit rollups (in JS to avoid two
  // additional round-trips; the dataset is bounded by campaign size
  // and stays small)
  const byCreator = new Map<
    string,
    { sum: number; edits: Set<string> }
  >();
  const byFanEdit = new Map<string, { sum: number }>();
  for (const e of earnings) {
    const cents = e.earnings_cents ?? 0;
    if (e.creator_id) {
      const c = byCreator.get(e.creator_id) ?? {
        sum: 0,
        edits: new Set<string>(),
      };
      c.sum += cents;
      if (e.fan_edit_id) c.edits.add(e.fan_edit_id);
      byCreator.set(e.creator_id, c);
    }
    if (e.fan_edit_id) {
      const f = byFanEdit.get(e.fan_edit_id) ?? { sum: 0 };
      f.sum += cents;
      byFanEdit.set(e.fan_edit_id, f);
    }
  }
  // Only the top-10 by earnings are rendered (the .slice(0, 10) below), and the
  // ranking is by in-memory total_cents — independent of these display reads. So
  // bound the handle/meta lookups to those <=10 ids: no oversized id=in.(...)
  // URL is ever built (no chunking needed), and the rendered top-10 is
  // identical — these reads supply only the display handle/thumbnail attached
  // AFTER ranking. (Same stable sort + source as the render slices below, so
  // the bounded id set is exactly the rows that render.)
  const TOP_N = 10;
  const topCreatorIds = Array.from(byCreator.entries())
    .sort((a, b) => b[1].sum - a[1].sum)
    .slice(0, TOP_N)
    .map(([id]) => id);
  const topFanEditIds = Array.from(byFanEdit.entries())
    .sort((a, b) => b[1].sum - a[1].sum)
    .slice(0, TOP_N)
    .map(([id]) => id);

  const [creatorRowsRes, fanEditRowsRes] = await Promise.all([
    topCreatorIds.length > 0
      ? supabase
          .from("public_creators")
          .select("id, moonbeem_handle")
          .in("id", topCreatorIds)
      : Promise.resolve({ data: [] as Array<{ id: string; moonbeem_handle: string }> }),
    topFanEditIds.length > 0
      ? supabase
          .from("fan_edits")
          .select(
            "id, platform, thumbnail_url, creator_handle_displayed, title_id",
          )
          .in("id", topFanEditIds)
      : Promise.resolve({
          data: [] as Array<{
            id: string;
            platform: string;
            thumbnail_url: string | null;
            creator_handle_displayed: string | null;
            title_id: string;
          }>,
        }),
  ]);

  const handleByCreator = new Map<string, string>(
    (creatorRowsRes.data ?? []).map((r) => [
      r.id as string,
      r.moonbeem_handle as string,
    ]),
  );
  const titleSlugById = new Map<string, string>(
    titles.map((t) => [t.id, t.slug]),
  );
  const fanEditMeta = new Map<
    string,
    {
      platform: TopFanEditRow["platform"];
      thumbnail_url: string | null;
      creator_handle: string | null;
      title_slug: string;
    }
  >();
  for (const r of fanEditRowsRes.data ?? []) {
    fanEditMeta.set(r.id as string, {
      platform: r.platform as TopFanEditRow["platform"],
      thumbnail_url: r.thumbnail_url as string | null,
      creator_handle: r.creator_handle_displayed as string | null,
      title_slug:
        titleSlugById.get(r.title_id as string) ??
        titles[0]?.slug ??
        "",
    });
  }

  const topCreators: TopCreatorRow[] = Array.from(byCreator.entries())
    .map(([creator_id, agg]) => ({
      creator_id,
      handle: handleByCreator.get(creator_id) ?? "anon",
      edit_count: agg.edits.size,
      total_cents: agg.sum,
    }))
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, 10);

  const topFanEdits: TopFanEditRow[] = Array.from(byFanEdit.entries())
    .map(([fan_edit_id, agg]) => {
      const meta = fanEditMeta.get(fan_edit_id);
      return {
        fan_edit_id,
        platform: meta?.platform ?? "tiktok",
        thumbnail_url: meta?.thumbnail_url ?? null,
        creator_handle: meta?.creator_handle ?? null,
        title_slug: meta?.title_slug ?? titles[0]?.slug ?? "",
        total_cents: agg.sum,
      };
    })
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, 10);

  const distinctCreatorsPaid = byCreator.size;
  const distinctFanEditsPaid = byFanEdit.size;

  // ------- render
  const titleSummary =
    titles.length === 1
      ? titles[0].title
      : titles.length === 0
        ? "no titles attached"
        : `${titles.length} titles`;

  const fundingRow = funding[0] ?? null;

  return (
    <div className="min-h-screen px-4 py-6 md:px-6 md:py-12">
      <div className="mx-auto max-w-5xl">
        {/* Breadcrumb back to dashboard */}
        <Link
          href={`/p/${partner.slug}/dashboard`}
          className="text-caption text-moonbeem-ink-muted hover:text-moonbeem-pink"
        >
          ← {partner.name} dashboard
        </Link>

        {/* Section a — header */}
        <div className="mt-6 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-2">
            <h1 className="font-wordmark text-display-md md:text-display-lg text-moonbeem-ink m-0">
              {campaign.name}
            </h1>
            <p className="text-body text-moonbeem-ink-muted m-0">
              {(partner.name as string)} · {titleSummary}
            </p>
          </div>
          <div className="flex flex-col items-start gap-1 md:items-end">
            <span
              className={`inline-flex w-fit rounded-full px-3 py-1 text-caption uppercase tracking-wider ${statusCopy.pillClass}`}
            >
              {statusCopy.label}
            </span>
            {statusCopy.description && (
              <span className="text-caption text-moonbeem-ink-subtle">
                {statusCopy.description}
              </span>
            )}
          </div>
        </div>

        {/* Section b — status timeline */}
        <section className="mt-10">
          <StatusTimeline
            fundedAt={campaign.funded_at}
            launchedAt={campaign.launched_at}
            completedAt={campaign.completed_at}
          />
        </section>

        {/* Section c — budget gauge */}
        <section
          className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5 md:p-6"
        >
          <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
            Budget
          </p>
          <div className="mt-2 flex items-baseline gap-3">
            <p className="m-0 font-wordmark text-display-md md:text-display-lg text-moonbeem-ink tabular-nums leading-[0.95]">
              {formatCents(spentCents)}
            </p>
            <p className="m-0 text-body text-moonbeem-ink-muted tabular-nums">
              spent of {formatCents(campaign.budget_pool_cents)}
            </p>
          </div>
          <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-moonbeem-pink transition-[width] duration-500"
              style={{ width: `${pctSpent.toFixed(2)}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-moonbeem-ink-subtle tabular-nums">
            <span>{pctSpent.toFixed(1)}% spent</span>
            <span>·</span>
            <span>
              {formatCents(poolRemainingCents)} remaining in pool
            </span>
            <span>·</span>
            <span>
              {distinctCreatorsPaid}{" "}
              {distinctCreatorsPaid === 1 ? "creator" : "creators"} paid
            </span>
            <span>·</span>
            <span>
              {distinctFanEditsPaid}{" "}
              {distinctFanEditsPaid === 1 ? "fan edit" : "fan edits"} earning
            </span>
          </div>
        </section>

        {/* Section d — funding facts */}
        <section className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
          <Fact
            label="CPM"
            value={`${formatCents(campaign.cpm_rate_cents)} / 1k`}
          />
          <Fact
            label="Settling days"
            value={`${campaign.settling_days}d`}
          />
          <Fact
            label="Moonbeem fee"
            value={`${(campaign.moonbeem_fee_pct * 100).toFixed(0)}%`}
          />
          <Fact
            label="Funding"
            value={
              fundingRow
                ? `${formatCents(fundingRow.amount_cents)} · ${fundingRow.status}`
                : "—"
            }
            sub={
              fundingRow && fundingRow.stripe_payment_intent_id
                ? "Stripe PI attached"
                : undefined
            }
          />
        </section>

        {/* Section d2 — creator brief (read-only; set at creation, CF-2) */}
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
            Creator brief
          </p>
          {campaign.brief ? (
            <p className="mt-2 text-body-sm text-moonbeem-ink whitespace-pre-line m-0">
              {campaign.brief}
            </p>
          ) : (
            <p className="mt-2 text-body-sm text-moonbeem-ink-subtle m-0">
              No brief
            </p>
          )}
        </section>

        {/* Section e — metering runs */}
        <section className="mt-10 flex flex-col gap-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-heading-lg md:text-display-sm m-0">
              Metering runs
            </h2>
            <span className="text-caption text-moonbeem-ink-subtle">
              {runs.length} {runs.length === 1 ? "run" : "runs"} ·
              most recent first
            </span>
          </div>
          {runs.length === 0 ? (
            <EmptyCard>
              No metered runs yet — billing begins once fan edits
              complete their settling window (
              {campaign.settling_days}d after capture).
            </EmptyCard>
          ) : (
            <DataTable<MeteringRunRow>
              columns={meteringRunColumns}
              rows={runs}
              rowKey={(r) => r.id}
              emptyMessage="No metered runs yet."
            />
          )}
        </section>

        {/* Section f + g — top creators + top fan_edits */}
        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <div className="flex items-baseline gap-3">
              <h2 className="text-heading-md m-0">Top creators paid</h2>
              <span className="text-caption text-moonbeem-ink-subtle">
                by $ earned on this campaign
              </span>
            </div>
            {topCreators.length === 0 ? (
              <p className="mt-4 text-body-sm text-moonbeem-ink-muted">
                No creator earnings yet — billing has not paid out on
                this campaign.
              </p>
            ) : (
              <ol className="mt-4 flex flex-col">
                {topCreators.map((c, i) => (
                  <li key={c.creator_id}>
                    <Link
                      href={`/c/${c.handle}`}
                      className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-white/[0.035]"
                    >
                      <span className="w-5 shrink-0 text-caption font-semibold tabular-nums text-moonbeem-ink-subtle">
                        {i + 1}
                      </span>
                      <InitialAvatar handle={c.handle} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body-sm font-medium text-moonbeem-ink">
                          @{c.handle}
                        </span>
                        <span className="text-caption text-moonbeem-ink-subtle">
                          {c.edit_count}{" "}
                          {c.edit_count === 1 ? "edit" : "edits"} paid
                        </span>
                      </div>
                      <span className="text-body-sm font-semibold tabular-nums text-moonbeem-ink">
                        {formatCents(c.total_cents)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <div className="flex items-baseline gap-3">
              <h2 className="text-heading-md m-0">Top fan edits</h2>
              <span className="text-caption text-moonbeem-ink-subtle">
                driving spend
              </span>
            </div>
            {topFanEdits.length === 0 ? (
              <p className="mt-4 text-body-sm text-moonbeem-ink-muted">
                No fan edits have earned on this campaign yet.
              </p>
            ) : (
              <ol className="mt-4 flex flex-col">
                {topFanEdits.map((fe, i) => (
                  <li key={fe.fan_edit_id}>
                    <Link
                      href={`/t/${fe.title_slug}`}
                      className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-white/[0.035]"
                    >
                      <span className="w-5 shrink-0 text-caption font-semibold tabular-nums text-moonbeem-ink-subtle">
                        {i + 1}
                      </span>
                      <div className="relative h-12 w-9 shrink-0 overflow-hidden rounded bg-moonbeem-navy/40">
                        {fe.thumbnail_url ? (
                          <Image
                            src={fe.thumbnail_url}
                            alt=""
                            fill
                            sizes="36px"
                            className="object-cover"
                            unoptimized
                          />
                        ) : null}
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-1.5 text-body-sm text-moonbeem-ink">
                          <PlatformIcon
                            platform={fe.platform}
                            className="h-3.5 w-3.5"
                          />
                          @{fe.creator_handle ?? "anon"}
                        </span>
                        <span className="text-caption text-moonbeem-ink-subtle">
                          on {fe.title_slug ? `/t/${fe.title_slug}` : "—"}
                        </span>
                      </div>
                      <span className="text-body-sm font-semibold tabular-nums text-moonbeem-ink">
                        {formatCents(fe.total_cents)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ===================================================================
// Sub-components — kept in-file because each is small and only used
// here; matches the partner dashboard's HeroTile pattern.
// ===================================================================

function Fact({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 md:p-5 flex flex-col gap-1.5">
      <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
        {label}
      </p>
      <p className="m-0 font-wordmark text-heading-md text-moonbeem-ink tabular-nums leading-[1.1]">
        {value}
      </p>
      {sub && (
        <p className="m-0 text-caption text-moonbeem-ink-subtle">{sub}</p>
      )}
    </div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <p className="m-0 text-body-sm text-moonbeem-ink-muted">{children}</p>
    </div>
  );
}

function StatusTimeline({
  fundedAt,
  launchedAt,
  completedAt,
}: {
  fundedAt: string | null;
  launchedAt: string | null;
  completedAt: string | null;
}) {
  const steps = [
    { key: "funded", label: "Funded", at: fundedAt },
    { key: "launched", label: "Launched", at: launchedAt },
    { key: "completed", label: "Completed", at: completedAt },
  ];
  // Layout: three w-7 (28px) cells at 0% / 50% / 100% via
  // flex+justify-between. Circle centers land at 14px, full/2, and
  // full-14px. The line track is absolutely positioned with left-3.5
  // / right-3.5 (14px) so it spans circle-center to circle-center,
  // split into two equal segments that each color based on whether
  // the NEXT step has fired. Labels + dates sit in a parallel row
  // of w-7 cells; flex items-center centers each label's bounding
  // box on the matching cell's midpoint — overflowing symmetrically
  // outside the cell, which keeps each label visually centered on
  // its node.
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <p className="text-caption uppercase tracking-wide text-moonbeem-ink-muted m-0">
        Lifecycle
      </p>
      <div className="relative mt-6 px-3.5">
        {/* Line track — center-to-center across all three nodes,
            split into two equal segments. */}
        <div className="absolute inset-x-3.5 top-3 flex h-px">
          <div
            className={`flex-1 ${
              steps[1].at ? "bg-moonbeem-pink/40" : "bg-white/10"
            }`}
          />
          <div
            className={`flex-1 ${
              steps[2].at ? "bg-moonbeem-pink/40" : "bg-white/10"
            }`}
          />
        </div>
        {/* Circles row — justify-between pushes outers to edges,
            middle to center. */}
        <div className="relative flex justify-between">
          {steps.map((s) => {
            const fired = !!s.at;
            return (
              <div
                key={s.key}
                className={`flex h-7 w-7 items-center justify-center rounded-full border-2 ${
                  fired
                    ? "border-moonbeem-pink bg-moonbeem-pink/20"
                    : "border-white/15 bg-transparent"
                }`}
              >
                {fired ? (
                  <div className="h-2.5 w-2.5 rounded-full bg-moonbeem-pink" />
                ) : null}
              </div>
            );
          })}
        </div>
        {/* Labels + dates row — each cell w-7 matching the circle
            above, items-center so the label/date center on the cell
            midpoint (which sits over the circle center). Labels are
            wider than 28px and overflow symmetrically. */}
        <div className="mt-2 flex justify-between">
          {steps.map((s) => {
            const fired = !!s.at;
            return (
              <div
                key={s.key}
                className="flex w-7 flex-col items-center gap-0.5"
              >
                <span
                  className={`text-caption font-medium whitespace-nowrap ${
                    fired
                      ? "text-moonbeem-ink"
                      : "text-moonbeem-ink-subtle"
                  }`}
                >
                  {s.label}
                </span>
                <span className="text-[10px] text-moonbeem-ink-subtle tabular-nums whitespace-nowrap">
                  {formatDateShort(s.at)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const meteringRunColumns: Column<MeteringRunRow>[] = [
  {
    key: "started_at",
    label: "Run",
    render: (r) => (
      <span className="text-body-sm tabular-nums">
        {formatDate(r.started_at)}
      </span>
    ),
  },
  {
    key: "rows_billed",
    label: "Rows",
    align: "right",
    render: (r) => r.rows_billed.toLocaleString(),
  },
  {
    key: "total_billed_cents",
    label: "Billed",
    align: "right",
    render: (r) => formatCents(r.total_billed_cents),
  },
  {
    key: "pool_remaining_after_cents",
    label: "Pool after",
    align: "right",
    render: (r) => formatCents(r.pool_remaining_after_cents),
  },
  {
    key: "prorata_factor",
    label: "Prorata",
    align: "right",
    render: (r) =>
      r.prorata_factor === null
        ? "—"
        : r.prorata_factor === 1
          ? "1.000"
          : r.prorata_factor.toFixed(3),
  },
];
