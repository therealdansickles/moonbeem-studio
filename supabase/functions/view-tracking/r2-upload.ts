// R2 thumbnail rehosting helper.
//
// Why: platform CDN thumbnail URLs (Instagram fiev14 in particular,
// also TikTok and Twitter to a lesser degree) are signed/expiring or
// at the mercy of platform changes. Hosting them ourselves on R2
// gives us a stable URL that the title page can link to indefinitely.
//
// The Edge Function runs on Deno; we can't use the Node @aws-sdk
// client. aws4fetch is a tiny (~3KB) Deno-friendly AWS SigV4 signer
// that works against any S3-compatible API, including R2.
//
// Failure semantics: throws on fetch/upload error so the caller can
// log + degrade gracefully (write the source URL, skip thumbnail_url).
// We do NOT silently swallow — the caller decides recovery policy.

// @ts-ignore — Deno resolves npm: specifiers; TS-on-the-Edge does not.
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.18";

const FETCH_TIMEOUT_MS = 5000;

let cachedClient: AwsClient | null = null;

function getClient(): AwsClient {
  if (cachedClient) return cachedClient;
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "[r2-upload] missing R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY",
    );
  }
  cachedClient = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });
  return cachedClient;
}

// Fetches a remote image and uploads it to R2 at fan_edits/{id}/thumb.jpg.
// Returns the public URL on R2.
export async function rehostThumbnail(
  fanEditId: string,
  sourceUrl: string,
): Promise<string> {
  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const bucket = Deno.env.get("R2_BUCKET_NAME");
  const publicBase = Deno.env.get("R2_PUBLIC_URL");
  if (!accountId || !bucket || !publicBase) {
    throw new Error(
      "[r2-upload] missing R2_ACCOUNT_ID, R2_BUCKET_NAME, or R2_PUBLIC_URL",
    );
  }

  // 1. Fetch the source image (with a short timeout to keep us under
  //    the per-fan-edit budget in the wider view-tracking loop).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(sourceUrl, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(
      `[r2-upload] source fetch ${res.status} for ${sourceUrl}`,
    );
  }
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const bodyBytes = new Uint8Array(await res.arrayBuffer());

  // 2. PUT the bytes to R2 via S3-compatible API.
  const key = `fan_edits/${fanEditId}/thumb.jpg`;
  const r2Url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
  const client = getClient();
  const putRes = await client.fetch(r2Url, {
    method: "PUT",
    body: bodyBytes,
    headers: { "Content-Type": contentType },
  });
  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => "");
    throw new Error(
      `[r2-upload] PUT ${putRes.status} for ${key}: ${errText.slice(0, 200)}`,
    );
  }

  // 3. Return the public URL. R2_PUBLIC_URL is the public bucket
  //    domain (custom or *.r2.dev) — we just append the key.
  const trimmed = publicBase.replace(/\/$/, "");
  return `${trimmed}/${key}`;
}
