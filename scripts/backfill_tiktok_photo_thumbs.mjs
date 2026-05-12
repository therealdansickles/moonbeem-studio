#!/usr/bin/env node
// One-shot: backfill thumbnail_url for TikTok photo carousel fan_edits
// by calling EnsembleData directly. Pulls origin_cover from video block.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotenvLocal() {
  const path = resolve(__dirname, "..", ".env.local");
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return; }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotenvLocal();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENSEMBLE_TOKEN = "hZGIjCbBz3WYknUt";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

async function fetchTikTokThumb(url) {
  const endpoint = `https://ensembledata.com/apis/tt/post/info?url=${encodeURIComponent(url)}&token=${ENSEMBLE_TOKEN}`;
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error(`EnsembleData ${res.status}`);
  const data = await res.json();
  const first = data?.data?.[0];
  if (!first) throw new Error("no data[0]");
  const video = first.video || {};
  const originCover = video.origin_cover?.url_list?.[0];
  const cover = video.cover?.url_list?.[0];
  return originCover || cover || null;
}

async function main() {
  const { data: rows, error } = await supabase
    .from("fan_edits")
    .select("id, embed_url")
    .eq("platform", "tiktok")
    .is("thumbnail_url", null);

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  console.log(`Found ${rows.length} TikTok rows missing thumbnails.`);
  let updated = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const thumb = await fetchTikTokThumb(row.embed_url);
      if (!thumb) {
        console.warn(`  SKIP ${row.id}: no thumb in response`);
        continue;
      }
      const { error: upErr } = await supabase
        .from("fan_edits")
        .update({ thumbnail_url: thumb })
        .eq("id", row.id);
      if (upErr) throw new Error(upErr.message);
      console.log(`  OK   ${row.id}`);
      updated++;
    } catch (err) {
      console.warn(`  ERR  ${row.id}: ${err.message}`);
      errors++;
    }
    // small pause to not blow EnsembleData rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone. Updated ${updated}, errors ${errors}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
