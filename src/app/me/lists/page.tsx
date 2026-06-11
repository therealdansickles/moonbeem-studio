// /me/lists — list management index. Mirrors /me/top-12's server gate
// (auth + claimed handle), then renders the interactive ListsManager.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getMyListsForCreator } from "@/lib/queries/lists";
import ListsManager from "@/components/lists/ListsManager";

export const metadata: Metadata = {
  title: "Your lists · Moonbeem",
  robots: { index: false, follow: false },
};

export default async function MeListsPage() {
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
  const lists = creator ? await getMyListsForCreator(creator.id as string) : [];

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="m-0 font-wordmark text-heading-lg text-moonbeem-ink">
            Your lists
          </h1>
          <Link
            href="/me"
            className="text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
          >
            ← Back
          </Link>
        </div>
        <ListsManager lists={lists} />
      </div>
    </div>
  );
}
