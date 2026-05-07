// Public endpoint for FanEditModal user-action tracking.
//
// Auth is OPTIONAL — anonymous viewers count too. When the viewer is
// signed in, user_id is captured from the session cookie via getUser().
//
// Validation is permissive on shape (analytics shouldn't fail noisily)
// but strict on identity (fan_edit_id and event_type) so bad data
// doesn't reach the table.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";

const ALLOWED_EVENT_TYPES = [
  "modal_open",
  "modal_close",
  "view_on_platform_click",
] as const;
type EventType = (typeof ALLOWED_EVENT_TYPES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_ID_MAX_LEN = 64;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const obj = body as Record<string, unknown>;

  const fanEditId = obj.fan_edit_id;
  const eventType = obj.event_type;
  if (typeof fanEditId !== "string" || !UUID_RE.test(fanEditId)) {
    return NextResponse.json(
      { error: "invalid fan_edit_id" },
      { status: 400 },
    );
  }
  if (
    typeof eventType !== "string" ||
    !ALLOWED_EVENT_TYPES.includes(eventType as EventType)
  ) {
    return NextResponse.json(
      { error: "invalid event_type" },
      { status: 400 },
    );
  }

  const durationMsRaw = obj.duration_ms;
  const durationMs =
    typeof durationMsRaw === "number" && Number.isFinite(durationMsRaw)
      ? Math.max(0, Math.round(durationMsRaw))
      : null;

  const sessionIdRaw = obj.session_id;
  const sessionId =
    typeof sessionIdRaw === "string"
      ? sessionIdRaw.slice(0, SESSION_ID_MAX_LEN)
      : null;

  const metadataRaw = obj.metadata;
  const metadata =
    metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
      ? (metadataRaw as Record<string, unknown>)
      : null;

  const user = await getUser();

  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("fan_edit_events").insert({
    fan_edit_id: fanEditId,
    event_type: eventType,
    duration_ms: durationMs,
    user_id: user?.id ?? null,
    session_id: sessionId,
    metadata,
  });

  if (error) {
    console.error("[analytics] modal-event insert failed:", error.message);
    return NextResponse.json({ error: "insert failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
