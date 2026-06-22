// POST /api/webhooks/mux — Mux asset-lifecycle webhook. Mirrors the Stripe
// webhook route's shape (raw body -> SDK signature verify -> service-role writes
// -> 2xx ack / 5xx retry), adapted for Mux.
//
// Flow it completes: the create-upload route opens a DRM direct upload and tracks
// it in mux_ingest_jobs (passthrough=job.id). Mux then drives the job to ready:
//   video.upload.asset_created -> link upload->asset, status=encoding
//   video.asset.ready          -> on a DRM playback id, atomically flip the job to
//                                 ready AND insert the title_episodes row (exactly
//                                 once) via the mux_finalize_asset_ready RPC
//   video.asset.errored        -> mark the job errored
//   video.upload.errored       -> mark the job errored
//
// DRM-first + fail-closed: a ready asset without a 'drm'-policy playback id is an
// error, never an episode. We never store a public/signed id and never downgrade.
//
// Idempotency is dual-layer: the partial unique index on mux_ingest_jobs
// .mux_asset_id is the storage floor (duplicate asset_created -> 23505 -> ack);
// the atomic finalize RPC (status flip + episode insert in one transaction,
// gated on status<>'ready') guarantees exactly one episode per asset.ready even
// under at-least-once redelivery or a mid-request crash.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getMux } from "@/lib/mux";

// SDK signature verification (HMAC) runs on Node crypto — pin the Node runtime.
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The verified-event union, derived from the installed SDK so `switch (event.type)`
// narrows each case without importing the (deep) union type by name.
type MuxWebhookEvent = Awaited<
  ReturnType<ReturnType<typeof getMux>["webhooks"]["unwrap"]>
>;

type IngestJob = {
  id: string;
  title_id: string;
  intended_episode_number: number | null;
  intended_label: string | null;
  status: string;
};

// Resolve the tracking job for an asset event: passthrough (the job.id we set at
// upload time) is primary; the asset id is the fallback. passthrough is only
// trusted as a lookup key when it is shaped like our uuid (a foreign string must
// not blow up the uuid-typed id query).
async function resolveJobForAsset(
  supabase: ReturnType<typeof createServiceRoleClient>,
  passthrough: string | null,
  assetId: string,
): Promise<IngestJob | null> {
  const cols = "id, title_id, intended_episode_number, intended_label, status";
  if (passthrough && UUID_RE.test(passthrough)) {
    const { data } = await supabase
      .from("mux_ingest_jobs")
      .select(cols)
      .eq("id", passthrough)
      .maybeSingle();
    if (data) return data as IngestJob;
  }
  const { data } = await supabase
    .from("mux_ingest_jobs")
    .select(cols)
    .eq("mux_asset_id", assetId)
    .maybeSingle();
  return (data as IngestJob | null) ?? null;
}

export async function POST(request: NextRequest) {
  const signature = request.headers.get("mux-signature");
  const secret = process.env.MUX_WEBHOOK_SECRET;
  // Single secret (Mux posts every event to this one URL) — no dual-secret loop.
  if (!signature || !secret) {
    return NextResponse.json(
      { error: "missing_signature_or_secret" },
      { status: 400 },
    );
  }

  // Mux needs the RAW body for signature verification — read it as text, no
  // JSON pre-parse. Do NOT process an unverified payload.
  const body = await request.text();

  let event: MuxWebhookEvent;
  try {
    event = await getMux().webhooks.unwrap(body, request.headers, secret);
  } catch (err) {
    console.error(
      `[mux-webhook] signature verification failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return NextResponse.json({ error: "bad_signature" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  switch (event.type) {
    case "video.upload.asset_created": {
      const uploadId = event.data.id; // the direct-upload id
      const assetId = event.data.asset_id ?? null;
      if (!assetId) {
        console.warn(
          `[mux-webhook] upload.asset_created missing asset_id upload=${uploadId}`,
        );
        return NextResponse.json({ received: true });
      }
      // First writer of mux_asset_id. Idempotent: only the row still awaiting an
      // asset (mux_asset_id IS NULL) transitions, so a redelivery matches 0 rows
      // and no-ops. The partial unique backstops a duplicate asset claim landing
      // on another job (23505) -> ack as a retry.
      const { error } = await supabase
        .from("mux_ingest_jobs")
        .update({ mux_asset_id: assetId, status: "encoding" })
        .eq("mux_upload_id", uploadId)
        .is("mux_asset_id", null);
      if (error) {
        if (error.code === "23505") {
          console.warn(
            `[mux-webhook] upload.asset_created duplicate asset claim (23505) upload=${uploadId} asset=${assetId}`,
          );
          return NextResponse.json({ received: true });
        }
        console.error(
          `[mux-webhook] upload.asset_created update failed upload=${uploadId}: ${error.message}`,
        );
        return NextResponse.json({ error: "db_error" }, { status: 500 });
      }
      return NextResponse.json({ received: true });
    }

    case "video.asset.ready": {
      const assetId = event.data.id; // the asset id
      const passthrough = event.data.passthrough ?? null;

      const job = await resolveJobForAsset(supabase, passthrough, assetId);
      if (!job) {
        console.warn(
          `[mux-webhook] asset.ready no matching job asset=${assetId} passthrough=${passthrough ?? "none"}`,
        );
        return NextResponse.json({ received: true });
      }

      // DRM-first, fail-closed: only a 'drm'-policy playback id is acceptable.
      const drmPlaybackId =
        event.data.playback_ids?.find((p) => p.policy === "drm")?.id ?? null;
      if (!drmPlaybackId) {
        // Never store a non-DRM id; never downgrade a job that's already ready.
        await supabase
          .from("mux_ingest_jobs")
          .update({ status: "errored", error: "no drm playback id" })
          .eq("id", job.id)
          .neq("status", "ready");
        console.error(
          `[mux-webhook] asset.ready has NO drm playback id job=${job.id} asset=${assetId}`,
        );
        return NextResponse.json({ received: true });
      }

      // ATOMIC finalize: flip the job to ready AND insert the episode in one
      // transaction (mux_finalize_asset_ready). Exactly-once under at-least-once
      // delivery — a redelivery that finds the job already ready is a no-op.
      const { data: outcome, error: rpcErr } = await supabase.rpc(
        "mux_finalize_asset_ready",
        {
          p_job_id: job.id,
          p_asset_id: assetId,
          p_drm_playback_id: drmPlaybackId,
        },
      );
      if (rpcErr) {
        // The only unique the finalize INSERT can trip is title_episodes
        // (title_id, episode_number). A FIXED intended number that's taken will
        // never self-resolve -> mark errored, ack. An auto-number race resolves
        // on retry (MAX+1 recomputes) -> 500 so Mux redelivers.
        if (rpcErr.code === "23505") {
          if (job.intended_episode_number != null) {
            await supabase
              .from("mux_ingest_jobs")
              .update({
                status: "errored",
                error: `episode_number ${job.intended_episode_number} already exists`,
              })
              .eq("id", job.id)
              .neq("status", "ready");
            console.error(
              `[mux-webhook] asset.ready fixed episode_number ${job.intended_episode_number} conflict job=${job.id}; marked errored`,
            );
            return NextResponse.json({ received: true });
          }
          console.warn(
            `[mux-webhook] asset.ready auto-number race job=${job.id}; will retry`,
          );
          return NextResponse.json(
            { error: "episode_number_race" },
            { status: 500 },
          );
        }
        console.error(
          `[mux-webhook] asset.ready finalize RPC failed job=${job.id}: ${rpcErr.message}`,
        );
        return NextResponse.json({ error: "finalize_failed" }, { status: 500 });
      }

      if (outcome === "inserted") {
        // Reveal the new episode on the public Watch tab.
        const { data: title } = await supabase
          .from("titles")
          .select("slug")
          .eq("id", job.title_id)
          .maybeSingle();
        if (title?.slug) revalidatePath(`/t/${title.slug as string}`);
        console.log(
          `[mux-webhook] asset.ready finalized (inserted episode) job=${job.id} asset=${assetId}`,
        );
      } else {
        // 'already_ready' (duplicate delivery) or 'job_not_found' (job vanished
        // between resolve and the RPC, e.g. title deleted). Both are clean acks.
        console.log(
          `[mux-webhook] asset.ready finalize outcome=${outcome ?? "null"} job=${job.id}`,
        );
      }
      return NextResponse.json({ received: true });
    }

    case "video.asset.errored": {
      const assetId = event.data.id;
      const passthrough = event.data.passthrough ?? null;
      const reason =
        event.data.errors?.messages?.join("; ") ||
        event.data.errors?.type ||
        "asset errored";
      const job = await resolveJobForAsset(supabase, passthrough, assetId);
      if (!job) {
        console.warn(
          `[mux-webhook] asset.errored no matching job asset=${assetId}`,
        );
        return NextResponse.json({ received: true });
      }
      await supabase
        .from("mux_ingest_jobs")
        .update({ status: "errored", error: reason })
        .eq("id", job.id)
        .neq("status", "ready"); // never downgrade a delivered episode's job
      console.error(
        `[mux-webhook] asset.errored job=${job.id} asset=${assetId}: ${reason}`,
      );
      return NextResponse.json({ received: true });
    }

    case "video.upload.errored": {
      const uploadId = event.data.id;
      await supabase
        .from("mux_ingest_jobs")
        .update({ status: "errored", error: "upload errored" })
        .eq("mux_upload_id", uploadId)
        .neq("status", "ready");
      console.error(`[mux-webhook] upload.errored upload=${uploadId}`);
      return NextResponse.json({ received: true });
    }

    default:
      console.log(`[mux-webhook] unhandled event type: ${event.type}`);
  }

  return NextResponse.json({ received: true });
}
