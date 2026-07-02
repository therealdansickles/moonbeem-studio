// GET /api/cron/settle-transactions — sub-unit 5a settle pass.
//
// Reads paid-but-unsettled entitlements, fetches Stripe's SETTLED net for each
// charge, computes the integer-cents split in basis points, and writes one
// transaction_settlements row per entitlement. MOVES NO MONEY — it only records
// the split; sub-unit 5b advances payout_status and executes transfers.
//
// Schedule: daily at 04:00 UTC (vercel.json), off campaign-metering's 03:00
// slot. Auth: same Bearer CRON_SECRET pattern as the other cron routes.
//
// Idempotent: INSERT ... ON CONFLICT (entitlement_id) DO NOTHING (via upsert
// ignoreDuplicates). "Settled" is DERIVED — an entitlement with no
// transaction_settlements row — so a budget-truncated, hard-killed, or failed
// run simply re-selects the row next time; each row's insert is atomic, so a
// truncated run never leaves a partial row. One bad entitlement is skipped or
// refused and reported, never thrown, so it can't block the batch.
//
// Touches no existing money-rail file: it only READS entitlements + titles and
// WRITES transaction_settlements, reusing getStripe() (the pinned
// 2026-05-27.dahlia client) and createServiceRoleClient() (RLS-bypass — the
// ledger has RLS enabled with no policies).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/server";
import { numericStringToExactBps } from "@/lib/affiliate/rate";

// Wall-clock budget: stop the per-row loop cleanly with headroom to flush the
// response, then resume next run. A hard Vercel timeout is also safe here
// because settlement is idempotent and derived (no partial rows).
const BUDGET_MS = 50_000;

// Bound the candidate page. At launch volume (0 transacting titles) this is
// never reached; if real volume ever exceeds it, a DB-side work-set function
// would replace the client-side anti-join below.
const CANDIDATE_LIMIT = 500;

// The numeric-string -> exact-bps rule lives in lib/affiliate/rate.ts
// (numericStringToExactBps), shared with the rate-control write guard so the two
// can't drift. A null rate stays null -> the row is REFUSED (non_integer_bps),
// never settled at 0 bps.

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[cron/settle-transactions] CRON_SECRET env not set");
    return NextResponse.json(
      { error: "cron_secret_not_configured" },
      { status: 503 },
    );
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const supabase = createServiceRoleClient();
  const stripe = getStripe();

  const summary = {
    seen: 0,
    settled: 0,
    skipped_pending: 0,
    refused: {
      currency_mismatch: 0,
      amount_mismatch: 0,
      null_partner: 0,
      non_integer_bps: 0,
    },
    errors: 0,
    budget_stopped: false,
  };

  try {
    // Work set: paid entitlements with a Stripe payment intent. Directly-seeded
    // rows (null payment intent) are excluded here — there's no charge to fetch.
    const { data: candidates, error: candErr } = await supabase
      .from("entitlements")
      .select(
        // revoked_at/disputed_at (5b feeder c): a refund/dispute that landed
        // before this pass writes the settlement row -> born already-blocked.
        "id, title_id, creator_id, price_paid_cents, stripe_payment_intent_id, revoked_at, disputed_at",
      )
      .not("stripe_payment_intent_id", "is", null)
      .order("created_at", { ascending: true }) // stable order
      .limit(CANDIDATE_LIMIT);
    if (candErr) {
      console.error(
        `[cron/settle-transactions] work-set query failed: ${candErr.message}`,
      );
      return NextResponse.json(
        { error: "work_set_query_failed", message: candErr.message },
        { status: 500 },
      );
    }
    const cand = candidates ?? [];

    if (cand.length > 0) {
      // Anti-join (PostgREST can't express NOT EXISTS): drop candidates that
      // already have a settlement row. ON CONFLICT below is the real idempotency
      // guarantee; this just avoids re-hitting Stripe for settled rows.
      const candIds = cand.map((c) => c.id as string);
      const { data: settledRows, error: setErr } = await supabase
        .from("transaction_settlements")
        .select("entitlement_id")
        .in("entitlement_id", candIds);
      if (setErr) {
        console.error(
          `[cron/settle-transactions] settled-lookup failed: ${setErr.message}`,
        );
        return NextResponse.json(
          { error: "settled_lookup_failed", message: setErr.message },
          { status: 500 },
        );
      }
      const settledSet = new Set(
        (settledRows ?? []).map((r) => r.entitlement_id as string),
      );
      const workSet = cand.filter((c) => !settledSet.has(c.id as string));

      // Pre-fetch the titles (rates + distributor) for the work set.
      const titleIds = Array.from(
        new Set(workSet.map((c) => c.title_id as string)),
      );
      const titleMap = new Map<
        string,
        {
          partner_id: string | null;
          moonbeem_take_rate_pct: string | null;
          creator_share_pct: string | null;
        }
      >();
      if (titleIds.length > 0) {
        const { data: titles, error: titleErr } = await supabase
          .from("titles")
          .select("id, partner_id, moonbeem_take_rate_pct, creator_share_pct")
          .in("id", titleIds);
        if (titleErr) {
          console.error(
            `[cron/settle-transactions] title lookup failed: ${titleErr.message}`,
          );
          return NextResponse.json(
            { error: "title_lookup_failed", message: titleErr.message },
            { status: 500 },
          );
        }
        for (const t of titles ?? []) {
          titleMap.set(t.id as string, {
            partner_id: (t.partner_id as string | null) ?? null,
            moonbeem_take_rate_pct:
              (t.moonbeem_take_rate_pct as string | null) ?? null,
            creator_share_pct: (t.creator_share_pct as string | null) ?? null,
          });
        }
      }

      for (const e of workSet) {
        if (Date.now() - startedAt > BUDGET_MS) {
          summary.budget_stopped = true;
          break;
        }
        summary.seen++;
        const entId = e.id as string;
        const piId = e.stripe_payment_intent_id as string;
        const gross = e.price_paid_cents as number;
        const titleId = e.title_id as string;

        try {
          // 1. Fetch the charge's balance transaction (settled net + fee).
          const pi = await stripe.paymentIntents.retrieve(piId, {
            expand: ["latest_charge.balance_transaction"],
          });

          // 2. Pending skip — narrow the unions (expand alone doesn't satisfy
          //    the compiler; both fields are string | object | null).
          const charge = pi.latest_charge;
          if (charge === null || typeof charge === "string") {
            summary.skipped_pending++;
            console.log(
              `[cron/settle-transactions] skip-pending ent=${entId} (charge not expanded/settled)`,
            );
            continue;
          }
          const bt = charge.balance_transaction;
          if (bt === null || typeof bt === "string") {
            summary.skipped_pending++;
            console.log(
              `[cron/settle-transactions] skip-pending ent=${entId} (balance_transaction unsettled)`,
            );
            continue;
          }

          // 3. Hard refusals — do NOT write a row.
          if (bt.currency !== "usd") {
            summary.refused.currency_mismatch++;
            console.warn(
              `[cron/settle-transactions] REFUSE ent=${entId} currency=${bt.currency} (non-usd)`,
            );
            continue;
          }
          if (bt.amount !== gross) {
            summary.refused.amount_mismatch++;
            console.warn(
              `[cron/settle-transactions] REFUSE ent=${entId} bt.amount=${bt.amount} != gross=${gross}`,
            );
            continue;
          }
          const title = titleMap.get(titleId);
          if (!title || title.partner_id === null) {
            summary.refused.null_partner++;
            console.warn(
              `[cron/settle-transactions] REFUSE ent=${entId} title=${titleId} null/absent partner_id`,
            );
            continue;
          }

          // 4. Rates → integer basis points (assert exact; creator_share → 0 bps
          //    when the sale is unattributed or the rate is null — see below).
          const mbBps = numericStringToExactBps(title.moonbeem_take_rate_pct);
          if (mbBps === null) {
            summary.refused.non_integer_bps++;
            console.warn(
              `[cron/settle-transactions] REFUSE ent=${entId} moonbeem_take_rate_pct=${title.moonbeem_take_rate_pct} not exact bps`,
            );
            continue;
          }
          // ATTRIBUTION-CONDITIONAL (2026-07-02 fix): the affiliate cut is paid
          // for ATTRIBUTION — a curator actually drove the sale — NOT for the
          // title merely HAVING a rate. An UNATTRIBUTED sale (entitlement
          // creator_id IS NULL) of a creator-share title must carve NO cut;
          // otherwise the cents orphan onto a creator_id=NULL settlement that
          // getAffiliateBalance never pays out (distributor underpaid, nobody
          // paid). No creator_id → 0 bps → affiliate_cut 0 → the amount stays in
          // distributorNet. The exact-bps refuse below still guards the
          // attributed path (where the rate is actually used).
          const crBps =
            (e.creator_id as string | null) === null ||
            title.creator_share_pct === null
              ? 0
              : numericStringToExactBps(title.creator_share_pct);
          if (crBps === null) {
            summary.refused.non_integer_bps++;
            console.warn(
              `[cron/settle-transactions] REFUSE ent=${entId} creator_share_pct=${title.creator_share_pct} not exact bps`,
            );
            continue;
          }

          // 5. Compute, integer-only, complements derived by subtraction.
          const postFee = bt.net;
          const stripeFee = gross - postFee;
          const moonbeemTake = Math.floor((postFee * mbBps) / 10000);
          const distributorGross = postFee - moonbeemTake;
          const affiliateCut = Math.floor((distributorGross * crBps) / 10000);
          const distributorNet = distributorGross - affiliateCut;

          // 6. Idempotent insert — ON CONFLICT (entitlement_id) DO NOTHING.
          const { data: inserted, error: insErr } = await supabase
            .from("transaction_settlements")
            .upsert(
              {
                entitlement_id: entId,
                title_id: titleId,
                partner_id: title.partner_id,
                creator_id: (e.creator_id as string | null) ?? null,
                gross_cents: gross,
                post_fee_cents: postFee,
                stripe_fee_cents: stripeFee,
                moonbeem_take_cents: moonbeemTake,
                distributor_net_cents: distributorNet,
                affiliate_cut_cents: affiliateCut,
                moonbeem_take_bps: mbBps,
                creator_share_bps: crBps,
                stripe_balance_txn_id: bt.id,
                // 5b feeder (c) race handling: a refund/dispute that marked the
                // entitlement BEFORE this pass runs makes the row born blocked,
                // never a 'held' row a future release could pay. No marker =>
                // 'held' (the prior default). This is the ONLY 5b-c change here;
                // the split math, the sum invariant, and the upsert conflict
                // handling above/below are untouched.
                payout_status:
                  e.revoked_at != null
                    ? "refunded"
                    : e.disputed_at != null
                      ? "disputed"
                      : "held",
              },
              { onConflict: "entitlement_id", ignoreDuplicates: true },
            )
            .select("id");
          if (insErr) {
            summary.errors++;
            console.error(
              `[cron/settle-transactions] insert failed ent=${entId}: ${insErr.message}`,
            );
            continue;
          }
          if (inserted && inserted.length > 0) {
            summary.settled++;
            console.log(
              `[cron/settle-transactions] settled ent=${entId} gross=${gross} fee=${stripeFee} take=${moonbeemTake} dist=${distributorNet} aff=${affiliateCut} bt=${bt.id}`,
            );
          } else {
            // Conflict no-op (a concurrent run settled it). Not an error.
            console.log(
              `[cron/settle-transactions] noop ent=${entId} (already settled)`,
            );
          }
        } catch (err) {
          summary.errors++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[cron/settle-transactions] row threw ent=${entId}: ${msg}`,
          );
          continue;
        }
      }
    }

    const elapsed_ms = Date.now() - startedAt;
    const refused_total =
      summary.refused.currency_mismatch +
      summary.refused.amount_mismatch +
      summary.refused.null_partner +
      summary.refused.non_integer_bps;
    console.log(
      `[cron/settle-transactions] seen=${summary.seen} settled=${summary.settled} skipped_pending=${summary.skipped_pending} refused=${refused_total} errors=${summary.errors} budget_stopped=${summary.budget_stopped} elapsed_ms=${elapsed_ms}`,
    );
    return NextResponse.json({ ...summary, refused_total, elapsed_ms });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cron/settle-transactions] threw: ${msg}`);
    return NextResponse.json(
      { error: "settle_failed", message: msg, ...summary },
      { status: 500 },
    );
  }
}
