// Bulk fan_edits import via CSV upload.
//
// POST multipart/form-data with field "file" containing CSV. The
// route is super-admin gated and synchronous: parse, validate per
// row, insert, return a counter summary + per-row errors.
//
// Validation per row, in order (any failure → row rejected, error
// recorded, counters bumped):
//   - platform: trim, lowercase. 'x' auto-corrected to 'twitter' (+
//     warning entry). Anything outside (tiktok|instagram|youtube|
//     twitter) is rejected.
//   - embed_url: must parse as URL (new URL doesn't throw).
//   - TikTok-specific: vm.tiktok.com / vt.tiktok.com short URLs
//     rejected with a clear message — they don't carry the canonical
//     /@user/video/{id} shape EnsembleData expects.
//   - parseShortcodeFromUrl: must return non-null. Catches malformed
//     URLs at import time rather than at the first refresh attempt
//     ~24h later.
//   - title_id: valid UUID + must exist in titles table.
//   - Idempotency: skip if a fan_edit row already exists with this
//     embed_url.
//   - creator lookup via creator_socials JOIN creators (best-effort;
//     null creator_id is OK — creator_handle_displayed always
//     populated from CSV).

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { parseShortcodeFromUrl } from "@/lib/ensembledata/client";

const ALLOWED_PLATFORMS = ["tiktok", "instagram", "youtube", "twitter"] as const;
type AllowedPlatform = typeof ALLOWED_PLATFORMS[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CAPTION_MAX = 500;

type ImportError = {
  row: number;
  embed_url: string | null;
  reason: string;
};

type ImportResult = {
  imported: number;
  skipped_duplicates: number;
  skipped_invalid: number;
  errors: ImportError[];
};

// Minimal CSV parser. Handles quoted fields with commas, escaped
// double quotes, CRLF or LF line endings, leading UTF-8 BOM.
function parseCsv(text: string): string[][] {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      cur.push(field);
      // Skip trailing empty rows (typical of CSV files ending with newline).
      if (!(cur.length === 1 && cur[0] === "")) {
        rows.push(cur);
      }
      cur = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  return rows;
}

function indexHeaders(headerRow: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 0; i < headerRow.length; i++) {
    const norm = headerRow[i].trim().toLowerCase();
    map[norm] = i;
  }
  return map;
}

function getCol(
  row: string[],
  idx: Record<string, number>,
  name: string,
): string | null {
  const i = idx[name];
  if (i === undefined) return null;
  const v = row[i];
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function isTikTokShortenedHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "vm.tiktok.com" ||
    h === "vt.tiktok.com" ||
    h.endsWith(".vm.tiktok.com") ||
    h.endsWith(".vt.tiktok.com")
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  await requireSuperAdmin();

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Could not parse multipart body" },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing 'file' field (CSV upload required)" },
      { status: 400 },
    );
  }

  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return NextResponse.json(
      { error: "CSV needs at least a header row and one data row" },
      { status: 400 },
    );
  }

  const headerIdx = indexHeaders(rows[0]);
  const required = ["embed_url", "platform", "creator_handle", "title_id"];
  for (const col of required) {
    if (!(col in headerIdx)) {
      return NextResponse.json(
        { error: `Required column missing: ${col}` },
        { status: 400 },
      );
    }
  }

  const supabase = createServiceRoleClient();
  const result: ImportResult = {
    imported: 0,
    skipped_duplicates: 0,
    skipped_invalid: 0,
    errors: [],
  };

  // rows[0] is the header. data rows start at index 1; we report
  // 1-based row numbers as seen in the source file (header = row 1,
  // first data row = row 2).
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const csvRowNum = r + 1;

    const rawEmbedUrl = getCol(row, headerIdx, "embed_url");
    const rawPlatform = getCol(row, headerIdx, "platform");
    const rawHandle = getCol(row, headerIdx, "creator_handle");
    const rawTitleId = getCol(row, headerIdx, "title_id");

    const reportEmbedUrl = rawEmbedUrl ?? null;

    const reject = (reason: string) => {
      result.skipped_invalid += 1;
      result.errors.push({
        row: csvRowNum,
        embed_url: reportEmbedUrl,
        reason,
      });
    };

    if (!rawEmbedUrl) {
      reject("missing embed_url");
      continue;
    }
    if (!rawPlatform) {
      reject("missing platform");
      continue;
    }
    if (!rawTitleId) {
      reject("missing title_id");
      continue;
    }

    let platform = rawPlatform.toLowerCase();
    if (platform === "x") {
      platform = "twitter";
      result.errors.push({
        row: csvRowNum,
        embed_url: reportEmbedUrl,
        reason: "warning: auto-corrected platform 'x' to 'twitter'",
      });
    }
    if (!ALLOWED_PLATFORMS.includes(platform as AllowedPlatform)) {
      reject(`platform '${rawPlatform}' not supported (allowed: ${ALLOWED_PLATFORMS.join("|")})`);
      continue;
    }

    let urlObj: URL;
    try {
      urlObj = new URL(rawEmbedUrl);
    } catch {
      reject("embed_url could not be parsed as a URL");
      continue;
    }

    if (platform === "tiktok" && isTikTokShortenedHost(urlObj.hostname)) {
      reject(
        "TikTok shortened URLs not supported, use canonical form https://www.tiktok.com/@user/video/{id}",
      );
      continue;
    }

    const shortcode = parseShortcodeFromUrl(rawEmbedUrl, platform);
    if (!shortcode) {
      reject(
        `parse_failure: could not extract id/shortcode from embed_url for platform '${platform}'`,
      );
      continue;
    }

    if (!UUID_RE.test(rawTitleId)) {
      reject("title_id is not a valid UUID");
      continue;
    }

    const { data: titleRow, error: titleErr } = await supabase
      .from("titles")
      .select("id")
      .eq("id", rawTitleId)
      .maybeSingle();
    if (titleErr) {
      reject(`title lookup failed: ${titleErr.message}`);
      continue;
    }
    if (!titleRow) {
      reject(`title_id ${rawTitleId} not found in titles`);
      continue;
    }

    // Idempotency check.
    const { data: existing, error: existErr } = await supabase
      .from("fan_edits")
      .select("id")
      .eq("embed_url", rawEmbedUrl)
      .maybeSingle();
    if (existErr) {
      reject(`duplicate check failed: ${existErr.message}`);
      continue;
    }
    if (existing) {
      result.skipped_duplicates += 1;
      result.errors.push({
        row: csvRowNum,
        embed_url: reportEmbedUrl,
        reason: "already_imported",
      });
      continue;
    }

    // Creator lookup. Strip leading @, lowercase. Only attempt if
    // platform is one of the values creator_socials.platform allows
    // ('tiktok','instagram','youtube' per the initial schema CHECK).
    // Twitter creator_socials rows don't exist by design, so we skip
    // the lookup for twitter — creator_id stays null.
    let creatorId: string | null = null;
    let displayedHandle: string | null = null;
    if (rawHandle) {
      displayedHandle = rawHandle.replace(/^@+/, "").trim().toLowerCase();
      if (
        displayedHandle &&
        (platform === "tiktok" || platform === "instagram" || platform === "youtube")
      ) {
        const { data: socialRow } = await supabase
          .from("creator_socials")
          .select("creator_id")
          .eq("handle", displayedHandle)
          .eq("platform", platform)
          .maybeSingle();
        if (socialRow?.creator_id) {
          creatorId = socialRow.creator_id as string;
        }
      }
    }

    // Other recommended/optional columns — null when missing.
    const rawCaption = getCol(row, headerIdx, "caption");
    const caption = rawCaption ? rawCaption.slice(0, CAPTION_MAX) : null;
    const rawPostedAt = getCol(row, headerIdx, "posted_at");
    let postedAt: string | null = null;
    if (rawPostedAt) {
      const d = new Date(rawPostedAt);
      if (!Number.isNaN(d.getTime())) {
        postedAt = d.toISOString();
      }
    }
    const thumbnailUrl = getCol(row, headerIdx, "thumbnail_url");

    const insertRow = {
      title_id: rawTitleId,
      creator_id: creatorId,
      creator_handle_displayed: displayedHandle,
      platform,
      embed_url: rawEmbedUrl,
      caption,
      posted_at: postedAt,
      thumbnail_url: thumbnailUrl,
      verification_status: "auto_verified",
      view_tracking_status: "active",
      // Counters use schema defaults (0).
    };

    const { error: insertErr } = await supabase
      .from("fan_edits")
      .insert(insertRow);
    if (insertErr) {
      reject(`insert failed: ${insertErr.code ?? ""} ${insertErr.message}`);
      continue;
    }
    result.imported += 1;
  }

  return NextResponse.json(result);
}
