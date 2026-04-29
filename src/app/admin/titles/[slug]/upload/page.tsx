import { notFound } from "next/navigation";
import { requireSuperAdmin } from "@/lib/dal";
import { getTitleBySlug } from "@/lib/queries/titles";
import UploadClient from "./UploadClient";

type PageProps = { params: Promise<{ slug: string }> };

export default async function UploadPage({ params }: PageProps) {
  await requireSuperAdmin();
  const { slug } = await params;
  const title = await getTitleBySlug(slug);
  if (!title) notFound();
  return (
    <UploadClient
      titleId={title.id}
      titleName={title.title}
      titleSlug={title.slug}
    />
  );
}
