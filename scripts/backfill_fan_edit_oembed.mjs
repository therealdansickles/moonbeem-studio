#!/usr/bin/env node
// Backfill fan_edits.thumbnail_url + creator_handle_displayed from oembed.
//
// Covers TikTok and X this round; Instagram/YouTube are skipped (Instagram
// needs Meta auth, YouTube isn't on the priority list).
//
// Run with:
//   node scripts/backfill_fan_edit_oembed.mjs
//
// Requires SUPABASE_SERVICE_ROLE_KEY in the environment (writes need to
// bypass the public-read-only RLS policy on fan_edits). The script reads
// .env.local automatically.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotenvLocal() {
  const path = resolve(__dirname, "..", ".env.local");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotenvLocal();

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set the service role key in .env.local before running.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

function handleFromAuthorUrl(authorUrl) {
  if (!authorUrl) return null;
  try {
    const u = new URL(authorUrl);
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (!seg) return null;
    const stripped = seg.replace(/^@/, "");
    return stripped ? `@${stripped}` : null;
  } catch {
    return null;
  }
}

async function fetchTikTok(url) {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`TikTok oembed ${res.status}`);
  const data = await res.json();
  return {
    thumbnail_url: data.thumbnail_url ?? null,
    creator_handle: handleFromAuthorUrl(data.author_url),
    creator_url: data.author_url ?? null,
  };
}

async function fetchX(url) {
  const endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(
    url,
  )}&omit_script=1`;
  const res = await fetch(endpoint, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`X oembed ${res.status}`);
  const data = await res.json();
  let thumb = null;
  if (data.html) {
    const m = data.html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) thumb = m[1];
  }
  return {
    thumbnail_url: thumb,
    creator_handle: handleFromAuthorUrl(data.author_url),
    creator_url: data.author_url ?? null,
  };
}

async function fetchOembed(platform, url) {
  if (platform === "tiktok") return fetchTikTok(url);
  if (platform === "x") return fetchX(url);
  return { thumbnail_url: null, creator_handle: null, creator_url: null };
}

async function main() {
  const { data: rows, error } = await supabase
    .from("fan_edits")
    .select("id, platform, embed_url")
    .in("platform", ["tiktok", "x"])
    .is("thumbnail_url", null);

  if (error) {
    console.error("Failed to load fan_edits:", error.message);
    process.exit(1);
  }

  console.log(`Found ${rows.length} fan_edits to backfill.`);

  let updated = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const result = await fetchOembed(row.platform, row.embed_url);
      const patch = {
        oembed_fetched_at: new Date().toISOString(),
      };
      if (result.thumbnail_url) patch.thumbnail_url = result.thumbnail_url;
      if (result.creator_handle)
        patch.creator_handle_displayed = result.creator_handle;

      const { error: updErr } = await supabase
        .from("fan_edits")
        .update(patch)
        .eq("id", row.id);

      if (updErr) throw new Error(updErr.message);

      console.log(
        `  ${row.platform.padEnd(7)} ${row.id} → ${result.creator_handle ?? "(no handle)"} ${
          result.thumbnail_url ? "[thumb]" : "[no thumb]"
        }`,
      );
      updated++;
    } catch (err) {
      console.warn(`  ERROR ${row.platform} ${row.id}: ${err.message}`);
      errors++;
    }
  }

  console.log(
    `\nDone. Processed ${rows.length}, updated ${updated}, errors ${errors}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
