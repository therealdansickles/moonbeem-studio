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
// LIFECYCLE TRANSITIONS — this function also flips the picked
// campaign's status on its own write paths, AFTER Pass 2 and AFTER
// any voiding, BEFORE the run row is finalized:
//   funded -> live      when rowsBilled > 0 AND status='funded'
//                       (the campaign just paid its first creator
//                       earnings this run; launched_at stamped).
//   live  -> completed  when pool_remaining_after == 0 (strict
//                       zero — the metering run drained the pool).
//                       completed_at stamped.
// The two transitions are mutually exclusive — pool == 0 wins if
// both conditions could apply (a one-shot funded->completed jump
// is possible if a campaign's first ever bill exhausts its pool
// in the same run). Both UPDATEs carry status guards in their
// WHERE clauses so a campaign that concurrently transitioned via
// another path (e.g. a future admin-UI rollover) cannot be re-
// flipped here.
//
// LIFECYCLE — partner_credits is NOT written here, even on
// completion. The metering job's completion path triggers at
// strict pool == 0, which has nothing to roll over by definition.
// write_partner_credit_for_campaign is reserved for the manual-
// completion path — an admin ending a campaign early with a
// positive remaining pool. Two different completion paths, one
// table flip each.
//
// LIFECYCLE — unexpected statuses ('paused', 'completed',
// 'draft') log loudly and no-op. They shouldn't reach this code
// (selectEligibleCampaigns filters to 'funded'/'live'), but if they
// do — a concurrent admin override between selectEligibleCampaigns
// and the lifecycle step — the run continues gracefully.
//
// AUTH — relies on Supabase Edge platform's default JWT verification.
// pg_cron (Part C) calls with the service_role key; the platform
// authenticates the request, and this function runs with full
// service-role access via the supabase-js client. The RPCs
// (bill_settled_delta, write_partner_credit_for_campaign in the
// future admin path) are granted to service_role only, also
// verified separately.
//
// SCOPE — this function meters and flips lifecycle status on its
// own write paths. It does NOT:
//   - write partner_credits — rollover is a separate manual-
//     completion path. The strict-zero completion path here has
//     nothing to roll over.
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

// Wall-clock budget for one meter-all invocation. The binding platform
// ceiling is the 150s request idle timeout (the function must respond
// within 150s; the 400s worker max only applies to background tasks,
// which this function does not use). The budget is checked BETWEEN
// campaigns, so when it trips the overshoot is bounded by ONE more
// campaign's duration — a heavy campaign billing hundreds of deltas at
// ~30-40ms/RPC is ~10-20s. 90s budget + worst-case ~20s overshoot +
// response serialization stays comfortably under 150s. At realistic
// campaign counts a full sweep is a few seconds, so this never fires —
// it is a pure backstop. When a run first reports budget_exhausted, that
// is the signal to add a resume cursor + self-re-invocation (deferred).
const BUDGET_MS = 90_000;

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
  status: string;
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
  // appeared_at is the deterministic secondary tiebreak (after
  // remainder) for largest-remainder leftover-cent assignment, and
  // the FIFO order the select already imposes.
  appeared_at: string;
};

type FanEditMeta = { creator_id: string | null; title_id: string };

// ---------------------------------------------------------------
// Setup — select ALL eligible campaigns.
// ---------------------------------------------------------------
// Every funded/live campaign with a positive ledger pool, ordered
// funded_at ASC then id ASC. The handler meters the whole set in one
// invocation (3c-fairness), so a campaign with pool>0 but no billable
// edits can no longer head-of-line-block younger campaigns the way the
// old one-per-run pick did. The (funded_at, id) order is deterministic
// so a budget-stopped run resumes in a stable order, and same-instant-
// funded campaigns never reorder between runs.
//
// Pool is computed per-campaign (N+1 against campaign_ledger). That's
// fine at realistic campaign counts; a GROUP BY RPC is an optional
// later optimization. Pool-exhausted campaigns (<=0) are filtered here;
// a campaign that drains to 0 mid-run is already 'completed' by its own
// iteration and excluded from the NEXT run's query.

async function selectEligibleCampaigns(
  supabase: SupabaseClient,
): Promise<Array<{ campaign: Campaign; poolRemaining: number }>> {
  const { data: campaigns, error: cErr } = await supabase
    .from("campaigns")
    .select(
      "id, partner_id, funded_at, cpm_rate_cents, settling_days, status",
    )
    .in("status", ["funded", "live"])
    .not("funded_at", "is", null)
    .order("funded_at", { ascending: true })
    .order("id", { ascending: true });
  if (cErr) {
    throw new Error(`selectEligibleCampaigns: ${cErr.message}`);
  }
  const eligible: Array<{ campaign: Campaign; poolRemaining: number }> = [];
  for (const c of (campaigns ?? []) as Campaign[]) {
    const pool = await campaignPoolRemaining(supabase, c.id);
    if (pool > 0) {
      eligible.push({ campaign: c, poolRemaining: pool });
    }
  }
  return eligible;
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
  // Chunk the title_id .in() at <=100/chunk so the `title_id=in.(...)` URL
  // can't overflow the PostgREST/gateway cap (an oversized list fails, or worse
  // silently returns empty -> a campaign never metered). Loud-fail: any chunk
  // error throws and aborts this campaign's run (caught per-campaign, retried
  // next tick) -> never degrade to empty. Each fan_edit belongs to exactly one
  // title (so to one chunk), so concatenating chunk results is duplicate-free
  // and identical to the prior single query. (Result-set pagination is
  // intentionally unchanged; titles-per-campaign is tiny in practice.)
  const FE_TITLE_CHUNK = 100;
  const fanEditIds: string[] = [];
  for (let i = 0; i < titleIds.length; i += FE_TITLE_CHUNK) {
    const titleChunk = titleIds.slice(i, i + FE_TITLE_CHUNK);
    const { data: feRows, error: feErr } = await supabase
      .from("fan_edits")
      .select("id")
      .in("title_id", titleChunk)
      .eq("is_active", true)
      .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
      .is("deleted_at", null)
      .not("creator_id", "is", null);
    if (feErr) throw new Error(`Pass1 fan_edits: ${feErr.message}`);
    for (const r of (feRows ?? []) as Array<{ id: string }>) {
      fanEditIds.push(r.id);
    }
  }
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
  // <=100 ids/chunk keeps the fan_edit_id=in.(...) URL well under the gateway
  // cap, so an oversized chunk can never overflow and return empty — which the
  // inner break-on-empty (a legitimate pagination terminator) would otherwise
  // misread as "done", silently dropping that chunk's snapshots -> unbilled
  // edits. The inner .range() pagination and the throw-on-error are unchanged.
  const chunkSize = 100;
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
    .select("id, fan_edit_id, full_cpm_cents, appeared_at")
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

  // ---- PASS 1: compute the authoritative per-delta billed amount ----
  // No writes here. The amount source is now integer-exact, never a
  // JS-double factor:
  //   Full-CPM run (factor === null): each delta bills its exact
  //   integer full_cpm. No apportionment, no flooring — identical to
  //   the prior full-CPM behavior, just routed through the explicit
  //   p_billed_cents param.
  //   Pro-rata run: integer largest-remainder (Hamilton) apportionment
  //   of the pool across the settled set, so Σ billed === pool EXACTLY.
  //   This eliminates the floor() residue that used to wedge the pool a
  //   few cents above zero and make strict-zero completion unreachable.
  const finalCentsById = new Map<string, number>();

  if (!isProrata) {
    for (const row of rows) {
      finalCentsById.set(row.id, row.full_cpm_cents);
    }
  } else {
    // Integer arithmetic throughout — no JS-double factor touches the
    // money. Magnitude safety: poolBefore is bounded by realistic pool
    // sizes (≤ ~10^7 cents) and full_cpm_cents by per-delta CPM earnings
    // (≤ ~10^6 cents), so numer = poolBefore * full_cpm_cents stays well
    // under Number.MAX_SAFE_INTEGER (9.007×10^15). totalWanted > 0 here
    // (isProrata implies totalWanted > poolBefore ≥ 1).
    const apportioned = rows.map((row) => {
      const numer = poolBefore * row.full_cpm_cents;
      const floorCents = Math.floor(numer / totalWanted);
      const remainder = numer - floorCents * totalWanted; // numer mod totalWanted
      return { row, floorCents, remainder };
    });

    const allocated = apportioned.reduce((s, a) => s + a.floorCents, 0);
    const leftover = poolBefore - allocated; // proven: 0 ≤ leftover < N

    // Deterministic leftover-cent assignment: highest remainder first,
    // then FIFO (appeared_at ASC), then id ASC. Sort a COPY — PASS 2
    // writes in the original FIFO order. Determinism makes a retried
    // run reproduce the same assignment for the same settled set.
    const byRemainder = [...apportioned].sort((a, b) => {
      if (b.remainder !== a.remainder) return b.remainder - a.remainder;
      if (a.row.appeared_at !== b.row.appeared_at) {
        return a.row.appeared_at < b.row.appeared_at ? -1 : 1;
      }
      return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
    });

    for (const a of apportioned) finalCentsById.set(a.row.id, a.floorCents);
    for (let i = 0; i < leftover && i < byRemainder.length; i++) {
      const a = byRemainder[i];
      finalCentsById.set(a.row.id, a.floorCents + 1);
    }

    // Invariant: Σ final === pool EXACTLY. A violation means an
    // apportionment bug; bail the run safely (write NOTHING) rather
    // than bill wrong amounts on the money rail. The fatal-catch flips
    // the run to 'failed' and leaves all deltas 'settled' for retry.
    const finalSum = rows.reduce(
      (s, r) => s + (finalCentsById.get(r.id) ?? 0),
      0,
    );
    if (finalSum !== poolBefore) {
      throw new Error(
        `largest-remainder invariant violated: Σfinal=${finalSum} != pool=${poolBefore} (totalWanted=${totalWanted}, leftover=${leftover}, rows=${rows.length})`,
      );
    }
  }

  // ---- PASS 2: write, in original FIFO order ----
  // poolRemaining is a logging/tracker mirror only — it is NO LONGER
  // the money source and NO LONGER gates anything (void is decoupled
  // and keyed off the authoritative ledger SUM in the handler).
  let poolRemaining = poolBefore;
  let rowsBilled = 0;
  let totalBilledCents = 0;
  let rowsSkippedRounding = 0;
  let rowsSkippedOrphan = 0;
  const rpcErrors: Array<{ delta_id: string; error: string }> = [];

  for (const row of rows) {
    const billedCents = finalCentsById.get(row.id) ?? 0;
    if (billedCents <= 0) {
      // Pro-rata floor rounded this delta to 0 and it did not win a
      // leftover cent. Skip — it stays 'settled' and is voided when the
      // campaign completes (ledger SUM === 0). On full-CPM runs this
      // never happens: the select filters full_cpm_cents > 0.
      rowsSkippedRounding += 1;
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
          p_billed_cents: billedCents,
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

  // Informational only — the handler gates completion AND void on the
  // authoritative ledger SUM, not on this tracker.
  const poolExhausted = poolRemaining <= 0;

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
  // <=100 ids/chunk: a 500-id id=in.(...) URL (~18.5KB) can overflow the gateway
  // and return empty instead of erroring, leaving these fan_edits absent from
  // the map -> downstream they'd be skipped as false "orphan" anomalies (one hop
  // from bill_settled_delta). 100 ids (~4KB URL) cannot overflow. Throw-on-error
  // unchanged.
  const chunkSize = 100;
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
// Lifecycle transitions (3c.3).
// ---------------------------------------------------------------
// Fires AFTER Pass 2 and AFTER any voidRemainingSettled, BEFORE
// the run row is finalized. Mutually exclusive transitions:
//   funded -> live      when rowsBilled > 0 AND status='funded'.
//   live  -> completed  when poolRemainingAfter == 0 (strict zero).
// Both UPDATEs guard the prior status in their WHERE clauses, so
// a campaign that concurrently transitioned (e.g. a manual
// rollover) can never be flipped backward by this code.
//
// Two UPDATEs (not a single CASE) — chosen because:
//   - Each transition's SET clause differs (live stamps
//     launched_at, completed stamps completed_at). A single
//     UPDATE with CASE would need three parallel CASE
//     expressions, which is denser and easier to break.
//   - The no-transition path short-circuits with zero
//     round-trips; only the firing transition pays a round trip.
//   - Each UPDATE has a single clear intent — easier to read,
//     easier to log, easier to verify.
//
// Both UPDATEs use `.select('id')` and only return the transition
// string if `data.length > 0`. If the UPDATE matched zero rows,
// the campaign's status changed under us between pickTarget
// Campaign and here (e.g. a concurrent admin rollover via
// write_partner_credit_for_campaign). Log a concurrent_status_
// change warning and return null. The JSON response's
// `lifecycle_transition` field and the lifecycle log line then
// reflect ONLY transitions that actually committed.
//
// partner_credits is NOT written here. The metering job's
// strict-zero completion path has nothing to roll over by
// definition — write_partner_credit_for_campaign is reserved
// for the manual-completion path (admin ends a campaign early
// with a positive remaining pool).
//
// Returns the transition that fired (or null) so the handler
// can log it and surface it in the JSON response.

async function applyLifecycleTransitions(
  supabase: SupabaseClient,
  campaign: Campaign,
  rowsBilled: number,
  poolRemainingAfter: number,
): Promise<"live" | "completed" | null> {
  // Defensive: refuse to touch unexpected statuses. pickTarget
  // Campaign filtered to 'funded'/'live', so anything else here
  // implies a concurrent state change. Log loudly and no-op —
  // never crash the run on a status anomaly.
  if (campaign.status !== "funded" && campaign.status !== "live") {
    console.error(
      `[campaign-metering] DATA ANOMALY: unexpected campaign status='${campaign.status}' at lifecycle step for campaign=${campaign.id}; skipping transition`,
    );
    return null;
  }

  // Pool exhausted — complete the campaign. Wins over the
  // funded->live case when both could apply (a one-shot
  // funded->completed jump on the first ever billing).
  if (poolRemainingAfter === 0) {
    const { data, error } = await supabase
      .from("campaigns")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", campaign.id)
      .in("status", ["funded", "live"])
      .select("id");
    if (error) {
      throw new Error(
        `applyLifecycleTransitions completed: ${error.message}`,
      );
    }
    if ((data ?? []).length === 0) {
      console.warn(
        `[campaign-metering] concurrent_status_change: campaign=${campaign.id} expected status in ('funded','live') but UPDATE matched 0 rows; not returning transition`,
      );
      return null;
    }
    return "completed";
  }

  // First billing on a funded campaign — mark it 'live'.
  if (rowsBilled > 0 && campaign.status === "funded") {
    const { data, error } = await supabase
      .from("campaigns")
      .update({
        status: "live",
        launched_at: new Date().toISOString(),
      })
      .eq("id", campaign.id)
      .eq("status", "funded")
      .select("id");
    if (error) {
      throw new Error(
        `applyLifecycleTransitions live: ${error.message}`,
      );
    }
    if ((data ?? []).length === 0) {
      console.warn(
        `[campaign-metering] concurrent_status_change: campaign=${campaign.id} expected status='funded' but UPDATE matched 0 rows; not returning transition`,
      );
      return null;
    }
    return "live";
  }

  return null;
}

// ---------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------

Deno.serve(async (_req: Request) => {
  const startTime = Date.now();

  try {
    const supabase = createClient(
      getEnv("SUPABASE_URL"),
      getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Run-level fatals (client creation, this query) propagate to the
    // outer catch. EVERYTHING per-campaign is caught inside the loop, so
    // one bad campaign can never abort the sweep and starve the others.
    const eligible = await selectEligibleCampaigns(supabase);
    if (eligible.length === 0) {
      console.log(
        "[campaign-metering] no eligible campaign with positive pool",
      );
      return jsonResponse({
        ok: true,
        no_eligible_campaign: true,
        campaigns_processed: 0,
        campaigns_remaining: 0,
        budget_exhausted: false,
        duration_ms: Date.now() - startTime,
        results: [],
      });
    }
    console.log(
      `[campaign-metering] ${eligible.length} eligible campaign(s)`,
    );

    const results: object[] = [];
    let processed = 0;
    let budgetExhausted = false;

    for (const { campaign, poolRemaining } of eligible) {
      // Wall-clock budget — checked BETWEEN campaigns. The in-flight
      // campaign always finishes atomically (its run row never half-
      // commits); we only stop before STARTING the next one. Remaining
      // campaigns are picked up by the next invocation.
      if (Date.now() - startTime > BUDGET_MS) {
        budgetExhausted = true;
        console.warn(
          `[campaign-metering] budget ${BUDGET_MS}ms exceeded after ${processed}/${eligible.length} campaigns; stopping cleanly`,
        );
        break;
      }

      // Per-campaign isolation (load-bearing). A throw here — a Pass 1
      // query error, the largest-remainder invariant, an unexpected RPC
      // failure — fails ONLY this campaign's run and the loop CONTINUES.
      // Without this, a single poison campaign would re-create the exact
      // head-of-line freeze this change exists to prevent.
      let runId: string | null = null;
      try {
        runId = await startRun(supabase, campaign.id, poolRemaining);

        // Pass 1 — insert metering rows for new snapshots.
        const rowsInserted = await pass1InsertDeltas(supabase, campaign);

        // Flip matured rows (incl. newly-inserted rows already past
        // settles_at — retroactive billing on historical snapshots).
        await flipMaturedToSettled(supabase, campaign.id);

        // Pass 2 — bill settled rows (commit-(i) largest-remainder
        // two-pass; unchanged).
        const result = await pass2BillSettled(
          supabase,
          campaign,
          runId,
          poolRemaining,
        );

        // Authoritative pool — ledger SUM after the run's writes land.
        const poolAfter = await campaignPoolRemaining(supabase, campaign.id);

        // Void remaining 'settled' rows once the pool is fully drained
        // (poolAfter === 0) — the SAME condition that fires completion,
        // so completion and void happen together. (Commit-(i) gate,
        // unchanged.)
        let rowsVoided = 0;
        if (poolAfter === 0) {
          rowsVoided = await voidRemainingSettled(
            supabase,
            campaign.id,
            runId,
          );
        }

        // Lifecycle transitions (3c.3) — funded -> live on first
        // billing, live -> completed on pool == 0. Unchanged.
        const lifecycleTransition = await applyLifecycleTransitions(
          supabase,
          campaign,
          result.rowsBilled,
          poolAfter,
        );

        await completeRun(supabase, runId, {
          rows_billed: result.rowsBilled,
          total_billed_cents: result.totalBilledCents,
          pool_remaining_after_cents: poolAfter,
        });

        processed += 1;
        console.log(
          `[campaign-metering] campaign=${campaign.id} billed=${result.rowsBilled} total=${result.totalBilledCents} factor=${result.factor} pool_after=${poolAfter} voided=${rowsVoided} skipped_rounding=${result.rowsSkippedRounding} skipped_orphan=${result.rowsSkippedOrphan} rpc_errors=${result.rpcErrors.length} transition=${lifecycleTransition ?? "none"}`,
        );
        results.push({
          ok: true,
          run_id: runId,
          campaign_id: campaign.id,
          rows_inserted: rowsInserted,
          rows_billed: result.rowsBilled,
          total_billed_cents: result.totalBilledCents,
          prorata_factor: result.factor,
          pool_remaining_before_cents: poolRemaining,
          pool_remaining_after_cents: poolAfter,
          pool_exhausted: result.poolExhausted,
          rows_voided: rowsVoided,
          rows_skipped_rounding: result.rowsSkippedRounding,
          rows_skipped_orphan: result.rowsSkippedOrphan,
          rpc_errors: result.rpcErrors,
          lifecycle_transition: lifecycleTransition,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[campaign-metering] campaign=${campaign.id} FAILED: ${msg}`,
        );
        // Flip this campaign's run to 'failed' (best-effort) and move on.
        // runId is null only if startRun itself threw (no run row to fail).
        if (runId) await failRun(supabase, runId, msg);
        processed += 1;
        results.push({
          ok: false,
          run_id: runId,
          campaign_id: campaign.id,
          error_message: msg,
        });
        // Continue to the next campaign — do NOT abort the sweep.
      }
    }

    return jsonResponse({
      ok: true,
      campaigns_processed: processed,
      campaigns_remaining: eligible.length - processed,
      budget_exhausted: budgetExhausted,
      duration_ms: Date.now() - startTime,
      results,
    });
  } catch (err) {
    // Run-level fatal ONLY: client creation or selectEligibleCampaigns.
    // Per-campaign failures are caught inside the loop and never reach
    // here, so no single campaign can produce a 500 that starves the rest.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[campaign-metering] fatal:", msg);
    return jsonResponse(
      {
        ok: false,
        error_message: msg,
        duration_ms: Date.now() - startTime,
      },
      500,
    );
  }
});
