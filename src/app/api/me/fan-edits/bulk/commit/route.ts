// User bulk commit — creates a bulk_import_jobs row, fires after()
// to process each pre-resolved/pre-parsed row via adminInsertFanEdit
// with verificationStatus='pending'. Mirrors the admin bulk commit
// pattern but: verified-tier only, user-owned creator, no title
// suggestion (client provides title_id per row).

import { NextResponse, after, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { adminInsertFanEdit } from "@/lib/fan-edits/insert";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";
import type { Platform } from "@/lib/fan-edits/url-parser";

const MAX_ROWS = 25;

type CommitRow = {
  idx: number;
  rawUrl: string;
  platform: Platform | null;
  contentId: string | null;
  normalizedUrl: string | null;
  handle: string | null;
  titleId: string | null;
  skip?: boolean;
};

type Body = { rows?: CommitRow[] };

export async function POST(request: NextRequest) {
  const session = await verifySession();
  const rl = await enforce(
    "userWrites",
    session.userId,
    "me/fan-edits/bulk/commit",
  );
  if (!rl.ok) return rl.response;

  const tier = await getUserTier(session.userId);
  const gate = canPerform(tier, "upload_fan_edit");
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.reason ?? "not_allowed" },
      { status: 403 },
    );
  }

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
      { error: `${MAX_ROWS} row limit (got ${rows.length})` },
      { status: 400 },
    );
  }

  const sb = createServiceRoleClient();
  const { data: ownCreator } = await sb
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!ownCreator?.id) {
    return NextResponse.json(
      { error: "no_creator — claim a Moonbeem handle first" },
      { status: 400 },
    );
  }

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
  const ownCreatorId = ownCreator.id as string;
  const userId = session.userId;

  after(async () => {
    await processJob(jobId, initialRows, ownCreatorId, userId);
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
  ownCreatorId: string,
  userId: string,
): Promise<void> {
  const sb = createServiceRoleClient();
  let succeeded = 0;
  let failed = 0;
  let skipped = rows.filter((r) => r.outcome === "skipped").length;
  let processed = skipped;

  for (const row of rows) {
    if (row.outcome === "skipped") continue;
    if (!row.titleId || !row.platform || !row.contentId || !row.normalizedUrl) {
      row.outcome = "failed";
      row.reason = "missing title_id / parsed URL fields";
      failed++;
      processed++;
      await sb
        .from("bulk_import_jobs")
        .update({ processed_rows: processed, failed_count: failed, rows })
        .eq("id", jobId);
      continue;
    }

    const result = await adminInsertFanEdit({
      titleId: row.titleId,
      embedUrl: row.normalizedUrl,
      platform: row.platform,
      postId: row.contentId,
      handle: row.handle,
      attributedCreatorId: ownCreatorId,
      caption: null,
      verificationStatus: "pending",
      createdByUserId: userId,
    });

    if (result.ok) {
      row.outcome = "ok";
      row.fanEditId = result.fanEditId;
      succeeded++;
    } else {
      row.outcome = result.kind === "duplicate" ? "skipped" : "failed";
      row.reason = result.reason;
      if (result.kind === "duplicate") skipped++;
      else failed++;
    }
    processed++;
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
