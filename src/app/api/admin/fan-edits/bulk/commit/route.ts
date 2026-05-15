// Bulk commit — accepts the (possibly admin-modified) preview JSON,
// creates a bulk_import_jobs row, fires after() to do the actual
// EnsembleData fetches + fan_edits inserts in the background, and
// returns the job_id immediately. Client polls GET /jobs/[id].
//
// Why async: 100 rows × serial EnsembleData fetch ≈ 30-90s wall
// time, past Vercel's default function ceiling. The job row records
// per-row outcome so the UI can show "X added, Y failed" + the
// specific failure reasons.

import { NextResponse, after, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { adminInsertFanEdit } from "@/lib/fan-edits/insert";
import type { Platform } from "@/lib/fan-edits/url-parser";

const MAX_ROWS = 100;

// Shape the client sends — matches preview output minus the
// suggestion sub-tree. Admin may have overridden title_id and/or
// flipped skip on each row.
type CommitRow = {
  idx: number;
  rawUrl: string;
  platform: Platform | null;
  contentId: string | null;
  normalizedUrl: string | null;
  handle: string | null;
  titleId: string | null;
  notes?: string | null;
  skip?: boolean;
};

type Body = { rows?: CommitRow[] };

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const rl = await enforce(
    "admin",
    session.userId,
    "admin/fan-edits/bulk/commit",
  );
  if (!rl.ok) return rl.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return NextResponse.json({ error: "rows[] required" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `100 row limit (got ${rows.length})` },
      { status: 400 },
    );
  }

  const sb = createServiceRoleClient();

  // Decorate each row with an initial outcome so the GET endpoint
  // can report progress immediately.
  const initialRows = rows.map((r) => ({
    ...r,
    outcome: (r.skip ? "skipped" : "pending") as
      | "pending"
      | "ok"
      | "failed"
      | "skipped",
    reason: null as string | null,
    fanEditId: null as string | null,
  }));

  const skipCount = initialRows.filter((r) => r.outcome === "skipped").length;
  const { data: job, error: jobErr } = await sb
    .from("bulk_import_jobs")
    .insert({
      user_id: session.userId,
      status: "processing",
      total_rows: initialRows.length,
      processed_rows: skipCount,
      skipped_count: skipCount,
      rows: initialRows,
    })
    .select("id")
    .maybeSingle();
  if (jobErr || !job) {
    return NextResponse.json(
      { error: `job create failed: ${jobErr?.message ?? "no row"}` },
      { status: 500 },
    );
  }
  const jobId = job.id as string;

  // Fire-and-forget worker. after() runs after the response is sent
  // but inside the same function invocation — fine for jobs that
  // complete within the function timeout. For larger jobs we'd
  // need a separate worker / queue; today's MAX_ROWS=100 is well
  // within budget.
  after(async () => {
    await processJob(jobId, initialRows);
  });

  return NextResponse.json({ ok: true, job_id: jobId });
}

async function processJob(
  jobId: string,
  rows: Array<
    CommitRow & {
      outcome: "pending" | "ok" | "failed" | "skipped";
      reason: string | null;
      fanEditId: string | null;
    }
  >,
): Promise<void> {
  const sb = createServiceRoleClient();
  let succeeded = 0;
  let failed = 0;
  let skipped = rows.filter((r) => r.outcome === "skipped").length;
  let processed = skipped;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.outcome === "skipped") continue;

    if (!row.titleId || !row.platform || !row.contentId || !row.normalizedUrl) {
      row.outcome = "failed";
      row.reason = "missing title_id / parsed URL fields";
      failed++;
      processed++;
      await sb
        .from("bulk_import_jobs")
        .update({
          processed_rows: processed,
          failed_count: failed,
          rows,
        })
        .eq("id", jobId);
      continue;
    }

    const result = await adminInsertFanEdit({
      titleId: row.titleId,
      embedUrl: row.normalizedUrl,
      platform: row.platform,
      postId: row.contentId,
      handle: row.handle,
      caption: null,
    });

    if (result.ok) {
      row.outcome = "ok";
      row.fanEditId = result.fanEditId;
      succeeded++;
    } else {
      row.outcome = result.kind === "duplicate" ? "skipped" : "failed";
      row.reason = result.reason;
      if (result.kind === "duplicate") {
        skipped++;
      } else {
        failed++;
      }
    }
    processed++;
    // Persist incremental progress so /jobs/[id] polling shows
    // real-time updates without waiting for the loop to finish.
    await sb
      .from("bulk_import_jobs")
      .update({
        processed_rows: processed,
        succeeded_count: succeeded,
        failed_count: failed,
        skipped_count: skipped,
        rows,
      })
      .eq("id", jobId);
  }

  await sb
    .from("bulk_import_jobs")
    .update({
      status: "completed",
      processed_rows: processed,
      succeeded_count: succeeded,
      failed_count: failed,
      skipped_count: skipped,
      rows,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}
