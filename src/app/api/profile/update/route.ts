import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

const MAX_DISPLAY_NAME = 50;
const MAX_BIO = 200;
const MAX_LINKS = 5;
const MAX_LINK_LABEL = 30;
const MAX_LINK_URL = 200;

type Body = {
  display_name?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  links?: Array<{ label?: unknown; url?: unknown }> | null;
};

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const session = await verifySession();

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (body.display_name !== undefined) {
    if (body.display_name === null) {
      update.display_name = null;
    } else {
      const v = String(body.display_name).trim();
      if (v.length > MAX_DISPLAY_NAME) {
        return NextResponse.json(
          { error: `display_name max ${MAX_DISPLAY_NAME} chars` },
          { status: 400 },
        );
      }
      update.display_name = v.length === 0 ? null : v;
    }
  }

  if (body.bio !== undefined) {
    if (body.bio === null) {
      update.bio = null;
    } else {
      const v = String(body.bio);
      if (v.length > MAX_BIO) {
        return NextResponse.json(
          { error: `bio max ${MAX_BIO} chars` },
          { status: 400 },
        );
      }
      update.bio = v.trim().length === 0 ? null : v;
    }
  }

  if (body.avatar_url !== undefined) {
    if (body.avatar_url === null) {
      update.avatar_url = null;
    } else {
      const v = String(body.avatar_url).trim();
      if (v && !isHttpUrl(v)) {
        return NextResponse.json(
          { error: "invalid avatar_url" },
          { status: 400 },
        );
      }
      update.avatar_url = v || null;
    }
  }

  if (body.links !== undefined) {
    if (body.links === null) {
      update.links = [];
    } else {
      if (!Array.isArray(body.links)) {
        return NextResponse.json(
          { error: "links must be an array" },
          { status: 400 },
        );
      }
      if (body.links.length > MAX_LINKS) {
        return NextResponse.json(
          { error: `max ${MAX_LINKS} links` },
          { status: 400 },
        );
      }
      const cleaned: Array<{ label: string; url: string }> = [];
      for (const raw of body.links) {
        const label =
          typeof raw?.label === "string" ? raw.label.trim() : "";
        const url = typeof raw?.url === "string" ? raw.url.trim() : "";
        if (!label || !url) continue;
        if (label.length > MAX_LINK_LABEL) {
          return NextResponse.json(
            { error: `link label max ${MAX_LINK_LABEL} chars` },
            { status: 400 },
          );
        }
        if (url.length > MAX_LINK_URL || !isHttpUrl(url)) {
          return NextResponse.json(
            { error: `invalid link url: ${label}` },
            { status: 400 },
          );
        }
        cleaned.push({ label, url });
      }
      update.links = cleaned;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ success: true });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("users")
    .update(update)
    .eq("id", session.userId)
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // RLS can silently block an UPDATE: the call returns no error but 0 rows
  // are affected. Surface that as a real error so the client doesn't
  // believe a save succeeded when it didn't.
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "Update blocked — no rows affected (likely RLS)." },
      { status: 403 },
    );
  }

  return NextResponse.json({ success: true });
}
