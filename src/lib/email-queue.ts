// Email queue helper: durable workflow state for outbound notification
// emails with hot-path after() drain + cron retry sweep.
//
// See supabase/migrations/20260513000004_email_queue.sql for schema +
// migration 20260513000005 for the atomic-claim RPC.
//
// Lifecycle:
//   1. Caller (notifyTitleRequesters or admin route) calls
//      enqueueEmailBatch() — fast row INSERTs, returns immediately.
//   2. Caller fires drainQueue({ ids }) via after() / waitUntil() on
//      the same request — best-effort immediate send without blocking
//      the response.
//   3. Vercel cron hits /api/cron/drain-email-queue every 5min and
//      calls drainQueue({ maxRows: 100 }) to catch any rows the
//      hot-path missed (cold start, transient Resend failure, etc.).
//   4. Per-row send: drain claims via RPC, calls Resend, marks 'sent'
//      on success or computes next_retry_at via exponential backoff
//      on failure. After 5 attempts, status flips to
//      'failed_permanently' and the row stops being retried.
//
// Decision-level filtering (RLS opt-outs, dedup against
// notification_log) happens at ENQUEUE time, not drain time. By the
// time a row is in the queue, sending is the right action — drain
// just executes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { sendRequestFulfilledEmail } from "@/lib/email/request-fulfilled";
import { getOrigin } from "@/lib/email/origin";

export type ContentType = "clip" | "still" | "fan_edit";

export type EnqueueEmailParams = {
  userId: string;
  titleId: string;
  contentType: ContentType;
  contentIds: string[];
};

export type DrainOptions = {
  /** Hot-path: drain only these specific row ids (just-enqueued). */
  ids?: string[];
  /** Cron path: drain up to N pending-and-due rows. Default 100. */
  maxRows?: number;
  /** Bail out of the drain loop once wall time exceeds this. Default 25_000 (Vercel function timeout headroom). */
  budgetMs?: number;
};

export type DrainResult = {
  drained: number;
  failed: number;
  failed_permanent: number;
  skipped_budget: number;
  elapsed_ms: number;
};

// Backoff schedule. Index = attempts-after-this-failure (1 = first
// failure, 5 = fifth failure). null = give up.
const BACKOFF_MS: (number | null)[] = [
  null,           // index 0 unused
  60_000,         // attempt 1 failed → retry in 1 min
  5 * 60_000,     // attempt 2 failed → 5 min
  15 * 60_000,    // attempt 3 failed → 15 min
  60 * 60_000,    // attempt 4 failed → 1 hr
  null,           // attempt 5 failed → permanent fail
];

/**
 * Compute the next retry timestamp given the current attempts count.
 * Returns null when the row should be marked failed_permanently.
 */
export function getNextRetryAt(attempts: number): Date | null {
  if (attempts < 1 || attempts >= BACKOFF_MS.length) return null;
  const ms = BACKOFF_MS[attempts];
  if (ms === null) return null;
  return new Date(Date.now() + ms);
}

/**
 * Insert a single row. Returns the new row id.
 */
export async function enqueueEmail(
  params: EnqueueEmailParams,
): Promise<{ id: string }> {
  const sb = createServiceRoleClient();
  const { data, error } = await sb
    .from("email_queue")
    .insert({
      user_id: params.userId,
      title_id: params.titleId,
      content_type: params.contentType,
      content_ids: params.contentIds,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`enqueueEmail failed: ${error?.message ?? "no row"}`);
  }
  return { id: data.id as string };
}

/**
 * Insert N rows in one statement. Returns the new ids in input order.
 */
export async function enqueueEmailBatch(
  rows: EnqueueEmailParams[],
): Promise<{ ids: string[] }> {
  if (rows.length === 0) return { ids: [] };
  const sb = createServiceRoleClient();
  const { data, error } = await sb
    .from("email_queue")
    .insert(
      rows.map((r) => ({
        user_id: r.userId,
        title_id: r.titleId,
        content_type: r.contentType,
        content_ids: r.contentIds,
      })),
    )
    .select("id");
  if (error || !data) {
    throw new Error(`enqueueEmailBatch failed: ${error?.message ?? "no rows"}`);
  }
  return { ids: data.map((d) => d.id as string) };
}

type ClaimedRow = {
  id: string;
  user_id: string;
  title_id: string;
  content_type: ContentType;
  content_ids: string[];
  attempts: number;
};

/**
 * Atomically claim rows for sending. Either by specific ids (hot
 * path) or by N due-pending rows (cron). Sets status='sending' and
 * increments attempts in the same UPDATE.
 */
async function claimRows(
  sb: SupabaseClient,
  options: DrainOptions,
): Promise<ClaimedRow[]> {
  const args: { p_ids?: string[]; p_max_rows?: number } = {};
  if (options.ids && options.ids.length > 0) args.p_ids = options.ids;
  else args.p_max_rows = options.maxRows ?? 100;
  const { data, error } = await sb.rpc("claim_email_queue_rows", args);
  if (error) {
    throw new Error(`claim_email_queue_rows failed: ${error.message}`);
  }
  return (data ?? []) as ClaimedRow[];
}

/**
 * Drain newly-enqueued rows (hot path) or due-pending rows (cron).
 * Returns observability counts. Logs per-row outcome to Vercel logs.
 */
export async function drainQueue(
  options: DrainOptions = {},
): Promise<DrainResult> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? 25_000;
  const result: DrainResult = {
    drained: 0,
    failed: 0,
    failed_permanent: 0,
    skipped_budget: 0,
    elapsed_ms: 0,
  };

  const sb = createServiceRoleClient();
  const claimed = await claimRows(sb, options);
  if (claimed.length === 0) {
    result.elapsed_ms = Date.now() - startedAt;
    return result;
  }

  // Batch-fetch metadata so each row's send doesn't re-query.
  const userIds = Array.from(new Set(claimed.map((r) => r.user_id)));
  const titleIds = Array.from(new Set(claimed.map((r) => r.title_id)));

  // For requested_at — we want to show "you requested these on
  // <date>" in the body. Pull title_requests for every (user, title)
  // pairing in this batch. There's no composite filter helper in
  // PostgREST so we over-fetch by title_id and key on the client side.
  const [usersRes, titlesRes, prefsRes, requestsRes] = await Promise.all([
    sb.from("users").select("id, email").in("id", userIds),
    sb.from("titles").select("id, title, slug").in("id", titleIds),
    sb
      .from("notification_preferences")
      .select("user_id, email_on_title_updates, unsubscribe_token")
      .in("user_id", userIds),
    sb
      .from("title_requests")
      .select("user_id, title_id, request_type, requested_at")
      .in("title_id", titleIds)
      .in("user_id", userIds),
  ]);

  const emailByUser = new Map<string, string | null>(
    (usersRes.data ?? []).map((u) => [
      u.id as string,
      (u.email as string | null) ?? null,
    ]),
  );
  const titleById = new Map<string, { title: string; slug: string }>(
    (titlesRes.data ?? []).map((t) => [
      t.id as string,
      { title: t.title as string, slug: t.slug as string },
    ]),
  );
  const prefByUser = new Map<
    string,
    { enabled: boolean; token: string }
  >(
    (prefsRes.data ?? []).map((p) => [
      p.user_id as string,
      {
        enabled: p.email_on_title_updates as boolean,
        token: p.unsubscribe_token as string,
      },
    ]),
  );
  // Key by (user_id, title_id, request_type) so we pick the right
  // requested_at for each queue row's content_type.
  const requestedAtMap = new Map<string, string>();
  for (const r of requestsRes.data ?? []) {
    const k = `${r.user_id}|${r.title_id}|${r.request_type}`;
    requestedAtMap.set(k, r.requested_at as string);
  }
  const origin = getOrigin();

  for (const row of claimed) {
    if (Date.now() - startedAt > budgetMs) {
      // Return un-attempted rows to the pool. Don't decrement attempts
      // (we already incremented during the claim) — just reset status
      // so cron picks them up next sweep.
      await sb
        .from("email_queue")
        .update({ status: "pending" })
        .eq("id", row.id);
      result.skipped_budget += 1;
      continue;
    }

    const email = emailByUser.get(row.user_id);
    const title = titleById.get(row.title_id);
    const pref = prefByUser.get(row.user_id);

    // Missing essential metadata → permanent fail. Don't retry.
    if (!email || !title) {
      const why = !email ? "user has no email" : "title not found";
      await sb
        .from("email_queue")
        .update({
          status: "failed_permanently",
          last_error: why,
        })
        .eq("id", row.id);
      console.warn(
        `[email-queue] permanent fail: ${row.id} user=${row.user_id.slice(0, 8)} reason=${why}`,
      );
      result.failed += 1;
      result.failed_permanent += 1;
      continue;
    }

    // Soft-fail path: preferences could have flipped between enqueue
    // and drain. Treat opt-out as permanent fail for this row.
    if (pref && !pref.enabled) {
      await sb
        .from("email_queue")
        .update({
          status: "failed_permanently",
          last_error: "user unsubscribed between enqueue and send",
        })
        .eq("id", row.id);
      result.failed += 1;
      result.failed_permanent += 1;
      continue;
    }

    // If prefs are missing entirely, we'd need to insert defaults
    // (same as the legacy path). Fall back to using a placeholder
    // unsubscribe URL if no token is available — the email is still
    // valid; user can hit /me/notifications to manage preferences.
    const unsubscribeToken = pref?.token ?? "";

    // Look up requested_at for this (user, title, content_type) so
    // the template can include the "you requested these on <date>"
    // line. Missing row (unlikely but possible if the request was
    // deleted between enqueue and drain) just omits the date.
    const requestType =
      row.content_type === "fan_edit"
        ? "fan_edits"
        : row.content_type === "clip"
          ? "clips"
          : "stills";
    const requestedAtIso =
      requestedAtMap.get(
        `${row.user_id}|${row.title_id}|${requestType}`,
      ) ?? null;

    const unsubscribeUrl = unsubscribeToken
      ? `${origin}/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`
      : undefined;

    const sendStartedAt = Date.now();
    let sendResult;
    try {
      sendResult = await sendRequestFulfilledEmail({
        to: email,
        contentType: row.content_type,
        contentCount: row.content_ids.length,
        titleName: title.title,
        titleSlug: title.slug,
        requestedAtIso,
        unsubscribeUrl,
      });
    } catch (err) {
      sendResult = {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const sendLatencyMs = Date.now() - sendStartedAt;

    if (sendResult.ok) {
      // Mark sent AND write notification_log audit row.
      await Promise.all([
        sb
          .from("email_queue")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            last_error: null,
          })
          .eq("id", row.id),
        sb.from("notification_log").insert({
          user_id: row.user_id,
          title_id: row.title_id,
          content_type: row.content_type,
          content_ids: row.content_ids,
          resend_message_id: sendResult.resendMessageId,
          status: "sent",
        }),
      ]);
      console.log(
        `[email-queue] sent: ${row.id} user=${row.user_id.slice(0, 8)} latency=${sendLatencyMs}ms`,
      );
      result.drained += 1;
      continue;
    }

    // Send failed. Compute retry or permanent fail.
    const nextRetryAt = getNextRetryAt(row.attempts);
    const errText = sendResult.error.slice(0, 500);
    if (nextRetryAt === null) {
      await Promise.all([
        sb
          .from("email_queue")
          .update({
            status: "failed_permanently",
            last_error: errText,
          })
          .eq("id", row.id),
        sb.from("notification_log").insert({
          user_id: row.user_id,
          title_id: row.title_id,
          content_type: row.content_type,
          content_ids: row.content_ids,
          status: "failed",
          error_text: errText,
        }),
      ]);
      console.warn(
        `[email-queue] permanent fail after ${row.attempts} attempts: ${row.id} user=${row.user_id.slice(0, 8)} err=${errText}`,
      );
      result.failed += 1;
      result.failed_permanent += 1;
    } else {
      await sb
        .from("email_queue")
        .update({
          status: "pending",
          next_retry_at: nextRetryAt.toISOString(),
          last_error: errText,
        })
        .eq("id", row.id);
      console.warn(
        `[email-queue] retry scheduled: ${row.id} attempt=${row.attempts} next=${nextRetryAt.toISOString()} err=${errText}`,
      );
      result.failed += 1;
    }
  }

  result.elapsed_ms = Date.now() - startedAt;
  return result;
}
