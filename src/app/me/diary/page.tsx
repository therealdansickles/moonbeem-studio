// /me/diary — diary management. Mirrors /me/top-12: server component gating on
// auth + claimed handle, then renders the caller's diary newest-first with a
// per-row delete. Read-only public view lives on /c/[handle].

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getMyDiaryEntries } from "@/lib/queries/diary";
import DiaryManageRow from "@/components/diary/DiaryManageRow";

export const metadata: Metadata = {
  title: "Your diary · Moonbeem",
  robots: { index: false, follow: false },
};

export default async function MeDiaryPage() {
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
  const entries = creator
    ? await getMyDiaryEntries(creator.id as string)
    : [];

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="m-0 font-wordmark text-heading-lg text-moonbeem-ink">
            Your diary
          </h1>
          <Link
            href="/me"
            className="text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
          >
            ← Back
          </Link>
        </div>

        {entries.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center">
            <p className="m-0 text-body-sm text-moonbeem-ink-muted">
              No diary entries yet.
            </p>
            <Link
              href="/"
              className="mt-3 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
            >
              Log your first watch →
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {entries.map((e) => (
              <DiaryManageRow key={e.id} entry={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
