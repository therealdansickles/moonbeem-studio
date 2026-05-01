import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { type ProfileLink } from "@/lib/queries/profiles";
import EditProfileForm from "@/components/profile/EditProfileForm";

type RawLink = { label?: unknown; url?: unknown };

function normalizeLinks(raw: unknown): ProfileLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): ProfileLink | null => {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as RawLink;
      const label = typeof e.label === "string" ? e.label : "";
      const url = typeof e.url === "string" ? e.url : "";
      if (!label && !url) return null;
      return { label, url };
    })
    .filter((v): v is ProfileLink => v !== null)
    .slice(0, 5);
}

export default async function EditProfilePage() {
  const session = await verifySession();
  const supabase = await createClient();
  const { data } = await supabase
    .from("users")
    .select("handle, display_name, bio, avatar_url, links")
    .eq("id", session.userId)
    .maybeSingle();

  if (!data?.handle) {
    redirect("/onboarding/handle");
  }

  return (
    <EditProfileForm
      handle={data.handle as string}
      initialDisplayName={(data.display_name ?? "") as string}
      initialBio={(data.bio ?? "") as string}
      initialAvatarUrl={(data.avatar_url ?? null) as string | null}
      initialLinks={normalizeLinks(data.links)}
    />
  );
}
