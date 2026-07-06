// POST /api/me/hosting/titles/[id]/mux-upload — open a DRM-protected Mux
// direct upload for a CREATOR title (the self-serve hosting lane). Returns a
// one-time upload URL the browser PUTs the video file to; the asset lifecycle
// then completes ASYNCHRONOUSLY via /api/webhooks/mux (which inserts the
// creator_episodes row once the asset is ready with a DRM playback id). This
// route NEVER writes creator_episodes.
//
// Mirror of /api/titles/[id]/episodes/mux-upload with the partner gate swapped
// for authorizeCreatorTitleMutation (claimed-creator gate) and the job written
// to creator_mux_ingest_jobs. Same session check, gate + status mapping, DRM
// fail-before-insert posture, and webhook contract.
//
// DRM-first: the new asset is created with a single 'drm' advanced playback
// policy — no public/signed fallback (ruling D3: requires_drm from birth).
// passthrough is load-bearing AND NAMESPACED: `creator:<job.id>` (built by the
// shared buildCreatorPassthrough) — the webhook keys its lane split on it, so
// a creator asset can never resolve into the partner rail or vice versa.

import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/dal";
import { enforce } from "@/lib/ratelimit";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { authorizeCreatorTitleMutation } from "@/lib/auth/creator-title-mutation";
import { buildCreatorPassthrough } from "@/lib/creator-titles/mux-passthrough";
import { getCreatorHostingStatus } from "@/lib/creator-titles/tiers";
import { getMux } from "@/lib/mux";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const rl = await enforce("creatorWrites", user.id, "me/hosting/mux-upload");
  if (!rl.ok) return rl.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "title_not_found" }, { status: 404 });
  }

  // AUTHORIZE FIRST — the claimed-creator gate. Ownership is resolved inside
  // the helper from the session userId + creator-title id; the client supplies
  // no identity claim.
  const authz = await authorizeCreatorTitleMutation(user.id, id);
  if (!authz.ok) {
    const status =
      authz.reason === "not_authenticated"
        ? 401
        : authz.reason === "title_not_found"
          ? 404
          : 403;
    return NextResponse.json({ error: authz.reason }, { status });
  }

  // TIER CEILING GATE (Phase 3, soft — ruling D4). Read the creator's hosting
  // status (tier allotment vs billable = used − grandfathered floor). At the
  // ceiling we refuse to START a new upload with an honest prompt; existing
  // content is untouched (playback never stops). We can only gate on CURRENT
  // usage — the file's duration is unknown until asset.ready, so a single
  // upload can still cross the cap; the NEXT upload is what's refused.
  const hostingStatus = await getCreatorHostingStatus(authz.creatorId);
  if (hostingStatus.atCeiling) {
    return NextResponse.json(
      {
        error: "hosting_quota_exceeded",
        tier: hostingStatus.tier,
        used_minutes: Math.round(hostingStatus.billableMinutes),
        allotment_minutes: hostingStatus.allotmentMinutes,
      },
      { status: 402 },
    );
  }

  // Optional client hints. NOT trusted for identity — only the title (path) +
  // session decide authorization. These two fields just seed the resulting
  // episode's number/label and are validated here.
  let body: { label?: unknown; intended_episode_number?: unknown } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.trim()
      : null;
  let intendedEpisodeNumber: number | null = null;
  if (body.intended_episode_number != null) {
    const n = body.intended_episode_number;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      return NextResponse.json(
        { error: "invalid_episode_number" },
        { status: 400 },
      );
    }
    intendedEpisodeNumber = n;
  }

  // DRM-first config guard: without a DRM configuration id we must NOT open an
  // upload — a missing id would let Mux create a non-DRM asset. Fail BEFORE
  // inserting a job so a deploy-time misconfiguration never leaves a stuck
  // 'creating' row.
  const drmConfigurationId = process.env.MUX_DRM_CONFIGURATION_ID;
  if (!drmConfigurationId) {
    return NextResponse.json(
      { error: "mux_drm_not_configured" },
      { status: 500 },
    );
  }

  // Resolve the Mux client up front. getMux() is SYNCHRONOUS and throws on
  // missing MUX_TOKEN_ID/MUX_TOKEN_SECRET — that throw would NOT be caught by
  // the .catch() on uploads.create() below (it fires while building the call,
  // before any promise exists). Handle it here, BEFORE the job insert, so a
  // creds misconfiguration fails fast and never leaves a stuck 'creating' row.
  let mux: ReturnType<typeof getMux>;
  try {
    mux = getMux();
  } catch (err) {
    console.error(
      `[creator-mux-upload] mux client unavailable: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return NextResponse.json({ error: "mux_not_configured" }, { status: 500 });
  }

  const supabase = createServiceRoleClient();

  // 1. Insert the tracking job FIRST (status='creating'), capturing job.id.
  //    The job exists before we talk to Mux so any Mux failure is recorded
  //    against a real row (errored), never lost.
  const { data: job, error: jobErr } = await supabase
    .from("creator_mux_ingest_jobs")
    .insert({
      creator_title_id: id,
      status: "creating",
      requires_drm: true,
      intended_label: label,
      intended_episode_number: intendedEpisodeNumber,
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    return NextResponse.json(
      { error: jobErr?.message ?? "job_insert_failed" },
      { status: 500 },
    );
  }

  // 2. Create the Mux direct upload. The client was resolved above, so the
  //    only thing that can reject here is the Mux API request itself — isolate
  //    that to the .catch() so a later DB hiccup can't falsely 502 a real
  //    upload.
  const origin = request.headers.get("origin") ?? new URL(request.url).origin;
  const result = await mux.video.uploads
    .create({
      cors_origin: origin,
      new_asset_settings: {
        // DRM-first: single 'drm' policy, no public/signed fallback. Do NOT
        // also pass playback_policy — Mux rejects both together.
        advanced_playback_policies: [
          { policy: "drm", drm_configuration_id: drmConfigurationId },
        ],
        video_quality: "plus",
        // 4K gate (ruling D2): Studio+ may store up to 2160p; Free/Solo cap at
        // 1080p — a 4K source is stored at 1080p max, so 4K never bills on an
        // HD tier. Enforced here at asset creation via max_resolution_tier.
        max_resolution_tier: hostingStatus.allows4k ? "2160p" : "1080p",
        // Load-bearing + NAMESPACED: `creator:<job.id>` ties every webhook for
        // this asset back to THIS creator-lane job — the webhook's lane split.
        passthrough: buildCreatorPassthrough(job.id as string),
      },
    })
    .then((upload) => ({ ok: true as const, upload }))
    .catch((err: unknown) => ({
      ok: false as const,
      message: err instanceof Error ? err.message : "mux_upload_create_failed",
    }));

  if (!result.ok) {
    await supabase
      .from("creator_mux_ingest_jobs")
      .update({ status: "errored", error: result.message })
      .eq("id", job.id);
    console.error(
      `[creator-mux-upload] uploads.create failed for job=${job.id} creator_title=${id}: ${result.message}`,
    );
    return NextResponse.json(
      { error: "mux_upload_create_failed" },
      { status: 502 },
    );
  }

  // 3. Record the upload id + advance to awaiting_upload. The client now PUTs
  //    the file to upload.url; the rest of the lifecycle is webhook-driven. A
  //    failure to stamp the id is non-fatal to ingest — the asset.ready
  //    success path resolves the job by the namespaced passthrough regardless
  //    (only the upload.* events key off mux_upload_id) — so we log loudly and
  //    still return the URL.
  const { error: updErr } = await supabase
    .from("creator_mux_ingest_jobs")
    .update({ status: "awaiting_upload", mux_upload_id: result.upload.id })
    .eq("id", job.id);
  if (updErr) {
    console.error(
      `[creator-mux-upload] failed to stamp upload_id on job=${job.id}: ${updErr.message}`,
    );
  }

  return NextResponse.json({ jobId: job.id, uploadUrl: result.upload.url });
}
