// campaign-metering Edge Function — Campaigns v1 (3c.2, Part B).
//
// The metering job. Once per cron tick (daily at 03:00 UTC, scheduled
// in Part C), this function picks ONE campaign — the oldest funded
// eligible campaign with positive pool — and runs two passes:
//
//   Pass 1 — insert metering rows for new snapshots. Every
//     view_tracking_snapshots row captured at or after the campaign's
//     funded_at, for every fan_edit of every title in
//     campaign_titles, that doesn't already have a
//     campaign_metering_deltas row for this campaign, becomes a new
//     'unsettled' delta. delta_views is computed against the
//     immediately-preceding in-window snapshot for the same fan_edit
//     (so the BASELINE — the campaign's first snapshot for that
//     fan_edit — has prior_snapshot_id NULL, delta_views 0,
//     full_cpm_cents 0). full_cpm_cents is computed at the campaign's
//     own cpm_rate_cents, never partner_title_rates. settles_at is
//     appeared_at + campaigns.settling_days.
//
//   Pass 2 — settle and bill. Flip every 'unsettled' row whose
//     settles_at has passed to 'settled'. Filter the campaign's
//     'settled' rows to those with full_cpm_cents > 0 (baseline /
//     zero-delta rows just sit), compute total_wanted, compare
//     against the campaign's pool, decide pro-rata:
//       total_wanted <= pool  -> factor = null (no pro-rata; the RPC
//                                receives 1.0 and bills full CPM)
//       total_wanted >  pool  -> factor = pool / total_wanted (< 1)
//     Order rows by appeared_at ASC (a natural FIFO inside the
//     campaign), and for each one call bill_settled_delta(...). The
//     RPC is the only path that writes campaign-tagged
//     creator_earnings; the function never writes that table
//     directly. Per-row errors from the RPC log loudly but do NOT
//     abort the run — the run continues with the next delta.
//
//     Defensive: if pool starts <= 0 (pool already drained by prior
//     runs but the campaign hasn't been flipped to 'completed' yet —
//     3c.3's job), OR if pool reaches 0 mid-loop (shouldn't with a
//     correct factor, but the floor() math keeps a few cents in
//     reserve), VOID all remaining 'settled' rows for the campaign
//     in this same run. Zero-rounded sub-rows (where
//     floor(full_cpm * factor) <= 0 for very small full_cpm under a
//     tiny factor) are skipped — they stay 'settled' and will be
//     cleaned up by the next run (when pool is 0) or by 3c.3 on
//     campaign completion.
//
// ATTRIBUTION — FIFO by campaigns.funded_at. ONE campaign per
// invocation. Pre-filter: oldest funded eligible campaign with
// positive ledger pool — skipping pool-exhausted campaigns lets a
// younger campaign process while 3c.3 isn't built yet. Eligibility:
// campaigns.status IN ('funded', 'live'). 'paused' and 'completed'
// excluded.
//
// RUN LIFECYCLE — one campaign_metering_runs row per invocation.
// Inserted with status='running' at the top; updated with the
// pro-rata factor early (crash resilience); finalized at the end
// with status='completed', the final counts, and
// pool_remaining_after_cents. pool_remaining_after_cents is
// re-read from the campaign_ledger SUM after the loop, so it is
// authoritative regardless of in-loop tracker drift (the in-loop
// poolRemaining tracker is used ONLY for the mid-loop "should we
// stop and void?" defense). A thrown exception mid-run flips the
// run to status='failed' with error_message before re-raising.
//
// AUTH — relies on Supabase Edge platform's default JWT verification.
// pg_cron (Part C) calls with the service_role key; the platform
// authenticates the request, and this function runs with full
// service-role access via the supabase-js client. The RPC
// (bill_settled_delta) is granted to service_role only, also
// verified separately.
//
// SCOPE — this function only METERS. It does NOT:
//   - flip campaign status (funded -> live, live -> completed) —
//     that's 3c.3.
//   - write partner_credits — that's 3c.3.
//   - touch the creator withdraw rail — never.

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.45.0";

// Mirror the legacy earnings-calc fan_edit eligibility filters — the
// metering job should bill the same set of edits the legacy engine
// would treat as earnable on a title. Inlined (not imported from
// `@/lib/fan-edits/status`) because Edge Functions cannot resolve
// the Next.js path alias.
const PUBLICLY_READABLE_FAN_EDIT_STATUSES = [
  "auto_verified",
  "approved",
] as const;

function getEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Campaign = {
  id: string;
  partner_id: string;
  funded_at: string;
  cpm_rate_cents: number;
  settling_days: number;
};

type Snapshot = {
  id: string;
  fan_edit_id: string;
  captured_at: string;
  view_count: number | null;
};

type SettledRow = {
  id: string;
  fan_edit_id: string;
  full_cpm_cents: number;
};

type FanEditMeta = { creator_id: string | null; title_id: string };

// ---------------------------------------------------------------
// Setup — pick the target campaign.
// ---------------------------------------------------------------
// Oldest funded eligible campaign with positive ledger pool. Walks
// campaigns in funded_at ASC and returns the first whose
// SUM(campaign_ledger.amount_cents) > 0. Pool-exhausted campaigns
// (pool <= 0 but not yet 'completed') are skipped so a younger
// campaign can advance — useful before 3c.3 wires the lifecycle.

async function pickTargetCampaign(
  supabase: SupabaseClient,
): Promise<{ campaign: Campaign; poolRemaining: number } | null> {
  const { data: campaigns, error: cErr } = await supabase
    .from("campaigns")
    .select("id, partner_id, funded_at, cpm_rate_cents, settling_days")
    .in("status", ["funded", "live"])
    .not("funded_at", "is", null)
    .order("funded_at", { ascending: true });
  if (cErr) {
    throw new Error(`pickTargetCampaign campaigns: ${cErr.message}`);
  }
  for (const c of (campaigns ?? []) as Campaign[]) {
    const pool = await campaignPoolRemaining(supabase, c.id);
    if (pool > 0) {
      return { campaign: c, poolRemaining: pool };
    }
  }
  return null;
}

async function campaignPoolRemaining(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<number> {
  // No GROUP BY aggregate in supabase-js without an RPC; sum in JS.
  // Per-campaign ledger row count is small (funding + per-delta
  // debits), so paging isn't required at realistic scale.
  const { data, error } = await supabase
    .from("campaign_ledger")
    .select("amount_cents")
    .eq("campaign_id", campaignId);
  if (error) {
    throw new Error(`campaignPoolRemaining: ${error.message}`);
  }
  return (data ?? []).reduce(
    (s: number, r: { amount_cents: number | null }) =>
      s + (r.amount_cents ?? 0),
    0,
  );
}

// ---------------------------------------------------------------
// Run row lifecycle.
// ---------------------------------------------------------------

async function startRun(
  supabase: SupabaseClient,
  campaignId: string,
  poolBefore: number,
): Promise<string> {
  const { data, error } = await supabase
    .from("campaign_metering_runs")
    .insert({
      campaign_id: campaignId,
      pool_remaining_before_cents: poolBefore,
      status: "running",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `startRun: ${error?.message ?? "insert returned no row"}`,
    );
  }
  return data.id as string;
}

async function stampRunFactor(
  supabase: SupabaseClient,
  runId: string,
  factor: number | null,
): Promise<void> {
  const { error } = await supabase
    .from("campaign_metering_runs")
    .update({ prorata_factor: factor })
    .eq("id", runId);
  if (error) throw new Error(`stampRunFactor: ${error.message}`);
}

async function completeRun(
  supabase: SupabaseClient,
  runId: string,
  fields: {
    rows_billed: number;
    total_billed_cents: number;
    pool_remaining_after_cents: number;
  },
): Promise<void> {
  const { error } = await supabase
    .from("campaign_metering_runs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      ...fields,
    })
    .eq("id", runId);
  if (error) throw new Error(`completeRun: ${error.message}`);
}

async function failRun(
  supabase: SupabaseClient,
  runId: string,
  errorMessage: string,
): Promise<void> {
  const { error } = await supabase
    .from("campaign_metering_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq("id", runId);
  if (error) {
    // Best-effort — the run-level catch will log this too.
    console.error(`failRun: ${error.message}`);
  }
}

// ---------------------------------------------------------------
// Pass 1 — insert metering rows for new snapshots.
// ---------------------------------------------------------------

async function pass1InsertDeltas(
  supabase: SupabaseClient,
  campaign: Campaign,
): Promise<number> {
  // 1. The campaign's titles.
  const { data: titlesRows, error: tErr } = await supabase
    .from("campaign_titles")
    .select("title_id")
    .eq("campaign_id", campaign.id);
  if (tErr) throw new Error(`Pass1 campaign_titles: ${tErr.message}`);
  const titleIds = (titlesRows ?? []).map(
    (r: { title_id: string }) => r.title_id,
  );
  if (titleIds.length === 0) return 0;

  // 2. The fan_edits on those titles that meet legacy-earnings
  //    eligibility — publicly readable, active, not soft-deleted,
  //    attributed to a creator. The metering job bills the same set
  //    the legacy earnings engine would, modulo campaign attribution.
  const { data: fanEdits, error: feErr } = await supabase
    .from("fan_edits")
    .select("id")
    .in("title_id", titleIds)
    .eq("is_active", true)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null)
    .not("creator_id", "is", null);
  if (feErr) throw new Error(`Pass1 fan_edits: ${feErr.message}`);
  const fanEditIds = (fanEdits ?? []).map(
    (r: { id: string }) => r.id,
  );
  if (fanEditIds.length === 0) return 0;

  // 3. All snapshots for these fan_edits captured at or after the
  //    campaign's funded_at, paginated + chunked by IN-list size.
  const snapshots = await fetchSnapshotsForFanEditsSince(
    supabase,
    fanEditIds,
    campaign.funded_at,
  );
  if (snapshots.length === 0) return 0;

  // 4. The set of snapshot_ids already metered for this campaign —
  //    so we don't re-insert (the UNIQUE index would block us
  //    anyway, but pre-filtering means a single clean batch INSERT).
  const meteredSnapshotIds = await fetchMeteredSnapshotIds(
    supabase,
    campaign.id,
  );

  // 5. Sort by (fan_edit_id, captured_at ASC) so we can walk each
  //    fan_edit chronologically and compute deltas against the
  //    immediately-preceding in-window snapshot.
  snapshots.sort((a, b) => {
    if (a.fan_edit_id !== b.fan_edit_id) {
      return a.fan_edit_id < b.fan_edit_id ? -1 : 1;
    }
    return new Date(a.captured_at).getTime() -
      new Date(b.captured_at).getTime();
  });

  type DeltaInsert = {
    campaign_id: string;
    fan_edit_id: string;
    snapshot_id: string;
    prior_snapshot_id: string | null;
    delta_views: number;
    full_cpm_cents: number;
    appeared_at: string;
    settles_at: string;
  };
  const inserts: DeltaInsert[] = [];
  // priorByEdit tracks the chronologically-immediate predecessor
  // snapshot for each fan_edit as we walk. Updated for EVERY
  // snapshot (whether newly-inserted or already-metered) so a new
  // snapshot's prior can be a previously-metered one.
  const priorByEdit = new Map<
    string,
    { id: string; view_count: number }
  >();
  const settleMs = campaign.settling_days * 24 * 60 * 60 * 1000;

  for (const s of snapshots) {
    const prior = priorByEdit.get(s.fan_edit_id) ?? null;
    if (!meteredSnapshotIds.has(s.id)) {
      const currentViews = s.view_count ?? 0;
      const priorViews = prior?.view_count ?? 0;
      // Baseline (no prior in-window snapshot): delta = 0.
      // Otherwise delta = max(0, current - prior).
      const deltaViews = prior
        ? Math.max(0, currentViews - priorViews)
        : 0;
      const fullCpm = Math.floor(
        (deltaViews / 1000) * campaign.cpm_rate_cents,
      );
      const settlesAt = new Date(
        new Date(s.captured_at).getTime() + settleMs,
      ).toISOString();
      inserts.push({
        campaign_id: campaign.id,
        fan_edit_id: s.fan_edit_id,
        snapshot_id: s.id,
        prior_snapshot_id: prior?.id ?? null,
        delta_views: deltaViews,
        full_cpm_cents: fullCpm,
        appeared_at: s.captured_at,
        settles_at: settlesAt,
        // status defaults to 'unsettled'
      });
    }
    priorByEdit.set(s.fan_edit_id, {
      id: s.id,
      view_count: s.view_count ?? 0,
    });
  }

  if (inserts.length === 0) return 0;

  // Bulk insert. The UNIQUE (campaign_id, fan_edit_id, snapshot_id)
  // index is the idempotency backstop; pre-filtering above is the
  // efficiency path.
  const { error: insErr } = await supabase
    .from("campaign_metering_deltas")
    .insert(inserts);
  if (insErr) throw new Error(`Pass1 insert: ${insErr.message}`);
  return inserts.length;
}

async function fetchSnapshotsForFanEditsSince(
  supabase: SupabaseClient,
  fanEditIds: string[],
  sinceISO: string,
): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  const chunkSize = 500;
  const pageSize = 1000;
  for (let i = 0; i < fanEditIds.length; i += chunkSize) {
    const chunk = fanEditIds.slice(i, i + chunkSize);
    for (let from = 0;; from += pageSize) {
      const { data, error } = await supabase
        .from("view_tracking_snapshots")
        .select("id, fan_edit_id, captured_at, view_count")
        .in("fan_edit_id", chunk)
        .gte("captured_at", sinceISO)
        .order("captured_at", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) {
        throw new Error(`fetchSnapshots: ${error.message}`);
      }
      if (!data || data.length === 0) break;
      out.push(...(data as Snapshot[]));
      if (data.length < pageSize) break;
    }
  }
  return out;
}

async function fetchMeteredSnapshotIds(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const pageSize = 1000;
  for (let from = 0;; from += pageSize) {
    const { data, error } = await supabase
      .from("campaign_metering_deltas")
      .select("snapshot_id")
      .eq("campaign_id", campaignId)
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`fetchMeteredSnapshotIds: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    for (const r of data as { snapshot_id: string }[]) {
      out.add(r.snapshot_id);
    }
    if (data.length < pageSize) break;
  }
  return out;
}

// ---------------------------------------------------------------
// Pass 2 — settle and bill.
// ---------------------------------------------------------------

async function flipMaturedToSettled(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<void> {
  const nowISO = new Date().toISOString();
  const { error } = await supabase
    .from("campaign_metering_deltas")
    .update({ status: "settled" })
    .eq("campaign_id", campaignId)
    .eq("status", "unsettled")
    .lte("settles_at", nowISO);
  if (error) throw new Error(`flipMaturedToSettled: ${error.message}`);
}

type Pass2Result = {
  rowsBilled: number;
  totalBilledCents: number;
  factor: number | null;
  factorForRpc: number;
  poolAfter: number;
  poolExhausted: boolean;
  rpcErrors: Array<{ delta_id: string; error: string }>;
  rowsSkippedRounding: number;
  rowsSkippedOrphan: number;
};

async function pass2BillSettled(
  supabase: SupabaseClient,
  campaign: Campaign,
  runId: string,
  poolBefore: number,
): Promise<Pass2Result> {
  // Pull positive-value settled rows for this campaign, oldest
  // appeared_at first (FIFO within the campaign).
  const { data: settled, error } = await supabase
    .from("campaign_metering_deltas")
    .select("id, fan_edit_id, full_cpm_cents")
    .eq("campaign_id", campaign.id)
    .eq("status", "settled")
    .gt("full_cpm_cents", 0)
    .order("appeared_at", { ascending: true });
  if (error) throw new Error(`Pass2 select: ${error.message}`);
  const rows = (settled ?? []) as SettledRow[];

  // Pool already drained (or about to be) — no money to bill;
  // caller will void all 'settled' rows for the campaign.
  if (poolBefore <= 0) {
    return {
      rowsBilled: 0,
      totalBilledCents: 0,
      factor: null,
      factorForRpc: 1.0,
      poolAfter: poolBefore,
      poolExhausted: true,
      rpcErrors: [],
      rowsSkippedRounding: 0,
      rowsSkippedOrphan: 0,
    };
  }

  // Nothing settled and positive — clean no-op for this campaign.
  if (rows.length === 0) {
    return {
      rowsBilled: 0,
      totalBilledCents: 0,
      factor: null,
      factorForRpc: 1.0,
      poolAfter: poolBefore,
      poolExhausted: false,
      rpcErrors: [],
      rowsSkippedRounding: 0,
      rowsSkippedOrphan: 0,
    };
  }

  const totalWanted = rows.reduce(
    (s, r) => s + (r.full_cpm_cents ?? 0),
    0,
  );
  // factor: null in the run row (and 1.0 to the RPC) when no
  // pro-rata; < 1 when pro-rata triggered.
  const isProrata = totalWanted > poolBefore;
  const factor = isProrata ? poolBefore / totalWanted : null;
  const factorForRpc = factor ?? 1.0;

  // Stamp the factor on the run row early — if the run crashes
  // mid-loop, an operator can still see what factor was in play.
  await stampRunFactor(supabase, runId, factor);

  // Pre-fetch creator_id / title_id for every fan_edit in the
  // settled set so the bill loop doesn't round-trip per row.
  const fanEditIds = Array.from(new Set(rows.map((r) => r.fan_edit_id)));
  const fanEdits = await fetchFanEditMeta(supabase, fanEditIds);

  let poolRemaining = poolBefore;
  let rowsBilled = 0;
  let totalBilledCents = 0;
  let poolExhausted = false;
  let rowsSkippedRounding = 0;
  let rowsSkippedOrphan = 0;
  const rpcErrors: Array<{ delta_id: string; error: string }> = [];

  for (const row of rows) {
    // Defensive — should not trigger in normal pro-rata math
    // (floor() leaves a few cents in the pool), but if the pool
    // somehow hits 0 mid-loop, stop and void the rest.
    if (poolRemaining <= 0) {
      poolExhausted = true;
      break;
    }

    const billedCents = Math.floor(row.full_cpm_cents * factorForRpc);
    if (billedCents <= 0) {
      // Sub-row rounded to 0 (small full_cpm under a tiny factor).
      // Skip — the RPC would raise 'prorata_yields_zero'. The row
      // stays 'settled' until the next run or 3c.3 voids it.
      rowsSkippedRounding += 1;
      console.warn(
        `[campaign-metering] skipping delta=${row.id}: floor(${row.full_cpm_cents} * ${factorForRpc}) <= 0`,
      );
      continue;
    }

    const fe = fanEdits.get(row.fan_edit_id);
    if (!fe || !fe.creator_id) {
      // DATA ANOMALY — Pass 1's `creator_id IS NOT NULL` filter
      // means a metering row should never be inserted for a
      // fan_edit without a creator_id. Reaching this branch at
      // Pass 2 time means the creator_id was cleared AFTER
      // metering, or a metering row was inserted by some other
      // path. Skip — do NOT abort the run — but log at error
      // level so the signal is loud.
      rowsSkippedOrphan += 1;
      console.error(
        `[campaign-metering] DATA ANOMALY: delta=${row.id} skipped because fan_edit=${row.fan_edit_id} has no creator_id; Pass 1's filter should have excluded this`,
      );
      continue;
    }

    try {
      const { error: rpcErr } = await supabase.rpc(
        "bill_settled_delta",
        {
          p_metering_delta_id: row.id,
          p_prorata_run_id: runId,
          p_prorata_factor: factorForRpc,
          p_creator_id: fe.creator_id,
          p_partner_id: campaign.partner_id,
          p_title_id: fe.title_id,
        },
      );
      if (rpcErr) throw rpcErr;

      rowsBilled += 1;
      totalBilledCents += billedCents;
      poolRemaining -= billedCents;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[campaign-metering] RPC bill_settled_delta failed for delta=${row.id}: ${msg}`,
      );
      rpcErrors.push({ delta_id: row.id, error: msg });
      // Continue with the next delta — do NOT abort the run on a
      // single bad row.
    }
  }

  return {
    rowsBilled,
    totalBilledCents,
    factor,
    factorForRpc,
    poolAfter: poolRemaining,
    poolExhausted,
    rpcErrors,
    rowsSkippedRounding,
    rowsSkippedOrphan,
  };
}

async function fetchFanEditMeta(
  supabase: SupabaseClient,
  fanEditIds: string[],
): Promise<Map<string, FanEditMeta>> {
  const out = new Map<string, FanEditMeta>();
  const chunkSize = 500;
  for (let i = 0; i < fanEditIds.length; i += chunkSize) {
    const chunk = fanEditIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("fan_edits")
      .select("id, creator_id, title_id")
      .in("id", chunk);
    if (error) throw new Error(`fetchFanEditMeta: ${error.message}`);
    for (
      const r of (data ?? []) as Array<
        { id: string; creator_id: string | null; title_id: string }
      >
    ) {
      out.set(r.id, { creator_id: r.creator_id, title_id: r.title_id });
    }
  }
  return out;
}

async function voidRemainingSettled(
  supabase: SupabaseClient,
  campaignId: string,
  runId: string,
): Promise<number> {
  // 'billed' rows from this run are already non-'settled'; only
  // un-billed 'settled' rows match. zero-full_cpm rows would also
  // match here, but on the void path we WANT to clean them up
  // (the campaign is over, in effect).
  //
  // Idempotent: a second call after a successful void finds zero
  // rows still 'settled' (all are now 'voided') and returns 0.
  // The WHERE status='settled' filter is the idempotency guard;
  // calling this twice is intentionally safe.
  const { data, error } = await supabase
    .from("campaign_metering_deltas")
    .update({
      status: "voided",
      prorata_run_id: runId,
    })
    .eq("campaign_id", campaignId)
    .eq("status", "settled")
    .select("id");
  if (error) throw new Error(`voidRemainingSettled: ${error.message}`);
  return (data ?? []).length;
}

// ---------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------

Deno.serve(async (_req: Request) => {
  const startTime = Date.now();

  let supabase: SupabaseClient | null = null;
  let runId: string | null = null;
  let targetCampaignId: string | null = null;

  try {
    supabase = createClient(
      getEnv("SUPABASE_URL"),
      getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const target = await pickTargetCampaign(supabase);
    if (!target) {
      console.log(
        "[campaign-metering] no eligible campaign with positive pool",
      );
      return jsonResponse({
        ok: true,
        no_eligible_campaign: true,
        duration_ms: Date.now() - startTime,
      });
    }
    targetCampaignId = target.campaign.id;
    console.log(
      `[campaign-metering] target campaign=${target.campaign.id} pool=${target.poolRemaining}`,
    );

    runId = await startRun(
      supabase,
      target.campaign.id,
      target.poolRemaining,
    );

    // Pass 1 — insert metering rows for new snapshots.
    const rowsInserted = await pass1InsertDeltas(supabase, target.campaign);
    console.log(
      `[campaign-metering] Pass 1: inserted ${rowsInserted} metering rows`,
    );

    // Flip matured rows. (Includes any newly-inserted rows whose
    // settles_at is already in the past — retroactive billing on
    // historical snapshots.)
    await flipMaturedToSettled(supabase, target.campaign.id);

    // Pass 2 — bill settled rows.
    const result = await pass2BillSettled(
      supabase,
      target.campaign,
      runId,
      target.poolRemaining,
    );
    console.log(
      `[campaign-metering] Pass 2: rows_billed=${result.rowsBilled} total_billed_cents=${result.totalBilledCents} factor=${result.factor} pool_after=${result.poolAfter} exhausted=${result.poolExhausted} skipped_rounding=${result.rowsSkippedRounding} skipped_orphan=${result.rowsSkippedOrphan} rpc_errors=${result.rpcErrors.length}`,
    );

    let rowsVoided = 0;
    if (result.poolExhausted) {
      rowsVoided = await voidRemainingSettled(
        supabase,
        target.campaign.id,
        runId,
      );
      console.log(
        `[campaign-metering] pool exhausted; voided ${rowsVoided} remaining settled rows`,
      );
    }

    // Authoritative pool — re-read from the campaign_ledger SUM
    // after all the run's writes have landed. The in-loop
    // result.poolAfter is a JS-tracker mirror used only for the
    // mid-loop "should we stop and void?" defense; the value
    // recorded on the run row and reported in the response is
    // the ledger truth, so floor-rounding cents or tracker drift
    // never leak into reporting.
    const poolAfter = await campaignPoolRemaining(
      supabase,
      target.campaign.id,
    );

    await completeRun(supabase, runId, {
      rows_billed: result.rowsBilled,
      total_billed_cents: result.totalBilledCents,
      pool_remaining_after_cents: poolAfter,
    });

    return jsonResponse({
      ok: true,
      run_id: runId,
      campaign_id: target.campaign.id,
      rows_inserted: rowsInserted,
      rows_billed: result.rowsBilled,
      total_billed_cents: result.totalBilledCents,
      prorata_factor: result.factor,
      pool_remaining_before_cents: target.poolRemaining,
      pool_remaining_after_cents: poolAfter,
      pool_exhausted: result.poolExhausted,
      rows_voided: rowsVoided,
      rows_skipped_rounding: result.rowsSkippedRounding,
      rows_skipped_orphan: result.rowsSkippedOrphan,
      rpc_errors: result.rpcErrors,
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[campaign-metering] fatal:", msg);
    if (supabase && runId) {
      await failRun(supabase, runId, msg);
    }
    return jsonResponse(
      {
        ok: false,
        run_id: runId,
        campaign_id: targetCampaignId,
        duration_ms: Date.now() - startTime,
        error_message: msg,
      },
      500,
    );
  }
});
