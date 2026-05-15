export function getOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.VERCEL_URL ??
    "https://moonbeem.studio"
  ).replace(/\/$/, "");
}
