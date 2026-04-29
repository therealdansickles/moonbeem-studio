import { S3Client } from "@aws-sdk/client-s3";

let cached: S3Client | null = null;

export function getR2Client(): S3Client {
  if (cached) return cached;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 not configured: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY required",
    );
  }
  cached = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cached;
}

export function getR2Bucket(): string {
  const v = process.env.R2_BUCKET_NAME;
  if (!v) throw new Error("R2_BUCKET_NAME not set");
  return v;
}

export function getR2PublicUrl(): string {
  const v = process.env.R2_PUBLIC_URL;
  if (!v) throw new Error("R2_PUBLIC_URL not set");
  return v;
}
