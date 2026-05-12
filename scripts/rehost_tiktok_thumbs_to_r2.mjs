#!/usr/bin/env node
// Rehost TikTok thumbnails to R2 as JPEG.
// Converts HEIC (photo carousels) via heic-convert.
// Converts everything else (WebP, PNG, etc.) via sharp.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import convertHeic from "heic-convert";

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
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const ENSEMBLEDATA_TOKEN = process.env.ENSEMBLEDATA_TOKEN || "hZGIjCbBz3WYknUt";

for (const [k, v] of Object.entries({
  SUPABASE_URL, SERVICE_KEY, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL,
})) {
  if (!v) { console.error(`Missing ${k}`); process.exit(1); }
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

function hash(s) { return createHash("sha256").update(s).digest("hex"); }
function hmac(key, s) { return createHmac("sha256", key).update(s).digest(); }

async function putToR2(key, bytes) {
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = `https://${host}/${R2_BUCKET_NAME}/${key}`;
  const contentType = "image/jpeg";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const payloadHash = createHash("sha256").update(bytes).digest("hex");

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest =
    `PUT\n/${R2_BUCKET_NAME}/${key}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hash(canonicalRequest)}`;

  const kDate = hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Host": host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "Authorization": authHeader,
    },
    body: bytes,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`R2 PUT ${res.status}: ${errText.slice(0, 200)}`);
  }
  return `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

async function convertToJpeg(sourceBytes, contentType) {
  // HEIC requires heic-convert; sharp without libheif can't handle it.
  if (contentType && contentType.includes("heic")) {
    const jpegBuf = await convertHeic({
      buffer: sourceBytes,
      format: "JPEG",
      quality: 0.85,
    });
    return Buffer.from(jpegBuf);
  }
  // Everything else (JPEG, WebP, PNG, etc.) sharp handles natively.
  return await sharp(sourceBytes).jpeg({ quality: 85 }).toBuffer();
}

async function fetchFreshTikTokThumb(embedUrl) {
  const apiUrl = `https://ensembledata.com/apis/tt/post/info?url=${
    encodeURIComponent(embedUrl)
  }&token=${encodeURIComponent(ENSEMBLEDATA_TOKEN)}`;
  const ed = await fetch(apiUrl);
  if (!ed.ok) throw new Error(`EnsembleData ${ed.status}`);
  const body = await ed.json();
  const first = body?.data?.[0];
  if (!first) throw new Error("EnsembleData returned no data");

  // For photo posts, prefer image_post_info.images[0] over video.origin_cover.
  // The video.origin_cover on a photo post is the HEIC cover; image_post_info
  // typically has a JPEG variant.
  const imagesArr = first?.image_post_info?.images;
  if (Array.isArray(imagesArr) && imagesArr.length > 0) {
    // Try display_image (regular JPEG) first, fall back to others.
    const img0 = imagesArr[0];
    const candidates = [
      img0?.display_image?.url_list?.[0],
      img0?.owner_watermark_image?.url_list?.[0],
      img0?.user_watermark_image?.url_list?.[0],
      img0?.thumbnail?.url_list?.[0],
    ].filter(Boolean);
    if (candidates.length > 0) return candidates[0];
  }

  // Fall back to video cover (works for actual video posts).
  return first?.video?.origin_cover?.url_list?.[0] ??
         first?.video?.cover?.url_list?.[0] ??
         null;
}

async function rehostOne(id, sourceUrl, embedUrl) {
  let url = sourceUrl;
  // If thumbnail_url already points at R2 (the broken HEIC), refetch
  // from EnsembleData. Also re-fetch if we know it'll be HEIC.
  if (url.includes("r2.dev")) {
    url = await fetchFreshTikTokThumb(embedUrl);
    if (!url) throw new Error("no TikTok thumb URL in EnsembleData response");
  }

  const fetchRes = await fetch(url);
  if (!fetchRes.ok) throw new Error(`source fetch ${fetchRes.status}`);
  const contentType = fetchRes.headers.get("content-type") ?? "";
  const sourceBytes = Buffer.from(await fetchRes.arrayBuffer());

  let jpegBytes;
  try {
    jpegBytes = await convertToJpeg(sourceBytes, contentType);
  } catch (err) {
    // If conversion fails AND we got a HEIC, try refetching from
    // EnsembleData looking for the JPEG variant in image_post_info.
    if (contentType.includes("heic") && embedUrl) {
      const fresh = await fetchFreshTikTokThumb(embedUrl);
      if (fresh && fresh !== url) {
        const r2 = await fetch(fresh);
        if (!r2.ok) throw new Error(`retry source fetch ${r2.status}`);
        const ct2 = r2.headers.get("content-type") ?? "";
        const bytes2 = Buffer.from(await r2.arrayBuffer());
        jpegBytes = await convertToJpeg(bytes2, ct2);
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const key = `fan_edits/${id}/thumb.jpg`;
  return await putToR2(key, jpegBytes);
}

async function main() {
  const { data: rows, error } = await supabase
    .from("fan_edits")
    .select("id, embed_url, thumbnail_url")
    .eq("platform", "tiktok")
    .or("thumbnail_url.like.%r2.dev%,thumbnail_url.like.%tiktokcdn%");

  if (error) { console.error("Query failed:", error.message); process.exit(1); }
  console.log(`Found ${rows.length} TikTok rows to (re)process.`);

  let updated = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const r2Url = await rehostOne(row.id, row.thumbnail_url, row.embed_url);
      const { error: upErr } = await supabase
        .from("fan_edits")
        .update({ thumbnail_url: r2Url })
        .eq("id", row.id);
      if (upErr) throw new Error(upErr.message);
      console.log(`  OK   ${row.id}`);
      updated++;
    } catch (err) {
      console.warn(`  ERR  ${row.id}: ${err.message.split("\n")[0]}`);
      errors++;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\nDone. Updated ${updated}, errors ${errors}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
