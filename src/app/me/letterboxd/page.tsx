// /me/letterboxd — Letterboxd ZIP import (upload + preview). Server component
// gates on auth + claimed handle (same as /me/top-12), then hands off to the
// "use client" LetterboxdImport surface. The apply step is Phase 2C; this page
// renders a disabled, next-step Apply button.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import LetterboxdImport from "./LetterboxdImport";

export const metadata: Metadata = {
  title: "Import from Letterboxd · Moonbeem",
  robots: { index: false, follow: false },
};

export default async function LetterboxdImportPage() {
  const session = await verifySession();
  const service = createServiceRoleClient();

  const { data: userRow } = await service
    .from("users")
    .select("handle")
    .eq("id", session.userId)
    .maybeSingle();
  if (!userRow?.handle) redirect("/onboarding/handle");

  return <LetterboxdImport />;
}
