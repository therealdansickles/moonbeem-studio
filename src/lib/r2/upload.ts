import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2Bucket, getR2Client, getR2PublicUrl } from "./client";

const PRESIGN_TTL_SECONDS = 60 * 5;

export function buildContentDisposition(filename: string): string {
  const safeAscii = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/[\r\n]/g, "")
    .trim();
  const ascii = safeAscii || "download";
  const utf8 = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function generatePresignedUploadUrl(
  key: string,
  contentType: string,
  suggestedFilename: string,
): Promise<{ url: string; contentDisposition: string }> {
  const contentDisposition = buildContentDisposition(suggestedFilename);
  const cmd = new PutObjectCommand({
    Bucket: getR2Bucket(),
    Key: key,
    ContentType: contentType,
    ContentDisposition: contentDisposition,
  });
  const url = await getSignedUrl(getR2Client(), cmd, {
    expiresIn: PRESIGN_TTL_SECONDS,
  });
  return { url, contentDisposition };
}

export function buildPublicUrl(key: string): string {
  const base = getR2PublicUrl().replace(/\/$/, "");
  return `${base}/${key}`;
}

function safeExt(ext: string): string {
  return ext.replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildClipKey(
  titleSlug: string,
  index: number,
  ext: string,
): string {
  return `clips/${titleSlug}/${index}.${safeExt(ext)}`;
}

export function buildStillKey(
  titleSlug: string,
  index: number,
  ext: string,
): string {
  return `stills/${titleSlug}/${index}.${safeExt(ext)}`;
}
