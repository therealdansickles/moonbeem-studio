// Creator API-token CRUD (web-UI-facing; cookie/session-gated, NOT
// token-gated — these are called by the future Stage-2 settings UI while
// the creator is signed in). This is NOT the panel-facing API.
//
//   POST /api/me/api-tokens  — create a token; returns the RAW token EXACTLY
//                              ONCE plus safe metadata. The raw token is never
//                              persisted and never returned again.
//   GET  /api/me/api-tokens  — list the caller's tokens (safe columns only;
//                              NEVER token_hash).
//
// Reads/writes go through the service-role client because api_tokens has
// RLS enabled with NO policies (token_hash unreachable by any client JWT).
// Scoped to the caller's user_id so this can't touch another creator's tokens.
//
// MONEY BOUNDARY: imports only verifySession (identity), the service-role
// client, the rate-limiter, and the token crypto util. No money code; scopes
// are validated against a content-only allowlist (and the DB CHECK-constrains
// them too), so a token can never carry a money capability.

import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";
import {
  CONTENT_SCOPES,
  generateApiToken,
  hashApiToken,
  isContentScope,
} from "@/lib/api-tokens/crypto";

const NAME_MAX = 80;

// Columns safe to return to the client. token_hash is deliberately absent.
const SAFE_COLUMNS =
  "id, name, token_prefix, scopes, created_at, last_used_at, revoked_at, expires_at";

type CreateBody = {
  name?: unknown;
  scopes?: unknown;
  expires_at?: unknown;
};

export async function POST(request: NextRequest) {
  const session = await verifySession();
  const limit = await enforce("userWrites", session.userId, "me/api-tokens:create");
  if (!limit.ok) return limit.response;

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }

  // Scopes: default to the full content-only set; if supplied, every
  // entry must be in the content-only allowlist (reject money / unknown).
  let scopes: string[] = [...CONTENT_SCOPES];
  if (body.scopes !== undefined) {
    if (
      !Array.isArray(body.scopes) ||
      body.scopes.length === 0 ||
      !body.scopes.every((s) => typeof s === "string" && isContentScope(s))
    ) {
      return NextResponse.json({ error: "invalid_scopes" }, { status: 400 });
    }
    scopes = Array.from(new Set(body.scopes as string[]));
  }

  // Optional expiry. Must be a valid future ISO timestamp if provided.
  let expiresAt: string | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null) {
    if (typeof body.expires_at !== "string") {
      return NextResponse.json({ error: "invalid_expires_at" }, { status: 400 });
    }
    const ms = Date.parse(body.expires_at);
    if (Number.isNaN(ms) || ms <= Date.now()) {
      return NextResponse.json({ error: "invalid_expires_at" }, { status: 400 });
    }
    expiresAt = new Date(ms).toISOString();
  }

  const supabase = createServiceRoleClient();

  // Token acts AS a creator; require one to exist now so the token isn't
  // dead-on-arrival (verifyApiToken rejects token users with no creator).
  const { data: creator } = await supabase
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator?.id) {
    return NextResponse.json(
      { error: "no_creator" },
      { status: 400 },
    );
  }

  // Generate + insert. token_hash is globally unique; a 256-bit collision
  // is astronomically unlikely, but retry once on 23505 for completeness
  // (mirrors the affiliate-code unique-violation handling).
  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = generateApiToken();
    const tokenHash = await hashApiToken(generated.token);

    const { data: inserted, error } = await supabase
      .from("api_tokens")
      .insert({
        user_id: session.userId,
        name,
        token_prefix: generated.displayPrefix,
        token_hash: tokenHash,
        scopes,
        expires_at: expiresAt,
      })
      .select(SAFE_COLUMNS)
      .maybeSingle();

    if (!error && inserted) {
      // The raw token is surfaced to the caller EXACTLY ONCE, here.
      return NextResponse.json(
        { ok: true, token: generated.token, api_token: inserted },
        { status: 201 },
      );
    }
    if (error && error.code === "23505") continue; // hash collision — re-mint
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "token_generation_failed" }, { status: 500 });
}

export async function GET() {
  const session = await verifySession();
  const limit = await enforce("userWrites", session.userId, "me/api-tokens:list");
  if (!limit.ok) return limit.response;

  const supabase = createServiceRoleClient();
  const { data: tokens, error } = await supabase
    .from("api_tokens")
    .select(SAFE_COLUMNS)
    .eq("user_id", session.userId)
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ api_tokens: tokens ?? [] });
}
