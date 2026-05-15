// Verified-user fan-edit submission surface. Three gates server-side:
//   1. signed in (verifySession redirects to /login if not)
//   2. viewer is the owner of /c/[handle]
//   3. tier === 'verified' (canPerform upload_fan_edit)
//
// If unverified, redirect to /me/edit?return_to=<current url> so the
// existing Block 2.5.1 prefill chain handles the verification round-
// trip. ?title_id={uuid} pre-fills the title attribution.

import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { canPerform } from "@/lib/gating/can-perform";
import UploadClient from "./UploadClient";

export const metadata = {
  title: "Add fan edit — Moonbeem",
};

type Props = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ title_id?: string }>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params, searchParams }: Props) {
  const session = await verifySession();
  const { handle } = await params;
  const sp = await searchParams;

  const sb = createServiceRoleClient();
  const { data: userRow } = await sb
    .from("users")
    .select("handle")
    .eq("id", session.userId)
    .maybeSingle();
  const ownHandle = (userRow?.handle as string | null) ?? null;

  // Owner check: only your own /c/[handle]/upload is reachable.
  if (!ownHandle || ownHandle.toLowerCase() !== handle.toLowerCase()) {
    redirect(`/c/${ownHandle ?? ""}/upload`);
  }

  const tier = await getUserTier(session.userId);
  const gate = canPerform(tier, "upload_fan_edit");
  if (!gate.allowed) {
    const back = sp.title_id
      ? `/c/${ownHandle}/upload?title_id=${encodeURIComponent(sp.title_id)}`
      : `/c/${ownHandle}/upload`;
    redirect(`/me/edit?return_to=${encodeURIComponent(back)}`);
  }

  // Pre-fill title from ?title_id={uuid} when valid.
  let prefillTitleId: string | null = null;
  let prefillTitleLabel: string | null = null;
  if (sp.title_id && UUID_RE.test(sp.title_id)) {
    const { data: title } = await sb
      .from("titles")
      .select("id, title, year")
      .eq("id", sp.title_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (title) {
      prefillTitleId = title.id as string;
      prefillTitleLabel = title.year
        ? `${title.title} (${title.year})`
        : (title.title as string);
    }
  }

  return (
    <UploadClient
      handle={ownHandle}
      prefillTitleId={prefillTitleId}
      prefillTitleLabel={prefillTitleLabel}
    />
  );
}
