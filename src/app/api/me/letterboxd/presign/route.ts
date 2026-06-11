// Phase 2B — presigned PUT for a Letterboxd export ZIP. Mirrors
// /api/profile/avatar/presign (generatePresignedUploadUrl from @/lib/r2/upload),
// but gated by the import_letterboxd capability + a resolved creator, and keyed
// to the caller's OWN namespace letterboxd-imports/{userId}/{uuid}.zip.
//
// NOTE on the 25 MB cap: generatePresignedUploadUrl signs a PutObjectCommand
// with no content-length-range condition, so the cap cannot bind at presign
// time. It is enforced (a) client-side on file.size before the PUT, and (b)
// server-side in the import route via the R2 object's ContentLength before the
// bytes are read. MAX_BYTES is returned so the client can pre-check.

import { NextResponse, type NextRequest } from "next/server";
import { requireCreatorForImport } from "@/lib/letterboxd/server";
import { generatePresignedUploadUrl } from "@/lib/r2/upload";

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(_request: NextRequest) {
  const gate = await requireCreatorForImport("me/letterboxd/presign");
  if ("error" in gate) return gate.error;
  const { userId } = gate;

  const key = `letterboxd-imports/${userId}/${crypto.randomUUID()}.zip`;
  const { url, contentDisposition } = await generatePresignedUploadUrl(
    key,
    "application/zip",
    "letterboxd-export.zip",
  );

  // The PUT must echo BOTH signed headers (Content-Type + Content-Disposition),
  // exactly as the avatar-presign flow does, or R2 rejects the SigV4 signature.
  return NextResponse.json({
    url,
    key,
    contentType: "application/zip",
    contentDisposition,
    maxBytes: MAX_BYTES,
  });
}
