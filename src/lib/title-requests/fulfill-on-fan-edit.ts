// Post-insert hook: when a fan_edit is published for a title, mark every
// open title_request for that title as fulfilled and email the requesters
// whose request just transitioned. Idempotent — re-running for an already-
// fulfilled title updates zero rows and sends zero emails.
//
// Called from the two fan_edit insert paths:
//   - src/lib/fan-edits-insert.ts (Discover tab add)
//   - src/app/api/admin/fan-edits/import/route.ts (CSV importer)
// Both pass their service-role supabase client. Caller wraps the call in
// try/catch — a fulfillment/notification failure must not block the
// insert response.

import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { notifyTitleRequesters } from "@/lib/notifications/notify-title-requesters";
import { drainQueue } from "@/lib/email-queue";

export type FulfillResult = {
  fulfilled_request_count: number;
  notified_user_ids: string[];
};

export async function fulfillTitleRequestsForFanEdit(
  supabase: SupabaseClient,
  titleId: string,
  fanEditId: string,
): Promise<FulfillResult> {
  // Atomically flip every open request for this title. The partial
  // index idx_title_requests_open keeps this O(open-rows-for-this-title).
  const { data: updated, error } = await supabase
    .from("title_requests")
    .update({ fulfilled_at: new Date().toISOString() })
    .eq("title_id", titleId)
    .is("fulfilled_at", null)
    .select("user_id");
  if (error) {
    throw new Error(`fulfillment update failed: ${error.message}`);
  }

  const userIds = Array.from(
    new Set(
      (updated ?? [])
        .map((r) => r.user_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  if (userIds.length === 0) {
    return { fulfilled_request_count: updated?.length ?? 0, notified_user_ids: [] };
  }

  const notify = await notifyTitleRequesters({
    titleId,
    contentType: "fan_edit",
    contentIds: [fanEditId],
    userIds,
  });

  // Hot-path drain via after(). Safe to call from a library function:
  // after() captures the surrounding route handler's request context,
  // and both callers (CSV importer + Discover add) are route handlers.
  if (notify.enqueuedIds.length > 0) {
    after(async () => {
      try {
        await drainQueue({ ids: notify.enqueuedIds, budgetMs: 25_000 });
      } catch (err) {
        console.error("after() drainQueue failed (fan-edit fulfillment)", err);
      }
    });
  }

  return {
    fulfilled_request_count: updated?.length ?? 0,
    notified_user_ids: userIds,
  };
}
