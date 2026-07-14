// Service-role entitlement reads + the first-play stamp for the playback gate
// (transactions sub-unit 3). `entitlements` has RLS enabled with no policies, so
// these go through the service-role client (mirroring getEpisodeForPlayback).

import { createServiceRoleClient } from "@/lib/supabase/service";
import { isEntitlementActive } from "@/lib/entitlements/window";
import { getStripe } from "@/lib/stripe/server";
import type Stripe from "stripe";

export type ActiveEntitlement = {
  id: string;
  kind: string;
  purchased_at: string;
  first_played_at: string | null;
  // TELEMETRY ONLY (C4): the affiliate curator credited at purchase, or null.
  // Read by the playback-token route to tag the Mux Data view (custom_1) so a
  // watch can be joined back to the curator who drove the sale — the one field in
  // the attribution chain that is otherwise unrecoverable from a view (partner and
  // hosting-owner are both derivable from title_id). NULL on free plays, and that
  // is honest: no entitlement, no curator. NO GATE READS THIS.
  creator_id: string | null;
};

// The single ACTIVE entitlement for (userId, titleId), or null. There may be >1
// row for the pair (a legit re-rent after expiry); we evaluate each through
// isEntitlementActive — the SAME two-clock rule the charge-init double-pay guard
// uses (imported verbatim, never reimplemented) — and, defensively, return the
// most recent active one. Returns the row INCLUDING its id (the stamp needs it).
// Uses idx_entitlements_user_title.
export async function getActiveEntitlement(
  userId: string,
  titleId: string,
): Promise<ActiveEntitlement | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("entitlements")
    .select("id, kind, purchased_at, first_played_at, creator_id")
    // Refund revocation (5b feeder c): a revoked entitlement is never active —
    // filter it out at the query so it can't even enter the two-clock loop.
    // isEntitlementActive (the window rule, shared with the double-pay guard) is
    // deliberately left untouched; revocation is an orthogonal gate here.
    .is("revoked_at", null)
    .eq("user_id", userId)
    .eq("title_id", titleId)
    .order("purchased_at", { ascending: false });
  if (error || !data || data.length === 0) return null;

  // data is purchased_at DESC, so the first active row IS the most recent active.
  for (const r of data as ActiveEntitlement[]) {
    if (
      isEntitlementActive({
        kind: r.kind,
        purchased_at: r.purchased_at,
        first_played_at: r.first_played_at ?? null,
      })
    ) {
      return r;
    }
  }
  return null;
}

// The buyer's WHOLE library (Library v1) — every entitlement for the user, joined
// to its title for display. Unlike getActiveEntitlement this deliberately does NOT
// filter revoked_at (the Library classifies a refunded row as an access-ended
// state rather than dropping it) and does NOT filter by title_id (keyed on user_id
// alone, using the leftmost column of idx_entitlements_user_title). Expect >1 row
// per (user, title) from legit re-rents and rent-then-buy coexistence; the render
// layer groups by title with precedence purchase > active rental > expired rental.
// Join shape mirrors getTopTitlesForUser (a to-one FK embed → titles object).
// is_public is selected per the v1 spec though v1 renders no visibility badge (any
// authenticated owner may view a non-public title — see canViewTitle); it's carried
// for a possible future "unlisted" indicator. Service-role because entitlements has
// RLS with no policies; the caller MUST pass a session-resolved userId (never
// client-supplied). Degrades to [] on error (display read), logging loudly.
export type LibraryTitle = {
  id: string;
  slug: string;
  title: string;
  poster_url: string | null;
  is_public: boolean;
  transact_enabled: boolean;
  transact_price_cents: number | null;
};

export type LibraryEntitlement = {
  id: string;
  kind: string;
  purchased_at: string;
  first_played_at: string | null;
  price_paid_cents: number;
  revoked_at: string | null;
  receipt_url: string | null;
  title: LibraryTitle;
};

type LibraryJoinRow = {
  id: string;
  kind: string;
  purchased_at: string;
  first_played_at: string | null;
  price_paid_cents: number;
  revoked_at: string | null;
  receipt_url: string | null;
  stripe_payment_intent_id: string | null;
  titles: LibraryTitle | null;
};

// Lazy receipt backfill (Option A): fill a null receipt_url from the stored
// payment_intent (server Stripe), best-effort — fires only for rows the webhook
// capture missed (legacy rows / a hiccup), then the column is read on future
// renders. No click-time fetch; serial + swallow-errors so a Stripe blip never
// breaks the Library render. Capped per render (below) to bound SSR latency.
const RECEIPT_BACKFILL_MAX_PER_RENDER = 8;

async function backfillMissingReceipts(
  supabase: ReturnType<typeof createServiceRoleClient>,
  rows: LibraryJoinRow[],
): Promise<Map<string, string>> {
  // Cap the fan-out: at most this many null-receipt rows fetch Stripe on a single
  // render. New purchases are captured at the webhook, so this is a one-time
  // legacy safety-net; rows over the cap (or a charge with no receipt_url) render
  // "Receipt unavailable" and fill on a later render.
  const need = rows
    .filter((r) => !r.receipt_url && r.stripe_payment_intent_id)
    .slice(0, RECEIPT_BACKFILL_MAX_PER_RENDER);
  const filled = new Map<string, string>();
  if (need.length === 0) return filled;
  const stripe = getStripe();
  for (const r of need) {
    try {
      const pi = await stripe.paymentIntents.retrieve(
        r.stripe_payment_intent_id as string,
        { expand: ["latest_charge"] },
      );
      const charge =
        pi.latest_charge && typeof pi.latest_charge === "object"
          ? (pi.latest_charge as Stripe.Charge)
          : null;
      const url = charge?.receipt_url ?? null;
      if (url) {
        await supabase
          .from("entitlements")
          .update({ receipt_url: url })
          .eq("id", r.id)
          .is("receipt_url", null);
        filled.set(r.id, url);
      }
    } catch (err) {
      console.error(
        `[entitlements] receipt backfill failed ent=${r.id}: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }
  return filled;
}

export async function getMyEntitlements(
  userId: string,
): Promise<LibraryEntitlement[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("entitlements")
    .select(
      "id, kind, purchased_at, first_played_at, price_paid_cents, revoked_at, receipt_url, stripe_payment_intent_id, titles:title_id(id, slug, title, poster_url, is_public, transact_enabled, transact_price_cents)",
    )
    .eq("user_id", userId)
    .order("purchased_at", { ascending: false });
  if (error) {
    console.error(
      `[entitlements] getMyEntitlements failed for ${userId}: ${error.message}`,
    );
    return [];
  }
  // A hard-deleted title CASCADE-removes its entitlement row, so a null title
  // should not occur; filtered defensively so a Library never renders a card
  // with no title.
  const rows = ((data ?? []) as unknown as LibraryJoinRow[]).filter(
    (r) => r.titles,
  );
  const filled = await backfillMissingReceipts(supabase, rows);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    purchased_at: r.purchased_at,
    first_played_at: r.first_played_at,
    price_paid_cents: r.price_paid_cents,
    revoked_at: r.revoked_at,
    receipt_url: filled.get(r.id) ?? r.receipt_url,
    title: r.titles!,
  }));
}

// Stamp first_played_at exactly-once, at DB time, arming the 48h rental clock.
// Idempotent: the RPC's conditional UPDATE (WHERE first_played_at IS NULL) stamps
// on the first play and no-ops (0 rows) on every later play. DB now() (NOT a JS
// Date) so the clock can't skew — which is why this is an RPC: PostgREST can't set
// a column to now() in an update. Fire-and-proceed: a 0-row result is the EXPECTED
// case on 2nd+ play; a transient error is logged, never blocks the mint.
export async function stampFirstPlay(entitlementId: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.rpc("stamp_first_play", {
    p_entitlement_id: entitlementId,
  });
  if (error) {
    console.error(
      `[entitlements] stamp_first_play failed for ${entitlementId}: ${error.message}`,
    );
  }
}
