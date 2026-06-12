// Resolves who should be emailed for a (title, contentType) update,
// applies opt-out + dedup filters, and enqueues rows for the email
// queue worker. Does NOT send emails directly — the queue + drain
// machinery (src/lib/email-queue.ts) handles dispatch, retries, and
// notification_log audit writes.
//
// Decision-level filtering (who) happens here at enqueue time:
//   - skip users who opted out (notification_preferences)
//   - skip users who already received this content (notification_log)
//   - skip users with no email on file
//
// Dispatch-level concerns (retries, Resend errors, send latency) are
// the queue worker's job. By the time a row is in email_queue,
// sending IS the right action — the drain just executes.

import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  enqueueEmailBatch,
  type ContentType,
} from "@/lib/email-queue";

export type { ContentType };

export type NotifyArgs = {
  titleId: string;
  contentType: ContentType;
  contentIds: string[];
  // When provided, restrict the recipient pool to these user_ids
  // (skip the title_requests lookup). Used by the fan-edit
  // fulfillment hook which already knows which requesters were just
  // fulfilled and must NOT notify any others — only those user_ids
  // whose request transitioned to fulfilled in this insert event.
  userIds?: string[];
};

export type NotifyResult = {
  /** Number of queue rows created. Roughly = number of emails that will be sent. */
  enqueued: number;
  /** Queue row ids — pass these to drainQueue({ ids }) for hot-path delivery. */
  enqueuedIds: string[];
  /** Users skipped because they opted out via notification_preferences. */
  skipped_unsub: number;
  /** Users skipped because notification_log shows we already sent overlapping content. */
  skipped_already: number;
  /** Users skipped because they have no email on file (defensive). */
  skipped_no_email: number;
};

export async function notifyTitleRequesters(
  args: NotifyArgs,
): Promise<NotifyResult> {
  const { titleId, contentType, contentIds } = args;
  const result: NotifyResult = {
    enqueued: 0,
    enqueuedIds: [],
    skipped_unsub: 0,
    skipped_already: 0,
    skipped_no_email: 0,
  };

  if (contentIds.length === 0) return result;

  const supabase = createServiceRoleClient();

  // Defensive title existence check — if the title disappeared
  // between caller's logic and this call, bail.
  const { data: title, error: titleErr } = await supabase
    .from("titles")
    .select("id")
    .eq("id", titleId)
    .maybeSingle();
  if (titleErr || !title) return result;

  // Resolve recipient pool.
  let userIds: string[];
  if (args.userIds) {
    userIds = Array.from(
      new Set(args.userIds.filter((id): id is string => Boolean(id))),
    );
  } else {
    // Map contentType to the title_requests.request_type the user
    // actually asked for. Clips and stills are both delivered via the
    // 'clips_and_stills' request_type; fan_edits is its own bucket.
    // Pre-fix this query pulled requesters for BOTH types, so a clip
    // upload would email people who only asked for fan edits.
    const requestType =
      contentType === "fan_edit" ? "fan_edits" : "clips_and_stills";
    const { data: requestRows, error: reqErr } = await supabase
      .from("title_requests")
      .select("user_id")
      .eq("title_id", titleId)
      .eq("request_type", requestType)
      .not("user_id", "is", null);
    if (reqErr) return result;
    userIds = Array.from(
      new Set(
        (requestRows ?? [])
          .map((r) => r.user_id as string | null)
          .filter((id): id is string => Boolean(id)),
      ),
    );
  }
  if (userIds.length === 0) return result;

  // Batch metadata lookups for filter decisions. 2D.3.1: chunk-and-merge over
  // userIds (≤100 ids/call) so the in.(…) URLs stay under the gateway cap when a
  // popular title has many requesters. Failure shape UNCHANGED — each query is
  // still read as `data ?? []` (a failed batch silently degrades to no-email /
  // default-pref / not-already-notified), the three still run in parallel per
  // chunk, and nothing throws.
  const emailByUser = new Map<string, string | null>();
  const prefByUser = new Map<string, { enabled: boolean }>();
  const alreadyNotified = new Set<string>();
  for (let i = 0; i < userIds.length; i += 100) {
    const chunk = userIds.slice(i, i + 100);
    const [usersRes, prefsRes, priorLogsRes] = await Promise.all([
      supabase.from("users").select("id, email").in("id", chunk),
      supabase
        .from("notification_preferences")
        .select("user_id, email_on_title_updates")
        .in("user_id", chunk),
      supabase
        .from("notification_log")
        .select("user_id, content_ids")
        .eq("title_id", titleId)
        .in("user_id", chunk)
        .overlaps("content_ids", contentIds),
    ]);
    for (const u of usersRes.data ?? []) {
      emailByUser.set(u.id as string, (u.email as string | null) ?? null);
    }
    for (const p of prefsRes.data ?? []) {
      prefByUser.set(p.user_id as string, {
        enabled: p.email_on_title_updates as boolean,
      });
    }
    for (const r of priorLogsRes.data ?? []) {
      alreadyNotified.add(r.user_id as string);
    }
  }

  // Insert default prefs for users that don't have a row yet. The
  // schema default is email_on_title_updates=true, so missing-prefs
  // users get opted in by default. Mirrors legacy behavior pre-queue.
  const missingPrefs = userIds.filter((id) => !prefByUser.has(id));
  if (missingPrefs.length > 0) {
    const { data: inserted } = await supabase
      .from("notification_preferences")
      .insert(missingPrefs.map((user_id) => ({ user_id })))
      .select("user_id, email_on_title_updates");
    for (const row of inserted ?? []) {
      prefByUser.set(row.user_id as string, {
        enabled: row.email_on_title_updates as boolean,
      });
    }
  }

  // Apply filters; collect enqueue rows.
  const toEnqueue: {
    userId: string;
    titleId: string;
    contentType: ContentType;
    contentIds: string[];
  }[] = [];
  for (const userId of userIds) {
    const pref = prefByUser.get(userId);
    if (!pref || !pref.enabled) {
      result.skipped_unsub += 1;
      continue;
    }
    if (alreadyNotified.has(userId)) {
      result.skipped_already += 1;
      continue;
    }
    const email = emailByUser.get(userId);
    if (!email) {
      result.skipped_no_email += 1;
      continue;
    }
    toEnqueue.push({ userId, titleId, contentType, contentIds });
  }

  if (toEnqueue.length === 0) return result;

  const { ids } = await enqueueEmailBatch(toEnqueue);
  result.enqueued = ids.length;
  result.enqueuedIds = ids;
  return result;
}
