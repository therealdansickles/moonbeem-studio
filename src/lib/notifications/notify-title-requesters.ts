import { createServiceRoleClient } from "@/lib/supabase/service";
import { sendTitleUpdateEmail } from "@/lib/notifications/send-title-update-email";

export type ContentType = "clip" | "still" | "fan_edit";

export type NotifyArgs = {
  titleId: string;
  contentType: ContentType;
  contentIds: string[];
};

export type NotifyResult = {
  notified: number;
  skipped_unsub: number;
  skipped_already: number;
  failed: number;
  failed_user_ids: string[];
};

export async function notifyTitleRequesters(
  args: NotifyArgs,
): Promise<NotifyResult> {
  const { titleId, contentType, contentIds } = args;
  const result: NotifyResult = {
    notified: 0,
    skipped_unsub: 0,
    skipped_already: 0,
    failed: 0,
    failed_user_ids: [],
  };

  if (contentIds.length === 0) return result;

  const supabase = createServiceRoleClient();

  const { data: title, error: titleErr } = await supabase
    .from("titles")
    .select("id, slug, title")
    .eq("id", titleId)
    .maybeSingle();
  if (titleErr || !title) {
    return result;
  }

  const { data: requestRows, error: reqErr } = await supabase
    .from("title_requests")
    .select("user_id")
    .eq("title_id", titleId)
    .not("user_id", "is", null);
  if (reqErr) {
    return result;
  }

  const userIds = Array.from(
    new Set(
      (requestRows ?? [])
        .map((r) => r.user_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (userIds.length === 0) return result;

  const { data: usersRows } = await supabase
    .from("users")
    .select("id, email")
    .in("id", userIds);
  const emailById = new Map(
    (usersRows ?? []).map((u) => [u.id as string, (u.email as string | null) ?? null]),
  );

  const { data: prefRows } = await supabase
    .from("notification_preferences")
    .select("user_id, email_on_title_updates, unsubscribe_token")
    .in("user_id", userIds);
  const prefByUser = new Map(
    (prefRows ?? []).map((p) => [
      p.user_id as string,
      {
        enabled: p.email_on_title_updates as boolean,
        token: p.unsubscribe_token as string,
      },
    ]),
  );

  const missingPrefs = userIds.filter((id) => !prefByUser.has(id));
  if (missingPrefs.length > 0) {
    const { data: inserted } = await supabase
      .from("notification_preferences")
      .insert(missingPrefs.map((user_id) => ({ user_id })))
      .select("user_id, email_on_title_updates, unsubscribe_token");
    for (const row of inserted ?? []) {
      prefByUser.set(row.user_id as string, {
        enabled: row.email_on_title_updates as boolean,
        token: row.unsubscribe_token as string,
      });
    }
  }

  const { data: priorLogs } = await supabase
    .from("notification_log")
    .select("user_id, content_ids")
    .eq("title_id", titleId)
    .in("user_id", userIds)
    .overlaps("content_ids", contentIds);
  const alreadyNotified = new Set(
    (priorLogs ?? []).map((r) => r.user_id as string),
  );

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
    const email = emailById.get(userId);
    if (!email) {
      result.failed += 1;
      result.failed_user_ids.push(userId);
      await supabase.from("notification_log").insert({
        user_id: userId,
        title_id: titleId,
        content_type: contentType,
        content_ids: contentIds,
        status: "failed",
        error_text: "no email on file",
      });
      continue;
    }

    const send = await sendTitleUpdateEmail({
      to: email,
      titleName: title.title as string,
      titleSlug: title.slug as string,
      contentType,
      contentCount: contentIds.length,
      unsubscribeToken: pref.token,
    });

    if (send.ok) {
      result.notified += 1;
      await supabase.from("notification_log").insert({
        user_id: userId,
        title_id: titleId,
        content_type: contentType,
        content_ids: contentIds,
        resend_message_id: send.resendMessageId,
        status: "sent",
      });
    } else {
      result.failed += 1;
      result.failed_user_ids.push(userId);
      await supabase.from("notification_log").insert({
        user_id: userId,
        title_id: titleId,
        content_type: contentType,
        content_ids: contentIds,
        status: "failed",
        error_text: send.error.slice(0, 500),
      });
    }
  }

  return result;
}
