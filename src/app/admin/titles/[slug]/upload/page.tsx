// Deprecated: the upload UI now lives at /admin/titles/[slug]?tab=upload.
// This route persists as a redirect so any bookmarked URLs still work.

import { redirect } from "next/navigation";

type PageProps = { params: Promise<{ slug: string }> };

export default async function DeprecatedUploadRoute({ params }: PageProps) {
  const { slug } = await params;
  redirect(`/admin/titles/${slug}?tab=upload`);
}
