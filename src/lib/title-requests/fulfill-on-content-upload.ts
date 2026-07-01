// Post-insert hook: when an admin uploads clips or stills for a title, mark
// every OPEN title_request of the matching type ('clips' or 'stills') as
// fulfilled. The 2026-07-01 split made clips and stills independent request
// types — a clip upload closes ONLY 'clips' requests, a still upload closes
// ONLY 'stills' requests (previously both shared 'clips_and_stills').
//
// Mirrors fulfill-on-fan-edit.ts's service-role update + user_id dedup + return
// shape, but is FIRE-AND-FORGET: a fulfillment failure must never break the
// upload response, so it catches + logs and returns a zero result instead of
// throwing. Requester notification stays in the routes (their existing
// notifyTitleRequesters call), so this helper is fulfillment-only.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ContentRequestType = "clips" | "stills";

export type FulfillContentResult = {
  fulfilled_request_count: number;
  user_ids: string[];
};

export async function fulfillTitleRequestsForContent(
  supabase: SupabaseClient,
  titleId: string,
  requestType: ContentRequestType,
): Promise<FulfillContentResult> {
  try {
    const { data: updated, error } = await supabase
      .from("title_requests")
      .update({ fulfilled_at: new Date().toISOString() })
      .eq("title_id", titleId)
      .eq("request_type", requestType)
      .is("fulfilled_at", null)
      .select("user_id");
    if (error) {
      console.error(
        `mark requests fulfilled failed (${requestType} batch)`,
        error.message,
      );
      return { fulfilled_request_count: 0, user_ids: [] };
    }
    const user_ids = Array.from(
      new Set(
        (updated ?? [])
          .map((r) => r.user_id as string | null)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    return { fulfilled_request_count: updated?.length ?? 0, user_ids };
  } catch (err) {
    console.error(`mark requests fulfilled threw (${requestType} batch)`, err);
    return { fulfilled_request_count: 0, user_ids: [] };
  }
}
