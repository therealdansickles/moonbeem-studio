// GET/PUT /api/me/consent
//
// Signed-in users persist their banner choice server-side so the
// banner doesn't re-prompt on a different device. Anonymous visitors
// don't hit these endpoints — their state lives in the cookie only
// (ConsentProvider writes the cookie unconditionally; the API call
// fires only when user is non-null).
//
// PUT (not PATCH) because consent is a single document; partial
// updates would invite ambiguity ("did Analytics=true land but
// SessionRecording stay nil?"). Clients always send the full state.
//
// GET returns { consent_state } (jsonb or null). 401 for anonymous
// callers — we deliberately don't let anon callers probe whether
// other users have set a value via a fake auth.uid().

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

const CONSENT_VERSION = 1;

type ConsentBody = {
  analytics?: unknown;
  session_recording?: unknown;
};

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data, error } = await supabase
    .from("users")
    .select("consent_state")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ consent_state: data?.consent_state ?? null });
}

export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: ConsentBody;
  try {
    body = (await request.json()) as ConsentBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (
    typeof body.analytics !== "boolean" ||
    typeof body.session_recording !== "boolean"
  ) {
    return NextResponse.json(
      { error: "analytics + session_recording must be boolean" },
      { status: 400 },
    );
  }

  const consent_state = {
    analytics: body.analytics,
    session_recording: body.session_recording,
    updated_at: new Date().toISOString(),
    version: CONSENT_VERSION,
  };

  const { error } = await supabase
    .from("users")
    .update({ consent_state })
    .eq("id", user.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, consent_state });
}
