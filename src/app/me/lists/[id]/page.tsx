// /me/lists/[id] — list builder (search-add + remove). Mirrors /me/top-12's
// server gate; a missing / not-the-caller's list is a 404.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getMyListDetail } from "@/lib/queries/lists";
import ListBuilder from "@/components/lists/ListBuilder";

export const metadata: Metadata = {
  title: "Edit list · Moonbeem",
  robots: { index: false, follow: false },
};

export default async function MeListDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await verifySession();
  const service = createServiceRoleClient();

  const { data: userRow } = await service
    .from("users")
    .select("handle")
    .eq("id", session.userId)
    .maybeSingle();
  if (!userRow?.handle) redirect("/onboarding/handle");

  const { data: creator } = await service
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!creator) notFound();

  const list = await getMyListDetail(creator.id as string, id);
  if (!list) notFound();
  const isWatchlist = list.kind === "watchlist";

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="m-0 font-wordmark text-heading-lg text-moonbeem-ink">
            {list.name}
            {isWatchlist && (
              <span className="ml-2 text-body-sm text-moonbeem-ink-subtle">
                watchlist
              </span>
            )}
          </h1>
          <Link
            href="/me/lists"
            className="text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
          >
            ← Lists
          </Link>
        </div>
        <ListBuilder listId={list.id} initialItems={list.items} />
      </div>
    </div>
  );
}
