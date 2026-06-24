// GET /api/titles/[id]/episodes/mux-jobs/[jobId]
//
// Poll a Mux ingest job's status for the uploader UI. "Upload 100%" != "ready"
// != "published": after the browser PUTs the file, the asset encodes for minutes
// (a feature is long), so the UI polls this until status='ready' (or 'errored').
//
// SECURITY: authorize on the PATH title (authorizeTitleMutation), then REBIND the
// job to that title (job.title_id === path id, from the ROW) so a partner can't
// read another partner's job by guessing a jobId. Returns ONLY { status, error,
// episodeId } — never a Mux asset/playback id or other internals.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeTitleMutation } from "@/lib/auth/title-mutation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  const { id, jobId } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ error: "job_not_found" }, { status: 404 });
  }

  // AUTHORIZE on the path title (ownership check; reused for this read).
  const authz = await authorizeTitleMutation(user.id, id);
  if (!authz.ok) {
    const status =
      authz.reason === "not_authenticated"
        ? 401
        : authz.reason === "title_not_found"
          ? 404
          : 403;
    return NextResponse.json({ error: authz.reason }, { status });
  }

  const supabase = createServiceRoleClient();

  // JOB -> TITLE REBIND: the job's title_id comes from the row and MUST equal the
  // path title we authorized on (treat a foreign job as not-found).
  const { data: job } = await supabase
    .from("mux_ingest_jobs")
    .select("id, title_id, status, error, mux_asset_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || job.title_id !== id) {
    return NextResponse.json({ error: "job_not_found" }, { status: 404 });
  }

  // Resolve the finalized episode once ready. mux_finalize_asset_ready inserts
  // the episode with mux_asset_id = the job's, so we map job -> episode by it.
  let episodeId: string | null = null;
  if (job.status === "ready" && job.mux_asset_id) {
    const { data: ep } = await supabase
      .from("title_episodes")
      .select("id")
      .eq("title_id", id)
      .eq("mux_asset_id", job.mux_asset_id as string)
      .maybeSingle();
    episodeId = (ep?.id as string | undefined) ?? null;
  }

  return NextResponse.json({
    status: job.status,
    error: job.error,
    episodeId,
  });
}
