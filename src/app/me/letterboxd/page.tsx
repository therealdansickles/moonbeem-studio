// /me/letterboxd — Letterboxd ZIP import (upload → preview → apply → publish).
// Server component gates on auth + claimed handle (same as /me/top-12), then
// hands off to the "use client" LetterboxdImport surface. It also resolves the
// post-publish "revisit" state server-side: a creator with ≥1 completed import
// job and zero remaining private letterboxd rows has already published, so the
// surface opens directly on the published view.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { resolveCreatorId } from "@/lib/letterboxd/server";
import LetterboxdImport from "./LetterboxdImport";

export const metadata: Metadata = {
  title: "Import from Letterboxd · Moonbeem",
  robots: { index: false, follow: false },
};

type AppliedCategory = { attempted: number; inserted: number; skipped: number };
type ResumeCounts = {
  ratings: AppliedCategory;
  diary: AppliedCategory;
  lists: AppliedCategory;
  list_items: AppliedCategory;
};

// Resolve the surface's initial state from the DB for a returning visitor. A
// creator with >=1 completed import job is either:
//   - DONE   — no private letterboxd rows remain (publish flipped them public and
//              deleted the watchlist container) -> open on the published view.
//   - MID    — private rows still staged -> open on the applied view with Publish
//              enabled, seeded with the per-category counts of what's staged, so
//              the flow can be finished without re-uploading.
// A creator with no completed job opens on idle (the upload step).
async function resolveImportState(
  service: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  creatorId: string,
): Promise<{ alreadyPublished: boolean; resumeCounts: ResumeCounts | null }> {
  const { count: completed } = await service
    .from("letterboxd_import_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "completed");
  if (!completed) return { alreadyPublished: false, resumeCounts: null };

  const privateCount = async (table: string): Promise<number> => {
    const { count } = await service
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("creator_id", creatorId)
      .eq("source", "letterboxd")
      .eq("visibility", "private");
    return count ?? 0;
  };
  const ratings = await privateCount("title_ratings");
  const diary = await privateCount("diary_entries");

  // Private letterboxd list containers (includes the lb://watchlist sentinel);
  // their items are the "List films" staged to publish. Counting by list_id (not
  // source) is exact: post-publish the merged items keep source='letterboxd' but
  // live on the public native watchlist, which this must not count.
  const { data: privLists } = await service
    .from("user_lists")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("source", "letterboxd")
    .eq("visibility", "private");
  const lists = privLists?.length ?? 0;
  let listItems = 0;
  if (lists > 0) {
    const { count } = await service
      .from("user_list_items")
      .select("id", { count: "exact", head: true })
      .in("list_id", (privLists ?? []).map((r) => r.id as string));
    listItems = count ?? 0;
  }

  // Published once nothing remains staged private across the three flip targets.
  if (ratings === 0 && diary === 0 && lists === 0) {
    return { alreadyPublished: true, resumeCounts: null };
  }
  // Resume: these counts ARE what will publish (inserted), nothing is being
  // re-imported (skipped 0).
  const cat = (n: number): AppliedCategory => ({
    attempted: n,
    inserted: n,
    skipped: 0,
  });
  return {
    alreadyPublished: false,
    resumeCounts: {
      ratings: cat(ratings),
      diary: cat(diary),
      lists: cat(lists),
      list_items: cat(listItems),
    },
  };
}

export default async function LetterboxdImportPage() {
  const session = await verifySession();
  const service = createServiceRoleClient();

  const { data: userRow } = await service
    .from("users")
    .select("handle")
    .eq("id", session.userId)
    .maybeSingle();
  if (!userRow?.handle) redirect("/onboarding/handle");
  const handle = userRow.handle as string;

  const creatorId = await resolveCreatorId(session.userId);
  const { alreadyPublished, resumeCounts } = creatorId
    ? await resolveImportState(service, session.userId, creatorId)
    : { alreadyPublished: false, resumeCounts: null };

  return (
    <LetterboxdImport
      handle={handle}
      alreadyPublished={alreadyPublished}
      resumeCounts={resumeCounts}
    />
  );
}
