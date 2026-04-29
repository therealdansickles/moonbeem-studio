import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/dal";
import {
  buildClipKey,
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

export async function GET(request: NextRequest) {
  await requireSuperAdmin();

  const { searchParams } = request.nextUrl;
  const type = searchParams.get("type");
  const ext = (searchParams.get("ext") ?? "").toLowerCase();
  const titleSlug = searchParams.get("titleSlug") ?? "";
  const indexParam = searchParams.get("index");
  const contentTypeParam = searchParams.get("contentType");
  const filenameParam = searchParams.get("filename") ?? "";

  if (type !== "clip" && type !== "still") {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }
  if (!ALLOWED_EXTS[ext]) {
    return NextResponse.json({ error: "invalid ext" }, { status: 400 });
  }
  if (!titleSlug || !/^[a-z0-9-]+$/.test(titleSlug)) {
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
