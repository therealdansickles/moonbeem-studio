import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import {
  buildClipKey,
  buildPartnerLogoKey,
  buildStillKey,
  generatePresignedUploadUrl,
} from "@/lib/r2/upload";

const ALLOWED_EXTS: Record<string, true> = {
  mp4: true,
  mov: true,
  webm: true,
  jpg: true,
  jpeg: true,
  png: true,
  webp: true,
  avif: true,
  svg: true,
};

const CLIP_CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

const STILL_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};

const PARTNER_LOGO_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const PARTNER_LOGO_EXTS = new Set(Object.keys(PARTNER_LOGO_CONTENT_TYPES));

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function GET(request: NextRequest) {
  await requireSuperAdmin();

  const { searchParams } = request.nextUrl;
  const type = searchParams.get("type");
  const ext = (searchParams.get("ext") ?? "").toLowerCase();
  const titleSlug = searchParams.get("titleSlug") ?? "";
  const partnerSlug = searchParams.get("partnerSlug") ?? "";
  const indexParam = searchParams.get("index");
  const contentTypeParam = searchParams.get("contentType");
  const filenameParam = searchParams.get("filename") ?? "";

  if (type !== "clip" && type !== "still" && type !== "partner-logo") {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }
  if (!ALLOWED_EXTS[ext]) {
    return NextResponse.json({ error: "invalid ext" }, { status: 400 });
  }

  if (type === "partner-logo") {
    if (!PARTNER_LOGO_EXTS.has(ext)) {
      return NextResponse.json(
        { error: "invalid ext for partner-logo" },
        { status: 400 },
      );
    }
    if (!partnerSlug || !SLUG_RE.test(partnerSlug)) {
      return NextResponse.json(
        { error: "invalid partnerSlug" },
        { status: 400 },
      );
    }
    const key = buildPartnerLogoKey(partnerSlug, ext);
    const contentType =
      contentTypeParam && contentTypeParam.includes("/")
        ? contentTypeParam
        : (PARTNER_LOGO_CONTENT_TYPES[ext] ?? "application/octet-stream");
    const suggestedFilename = filenameParam || `${partnerSlug}-logo.${ext}`;
    const { url, contentDisposition } = await generatePresignedUploadUrl(
      key,
      contentType,
      suggestedFilename,
    );
    return NextResponse.json({ url, key, contentType, contentDisposition });
  }

  // clip / still — title-scoped, indexed.
  if (!titleSlug || !SLUG_RE.test(titleSlug)) {
    return NextResponse.json({ error: "invalid titleSlug" }, { status: 400 });
  }
  const index = Number(indexParam);
  if (!Number.isFinite(index) || index < 0) {
    return NextResponse.json({ error: "invalid index" }, { status: 400 });
  }

  const key =
    type === "clip"
      ? buildClipKey(titleSlug, index, ext)
      : buildStillKey(titleSlug, index, ext);

  const lookup = type === "clip" ? CLIP_CONTENT_TYPES : STILL_CONTENT_TYPES;
  const contentType =
    contentTypeParam && contentTypeParam.includes("/")
      ? contentTypeParam
      : (lookup[ext] ?? "application/octet-stream");

  const suggestedFilename = filenameParam || `${titleSlug}-${index}.${ext}`;

  const { url, contentDisposition } = await generatePresignedUploadUrl(
    key,
    contentType,
    suggestedFilename,
  );
  return NextResponse.json({ url, key, contentType, contentDisposition });
}
