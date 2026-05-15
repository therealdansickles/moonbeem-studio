// Bulk CSV preview — POST a CSV upload, get back a per-row analysis
// (URL parse + title suggestion) the admin can review before commit.
// No DB writes. Pure read + ranking.
//
// CSV format:
//   Required: url, suggested_title
//   Optional: suggested_year, creator_handle, notes
//
// 100 rows max — researcher batches stay under this in practice and
// it gives a useful daily-quota guardrail (EnsembleData Wood plan is
// 1500 calls/day).

import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { parseFanEditUrl } from "@/lib/fan-edits/url-parser";
import { parseCsv, indexHeaders, getCol } from "@/lib/fan-edits/csv";

const MAX_ROWS = 100;

type PreviewRowOut = {
  idx: number;
  rawUrl: string;
  platform: string | null;
  contentId: string | null;
  normalizedUrl: string | null;
  handle: string | null;
  suggestedTitleQuery: string | null;
  suggestedYear: number | null;
  notes: string | null;
  // Title attribution suggestion. confidence: exact|fuzzy|none.
  suggestion: {
    titleId: string | null;
    titleName: string | null;
    titleSlug: string | null;
    year: number | null;
    distributor: string | null;
    confidence: "exact" | "fuzzy" | "none";
  };
  // 'ready' = good to commit; 'review' = parsed but no clear title;
  // 'skip' = unparseable / will not commit.
  status: "ready" | "review" | "skip";
  error: string | null;
};

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const rl = await enforce(
    "admin",
    session.userId,
    "admin/fan-edits/bulk/preview",
  );
  if (!rl.ok) return rl.response;

  // Accept multipart (file=<csv>) or text/plain body
  const ctype = request.headers.get("content-type") ?? "";
  let csvText = "";
  if (ctype.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json(
        { error: "file field required (multipart)" },
        { status: 400 },
      );
    }
    csvText = await file.text();
  } else {
    csvText = await request.text();
  }
  if (!csvText.trim()) {
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return NextResponse.json(
      { error: "csv must have a header row + at least one data row" },
      { status: 400 },
    );
  }

  const headerIdx = indexHeaders(rows[0]);
  if (!("url" in headerIdx)) {
    return NextResponse.json(
      { error: "Required column missing: url" },
      { status: 400 },
    );
  }
  if (!("suggested_title" in headerIdx)) {
    return NextResponse.json(
      { error: "Required column missing: suggested_title" },
      { status: 400 },
    );
  }

  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_ROWS) {
    return NextResponse.json(
      {
        error: `100 row limit (got ${dataRows.length}). Split the CSV and try again.`,
      },
      { status: 400 },
    );
  }

  const sb = createServiceRoleClient();
  const out: PreviewRowOut[] = [];

  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r];
    const idx = r;
    const rawUrl = getCol(row, headerIdx, "url") ?? "";
    const suggestedTitleQ = getCol(row, headerIdx, "suggested_title");
    const yearRaw = getCol(row, headerIdx, "suggested_year");
    const handleRaw = getCol(row, headerIdx, "creator_handle");
    const notes = getCol(row, headerIdx, "notes");

    let yearParsed: number | null = null;
    if (yearRaw) {
      const n = Number(yearRaw);
      if (Number.isFinite(n)) yearParsed = n;
    }

    if (!rawUrl) {
      out.push({
        idx,
        rawUrl: "",
        platform: null,
        contentId: null,
        normalizedUrl: null,
        handle: null,
        suggestedTitleQuery: suggestedTitleQ,
        suggestedYear: yearParsed,
        notes,
        suggestion: {
          titleId: null,
          titleName: null,
          titleSlug: null,
          year: null,
          distributor: null,
          confidence: "none",
        },
        status: "skip",
        error: "missing url",
      });
      continue;
    }

    const parsed = parseFanEditUrl(rawUrl);
    if (!parsed) {
      out.push({
        idx,
        rawUrl,
        platform: null,
        contentId: null,
        normalizedUrl: null,
        handle: handleRaw,
        suggestedTitleQuery: suggestedTitleQ,
        suggestedYear: yearParsed,
        notes,
        suggestion: {
          titleId: null,
          titleName: null,
          titleSlug: null,
          year: null,
          distributor: null,
          confidence: "none",
        },
        status: "skip",
        error: "unrecognized URL — supported: TikTok, Instagram, X, YouTube",
      });
      continue;
    }

    // Title suggestion via search_titles_admin. Use the suggested
    // title text; year is used as a tiebreaker on the client side
    // (we surface ALL matches above the confidence threshold).
    let suggestion: PreviewRowOut["suggestion"] = {
      titleId: null,
      titleName: null,
      titleSlug: null,
      year: null,
      distributor: null,
      confidence: "none",
    };
    if (suggestedTitleQ && suggestedTitleQ.length >= 2) {
      const { data: matches } = await sb.rpc("search_titles_admin", {
        query: suggestedTitleQ,
        max_results: 5,
      });
      const list = (matches ?? []) as Array<{
        id: string;
        slug: string;
        title: string;
        year: number | null;
        distributor: string | null;
      }>;
      // Prefer year match when provided.
      let pick = list[0];
      if (yearParsed != null) {
        const yearMatch = list.find((m) => m.year === yearParsed);
        if (yearMatch) pick = yearMatch;
      }
      if (pick) {
        const exactByName =
          pick.title.toLowerCase() === suggestedTitleQ.toLowerCase();
        const yearOk =
          yearParsed == null || pick.year == null
            ? true
            : pick.year === yearParsed;
        suggestion = {
          titleId: pick.id,
          titleName: pick.title,
          titleSlug: pick.slug,
          year: pick.year,
          distributor: pick.distributor,
          confidence: exactByName && yearOk ? "exact" : "fuzzy",
        };
      }
    }

    const status: PreviewRowOut["status"] =
      suggestion.confidence === "exact"
        ? "ready"
        : suggestion.confidence === "fuzzy"
          ? "review"
          : "review";

    out.push({
      idx,
      rawUrl,
      platform: parsed.platform,
      contentId: parsed.contentId,
      normalizedUrl: parsed.normalizedUrl,
      handle: handleRaw ?? parsed.handle,
      suggestedTitleQuery: suggestedTitleQ,
      suggestedYear: yearParsed,
      notes,
      suggestion,
      status,
      error: null,
    });
  }

  return NextResponse.json({
    ok: true,
    total: out.length,
    ready: out.filter((r) => r.status === "ready").length,
    review: out.filter((r) => r.status === "review").length,
    skip: out.filter((r) => r.status === "skip").length,
    rows: out,
  });
}
