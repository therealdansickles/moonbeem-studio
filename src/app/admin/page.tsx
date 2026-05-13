// /admin — Moonbeem internal landing page.
//
// Super-admin only via requireSuperAdminOr404 (404 hides existence;
// non-super-admins see a generic "page not found"). All reads via
// service-role (the underlying tables — partners, withdrawals,
// creator_earnings, fan_edits — have RLS with no public SELECT).
//
// Sections (all read-only):
//   1. Partners
//   2. Titles across system
//   3. Recent withdrawals (last 50)
//   4. Recent earnings calculations (rollup per partner per date)
//   5. Quick actions (trigger earnings calc, trigger view tracking,
//      jump to /admin/clicks)
//
// Styling mirrors /p/[slug] for brand consistency: dark navy radial
// gradient bg, rounded-2xl cards with white/[0.02] fill + white/10
// borders, pink/violet pill labels, font-wordmark for hero numbers.

import Link from "next/link";
import type { Metadata } from "next";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { formatMetric } from "@/lib/format";
import {
  getLatestAdminActionRuns,
  type AdminActionKey,
  type AdminActionRun,
} from "@/lib/admin-action-runs";
import AdminQuickActions from "./AdminQuickActions";
import AttachTitleButton from "./AttachTitleButton";
import PartnerRow from "./PartnerRow";
import TitleRowControls from "./TitleRowControls";

export const metadata: Metadata = {
  title: "Moonbeem admin",
  robots: { index: false, follow: false },
};

type PartnerSummary = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  title_count: number;
  member_count: number;
};

type TitleRow = {
  id: string;
  slug: string;
  title: string;
  is_active: boolean;
  is_public: boolean;
  partner_name: string | null;
  partner_slug: string | null;
  fan_edit_count: number;
  total_views: number;
};

type CatalogCounts = {
  total_titles: number;
  partnered_titles: number;
};

type WithdrawalRow = {
  id: string;
  amount_cents: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  stripe_transfer_id: string | null;
  creator_handle: string | null;
};

type EarningsBucket = {
  partner_name: string;
  partner_slug: string;
  calculation_date: string;
  rows: number;
  earnings_cents: number;
  unique_creators: number;
};

async function loadPartners(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<PartnerSummary[]> {
  const { data: partners } = await supabase
    .from("partners")
    .select("id, slug, name, logo_url")
    .order("name");
  const rows = (partners ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    logo_url: string | null;
  }>;
  if (rows.length === 0) return [];

  const ids = rows.map((p) => p.id);
  const [titlesRes, membersRes] = await Promise.all([
    supabase.from("titles").select("partner_id").in("partner_id", ids),
    supabase
      .from("partner_users")
      .select("partner_id")
      .in("partner_id", ids)
      .is("deleted_at", null),
  ]);
  const titleCount = new Map<string, number>();
  for (const t of titlesRes.data ?? []) {
    const pid = t.partner_id as string;
    titleCount.set(pid, (titleCount.get(pid) ?? 0) + 1);
  }
  const memberCount = new Map<string, number>();
  for (const m of membersRes.data ?? []) {
    const pid = m.partner_id as string;
    memberCount.set(pid, (memberCount.get(pid) ?? 0) + 1);
  }
  return rows.map((p) => ({
    ...p,
    title_count: titleCount.get(p.id) ?? 0,
    member_count: memberCount.get(p.id) ?? 0,
  }));
}

async function loadTitles(
  supabase: ReturnType<typeof createServiceRoleClient>,
  partners: PartnerSummary[],
): Promise<TitleRow[]> {
  // Query partners → titles via partner_id IN (...), not NOT NULL.
  // The titles table is ~1.4M rows; the planner has historically been
  // shaky with NOT NULL filters here (incident 2026-05-08: stale
  // stats caused a parallel seq scan + statement timeout). The IN
  // form is selective on the partial index every time.
  if (partners.length === 0) return [];
  const partnerIds = partners.map((p) => p.id);
  const partnerById = new Map(partners.map((p) => [p.id, p]));

  const { data: titles, error } = await supabase
    .from("titles")
    .select("id, slug, title, partner_id, is_active, is_public")
    .in("partner_id", partnerIds)
    .is("deleted_at", null)
    .order("title");
  if (error) {
    throw new Error(`loadTitles failed: ${error.message}`);
  }
  const rows = (titles ?? []) as Array<{
    id: string;
    slug: string;
    title: string;
    partner_id: string;
    is_active: boolean;
    is_public: boolean;
  }>;
  if (rows.length === 0) return [];

  const ids = rows.map((t) => t.id);
  // Soft-deleted fan_edits excluded from the rollup.
  const { data: edits, error: editsErr } = await supabase
    .from("fan_edits")
    .select("title_id, view_count")
    .in("title_id", ids)
    .is("deleted_at", null);
  if (editsErr) {
    throw new Error(`loadTitles fan_edits agg failed: ${editsErr.message}`);
  }
  const editCount = new Map<string, { c: number; v: number }>();
  for (const e of edits ?? []) {
    const tid = e.title_id as string;
    const acc = editCount.get(tid) ?? { c: 0, v: 0 };
    acc.c += 1;
    acc.v += (e.view_count as number | null) ?? 0;
    editCount.set(tid, acc);
  }
  return rows.map((t) => {
    const partner = partnerById.get(t.partner_id);
    return {
      id: t.id,
      slug: t.slug,
      title: t.title,
      is_active: t.is_active,
      is_public: t.is_public,
      partner_name: partner?.name ?? null,
      partner_slug: partner?.slug ?? null,
      fan_edit_count: editCount.get(t.id)?.c ?? 0,
      total_views: editCount.get(t.id)?.v ?? 0,
    };
  });
}

async function loadCatalogCounts(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<CatalogCounts> {
  // Two cheap counts via head:exact. Total uses a pure count(*); the
  // partnered count uses the partial index on partner_id.
  const [totalRes, partneredRes] = await Promise.all([
    supabase.from("titles").select("id", { count: "exact", head: true }),
    supabase
      .from("titles")
      .select("id", { count: "exact", head: true })
      .not("partner_id", "is", null),
  ]);
  return {
    total_titles: totalRes.count ?? 0,
    partnered_titles: partneredRes.count ?? 0,
  };
}

async function loadRecentWithdrawals(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<WithdrawalRow[]> {
  const { data: ws } = await supabase
    .from("withdrawals")
    .select("id, creator_id, amount_cents, status, created_at, completed_at, stripe_transfer_id")
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (ws ?? []) as Array<{
    id: string;
    creator_id: string;
    amount_cents: number;
    status: string;
    created_at: string;
    completed_at: string | null;
    stripe_transfer_id: string | null;
  }>;
  if (rows.length === 0) return [];

  const creatorIds = Array.from(new Set(rows.map((r) => r.creator_id)));
  const { data: creators } = await supabase
    .from("creators")
    .select("id, moonbeem_handle")
    .in("id", creatorIds);
  const handleById = new Map<string, string>();
  for (const c of creators ?? []) {
    handleById.set(c.id as string, c.moonbeem_handle as string);
  }
  return rows.map((r) => ({
    id: r.id,
    amount_cents: r.amount_cents,
    status: r.status,
    created_at: r.created_at,
    completed_at: r.completed_at,
    stripe_transfer_id: r.stripe_transfer_id,
    creator_handle: handleById.get(r.creator_id) ?? null,
  }));
}

async function loadRecentEarnings(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<EarningsBucket[]> {
  // Last 14 days of calculations, grouped by (partner, date) in JS.
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: rows } = await supabase
    .from("creator_earnings")
    .select(
      "partner_id, calculation_date, earnings_cents, creator_id, partners:partner_id(name, slug)",
    )
    .gte("calculation_date", since)
    .order("calculation_date", { ascending: false });
  const ers = (rows ?? []) as unknown as Array<{
    partner_id: string;
    calculation_date: string;
    earnings_cents: number;
    creator_id: string;
    partners: { name: string; slug: string } | null;
  }>;
  const buckets = new Map<string, EarningsBucket & { creators: Set<string> }>();
  for (const r of ers) {
    const key = `${r.partner_id}::${r.calculation_date}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        partner_name: r.partners?.name ?? "(unknown partner)",
        partner_slug: r.partners?.slug ?? "",
        calculation_date: r.calculation_date,
        rows: 0,
        earnings_cents: 0,
        unique_creators: 0,
        creators: new Set<string>(),
      };
      buckets.set(key, b);
    }
    b.rows += 1;
    b.earnings_cents += r.earnings_cents ?? 0;
    if (r.creator_id) b.creators.add(r.creator_id);
  }
  return Array.from(buckets.values())
    .map((b) => ({
      partner_name: b.partner_name,
      partner_slug: b.partner_slug,
      calculation_date: b.calculation_date,
      rows: b.rows,
      earnings_cents: b.earnings_cents,
      unique_creators: b.creators.size,
    }))
    .sort((a, b) => {
      if (a.calculation_date !== b.calculation_date) {
        return a.calculation_date < b.calculation_date ? 1 : -1;
      }
      return a.partner_name.localeCompare(b.partner_name);
    });
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "failed"
        ? "bg-moonbeem-magenta/20 text-moonbeem-magenta"
        : "bg-white/10 text-moonbeem-ink-muted";
  return (
    <span className={`rounded-full px-2 py-0.5 text-caption ${cls}`}>
      {status}
    </span>
  );
}

function SectionHeader({
  pill,
  pillTone = "pink",
  title,
  hint,
}: {
  pill: string;
  pillTone?: "pink" | "violet";
  title: string;
  hint?: string;
}) {
  const pillCls =
    pillTone === "violet"
      ? "bg-moonbeem-violet/20 text-moonbeem-violet-soft"
      : "bg-moonbeem-pink/15 text-moonbeem-pink";
  return (
    <div className="mb-4 flex items-center gap-3">
      <span
        className={`rounded-full px-2.5 py-0.5 text-caption font-medium ${pillCls}`}
      >
        {pill}
      </span>
      <span className="text-caption text-moonbeem-ink-subtle">{title}</span>
      {hint && (
        <span className="text-caption text-moonbeem-ink-subtle">· {hint}</span>
      )}
    </div>
  );
}

// Open title requests across the platform — surfaced on the
// /admin Quick actions row as a card-level operational signal.
// Counts request ROWS (not distinct titles). Open = fulfilled_at IS NULL.
async function loadOpenRequestCount(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<number> {
  const { count } = await supabase
    .from("title_requests")
    .select("id", { count: "exact", head: true })
    .eq("request_type", "fan_edits")
    .is("fulfilled_at", null);
  return count ?? 0;
}

export default async function AdminLanding() {
  await requireSuperAdminOr404();
  const supabase = createServiceRoleClient();

  const partners = await loadPartners(supabase);
  const [
    titles,
    catalogCounts,
    withdrawals,
    earnings,
    latestRunsMap,
    openRequestCount,
  ] = await Promise.all([
    loadTitles(supabase, partners),
    loadCatalogCounts(supabase),
    loadRecentWithdrawals(supabase),
    loadRecentEarnings(supabase),
    getLatestAdminActionRuns([
      "earnings_calculate",
      "view_tracking_trigger",
    ]),
    loadOpenRequestCount(supabase),
  ]);
  const lastRuns: Partial<Record<AdminActionKey, AdminActionRun>> = {};
  for (const [k, v] of latestRunsMap) lastRuns[k] = v;

  return (
    <div className="min-h-screen px-6 py-12 bg-[radial-gradient(ellipse_at_top,_#1a0f3a_0%,_#0a0a14_60%)]">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between">
          <span className="font-wordmark text-heading-md text-moonbeem-pink">
            moonbeem.
          </span>
          <span className="text-body-sm text-moonbeem-ink-subtle">
            Internal admin
          </span>
        </div>

        <div className="mt-10 flex flex-col gap-2">
          <h1 className="font-wordmark text-display-lg text-moonbeem-ink m-0">
            Moonbeem admin
          </h1>
          <p className="text-body text-moonbeem-ink-muted m-0">
            All partners, all titles, all earnings · super-admin view
          </p>
        </div>

        {/* Quick actions */}
        <div className="mt-10">
          <SectionHeader
            pill="Quick actions"
            pillTone="violet"
            title="ops triggers"
          />
          <AdminQuickActions
            lastRuns={lastRuns}
            openRequestCount={openRequestCount}
          />
        </div>

        {/* Partners */}
        <div className="mt-10">
          <div className="mb-4 flex items-center justify-between gap-3">
            <SectionHeader
              pill="Partners"
              title={`${partners.length} ${partners.length === 1 ? "partner" : "partners"}`}
            />
            <Link
              href="/admin/marquee"
              className="rounded-md border border-white/10 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
            >
              Curate marquee →
            </Link>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            {partners.length === 0 ? (
              <p className="text-body-sm text-moonbeem-ink-muted">
                No partners yet.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-white/5">
                {partners.map((p) => (
                  <PartnerRow key={p.id} {...p} />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Titles */}
        <div className="mt-10">
          <div className="mb-4 flex items-center justify-between gap-3">
            <SectionHeader
              pill="Titles"
              title={`${titles.length} partnered`}
              hint={`${catalogCounts.total_titles.toLocaleString()} titles in catalog · ${catalogCounts.partnered_titles} with partner`}
            />
            <div className="flex items-center gap-3">
              <Link
                href="/admin/featured"
                className="rounded-md border border-white/10 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
              >
                Curate featured →
              </Link>
              <AttachTitleButton />
            </div>
          </div>
          {titles.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <p className="text-body-sm text-moonbeem-ink-muted">
                No partner-attached titles yet. Attach a title to a partner via{" "}
                <code className="font-mono">titles.partner_id</code>.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {titles.map((t) => (
                <TitleRowControls
                  key={t.id}
                  slug={t.slug}
                  title={t.title}
                  initialIsActive={t.is_active}
                  initialIsPublic={t.is_public}
                  partnerName={t.partner_name}
                  partnerSlug={t.partner_slug}
                  fanEditCount={t.fan_edit_count}
                  totalViews={t.total_views}
                  totalViewsFormatted={formatMetric(t.total_views)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Withdrawals */}
        <div className="mt-10">
          <SectionHeader
            pill="Withdrawals"
            title="last 50 across all creators"
          />
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
            {withdrawals.length === 0 ? (
              <p className="p-5 text-body-sm text-moonbeem-ink-muted">
                No withdrawals yet.
              </p>
            ) : (
              <table className="w-full text-body-sm">
                <thead className="border-b border-white/5 text-caption uppercase tracking-wider text-moonbeem-ink-subtle">
                  <tr>
                    <th className="px-5 py-3 text-left">When</th>
                    <th className="px-5 py-3 text-left">Creator</th>
                    <th className="px-5 py-3 text-right">Amount</th>
                    <th className="px-5 py-3 text-left">Status</th>
                    <th className="px-5 py-3 text-left">Stripe transfer</th>
                  </tr>
                </thead>
                <tbody>
                  {withdrawals.map((w) => (
                    <tr
                      key={w.id}
                      className="border-b border-white/5 last:border-b-0"
                    >
                      <td className="px-5 py-3 text-moonbeem-ink-muted">
                        {new Date(w.created_at).toLocaleString()}
                      </td>
                      <td className="px-5 py-3">
                        {w.creator_handle ? (
                          <Link
                            href={`/c/${w.creator_handle}`}
                            className="text-moonbeem-ink hover:text-moonbeem-pink"
                          >
                            @{w.creator_handle}
                          </Link>
                        ) : (
                          <span className="text-moonbeem-ink-subtle">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums font-medium text-moonbeem-ink">
                        {dollars(w.amount_cents)}
                      </td>
                      <td className="px-5 py-3">
                        <StatusPill status={w.status} />
                      </td>
                      <td className="px-5 py-3 font-mono text-caption text-moonbeem-ink-subtle">
                        {w.stripe_transfer_id ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Earnings */}
        <div className="mt-10">
          <SectionHeader
            pill="Earnings"
            title="last 14 days · grouped by partner + date"
          />
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
            {earnings.length === 0 ? (
              <p className="p-5 text-body-sm text-moonbeem-ink-muted">
                No earnings calculations in the last 14 days.
              </p>
            ) : (
              <table className="w-full text-body-sm">
                <thead className="border-b border-white/5 text-caption uppercase tracking-wider text-moonbeem-ink-subtle">
                  <tr>
                    <th className="px-5 py-3 text-left">Date</th>
                    <th className="px-5 py-3 text-left">Partner</th>
                    <th className="px-5 py-3 text-right">Rows</th>
                    <th className="px-5 py-3 text-right">Creators</th>
                    <th className="px-5 py-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {earnings.map((b) => (
                    <tr
                      key={`${b.partner_slug}::${b.calculation_date}`}
                      className="border-b border-white/5 last:border-b-0"
                    >
                      <td className="px-5 py-3 text-moonbeem-ink-muted tabular-nums">
                        {b.calculation_date}
                      </td>
                      <td className="px-5 py-3">
                        {b.partner_slug ? (
                          <Link
                            href={`/p/${b.partner_slug}/dashboard`}
                            className="text-moonbeem-ink hover:text-moonbeem-pink"
                          >
                            {b.partner_name}
                          </Link>
                        ) : (
                          b.partner_name
                        )}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-moonbeem-ink-muted">
                        {b.rows}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-moonbeem-ink-muted">
                        {b.unique_creators}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums font-medium text-moonbeem-ink">
                        {dollars(b.earnings_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
