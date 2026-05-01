import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/dal";
import {
  buildPublicUrl,
  generatePresignedUploadUrl,
} from "@/lib/r2/upload";

const ALLOWED: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function safeExt(ext: string): string {
  return ext.replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function GET(request: NextRequest) {
  const session = await verifySession();

  const ext = safeExt(request.nextUrl.searchParams.get("ext") ?? "jpg");
  const contentType = ALLOWED[ext];
  if (!contentType) {
    return NextResponse.json(
      { error: "ext must be jpg, jpeg, png, or webp" },
      { status: 400 },
    );
  }

  const key = `avatars/${session.userId}/${Date.now()}.${ext}`;
  const filename = `avatar.${ext}`;

  const { url, contentDisposition } = await generatePresignedUploadUrl(
    key,
    contentType,
    filename,
  );
  return NextResponse.json({
    url,
    key,
    contentType,
    contentDisposition,
    public_url: buildPublicUrl(key),
  });
}
