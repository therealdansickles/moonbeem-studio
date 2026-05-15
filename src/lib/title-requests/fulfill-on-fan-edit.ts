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
  // Scope the update to request_type='fan_edits' only.
  //
  // Before this filter, the UPDATE also marked clips_and_stills
  // requests fulfilled and collected their user_ids — which were
  // then passed to notifyTitleRequesters with the explicit userIds
  // parameter, bypassing the request_type filter inside that
  // function (Block 2.1). The result was bystander emails to
  // clips_and_stills requesters about a fan_edit upload AND silent
  // closure of their actual request.
  //
  // Now: clips_and_stills requests stay open until an admin
  // uploads matching content. Only fan_edits requests close + emit
  // recipient emails when a fan_edit is imported.
  const { data: updated, error } = await supabase
    .from("title_requests")
    .update({ fulfilled_at: new Date().toISOString() })
    .eq("title_id", titleId)
    .eq("request_type", "fan_edits")
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
