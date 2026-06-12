// Phase 2C — Letterboxd import APPLY. Writes the previewed rows into the four
// content surfaces as PRIVATE, by replaying the job's pinned payload through the
// apply_letterboxd_import RPC (one transaction, ON CONFLICT DO NOTHING — safe to
// retry). Synchronous: unlike the import POST it does NOT use after()/polling —
// the RPC's set-based inserts return in well under a second, so the route awaits
// it and returns the applied counts directly.

import { NextResponse, type NextRequest } from "next/server";
import { requireCreatorForImport } from "@/lib/letterboxd/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generous ceiling for the RPC + the few guard queries (the RPC itself is bound
// by service_role's ~8s statement_timeout). 60 is valid on every Vercel plan
// (see the import route's note).
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  // Identical gating chain to the import POST (auth → userWrites rate limit →
  // import_letterboxd capability → resolved creator).
  const gate = await requireCreatorForImport("me/letterboxd/apply");
  if ("error" in gate) return gate.error;
  const { userId, creatorId } = gate;

  let body: { job_id?: string };
  try {
    body = (await request.json()) as { job_id?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const jobId = (body.job_id ?? "").trim();
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ error: "invalid job_id" }, { status: 400 });
  }

  const sb = createServiceRoleClient();

  // Owner-scoped (a job that isn't the caller's reads as 404, not 403, so job
  // ids aren't an existence oracle) AND the Phase-0 mandate: the job's creator
  // must resolve to the caller's own creator.
  const { data: job } = await sb
    .from("letterboxd_import_jobs")
    .select("id, user_id, creator_id, status")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || (job.user_id as string) !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if ((job.creator_id as string | null) !== creatorId) {
    return NextResponse.json({ error: "creator_mismatch" }, { status: 403 });
  }

  // Legacy jobs (created before 2C) have no pinned payload and cannot be applied
  // — the preview is display-only. Check presence with a HEAD count so the
  // (large) payload never ships to the route.
  const { count: payloadCount } = await sb
    .from("letterboxd_import_jobs")
    .select("id", { head: true, count: "exact" })
    .eq("id", jobId)
    .not("payload", "is", null);
  if (!payloadCount) {
    return NextResponse.json({ error: "reupload_required" }, { status: 409 });
  }

  // Guarded flip preview_ready -> applying. 0 rows means it's already applying /
  // completed / failed (double-submit, stale tab) → 409 with the live status.
  const { data: flipped } = await sb
    .from("letterboxd_import_jobs")
    .update({ status: "applying" })
    .eq("id", jobId)
    .eq("status", "preview_ready")
    .select("id")
    .maybeSingle();
  if (!flipped) {
    const { data: cur } = await sb
      .from("letterboxd_import_jobs")
      .select("status")
      .eq("id", jobId)
      .maybeSingle();
    return NextResponse.json(
      { error: "not_apply_ready", status: cur?.status ?? null },
      { status: 409 },
    );
  }

  try {
    const { data: applied, error } = await sb.rpc("apply_letterboxd_import", {
      p_job_id: jobId,
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, applied });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The RPC's transaction rolled back on throw, so nothing was written and the
    // status is still 'applying' from the flip above — park the job failed.
    // EDGE (not handled in v1): if this route dies AFTER the flip but BEFORE this
    // catch (e.g. function timeout), the job is stuck 'applying' and needs a
    // manual status reset to retry. Flagged, not auto-recovered here.
    await sb
      .from("letterboxd_import_jobs")
      .update({ status: "failed", error: message })
      .eq("id", jobId)
      .eq("status", "applying");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
