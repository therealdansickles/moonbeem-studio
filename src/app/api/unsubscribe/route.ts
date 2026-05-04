import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token") ?? "";

  if (!UUID_RE.test(token)) {
    return NextResponse.redirect(`${origin}/unsubscribe?invalid=1`);
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("notification_preferences")
    .update({ email_on_title_updates: false })
    .eq("unsubscribe_token", token)
    .select("user_id")
    .maybeSingle();

  if (error || !data) {
    return NextResponse.redirect(`${origin}/unsubscribe?invalid=1`);
  }

  return NextResponse.redirect(`${origin}/unsubscribe?ok=1`);
}
