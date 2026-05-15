import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getTopTitlesForUser, type ProfileLink } from "@/lib/queries/profiles";
import EditProfileForm from "@/components/profile/EditProfileForm";
import VerifySocialsCard from "@/components/me/VerifySocialsCard";

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

// Same-origin path guard for the ?return_to= gate flow — must be an
// absolute path ("/...") and not a protocol-relative ("//...") or
// absolute URL, so it can't be turned into an open redirect.
function safeReturnTo(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

// Block 3.2: detect when return_to points at a fan-edit upload page
// so we can render the verification-nudge banner. Strict pattern —
// won't fire on /c/[handle] (profile), only /c/[handle]/upload with
// any handle and any query string.
const UPLOAD_RETURN_TO_RE = /^\/c\/[^/]+\/upload(\?.*)?$/;

export default async function EditProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const { return_to } = await searchParams;
  const returnTo = safeReturnTo(return_to);
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

  // Pre-fetch the user's socials for the verify card. Service role
  // (creator_socials has RLS with no SELECT policies); scoped to the
  // caller's creator so this can't leak other users' data.
  const service = createServiceRoleClient();
  const { data: creator } = await service
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  const { data: socials } = creator
    ? await service
      .from("creator_socials")
      .select(
        "platform, handle, verified_at, is_verified, verification_code, verification_started_at",
      )
      .eq("creator_id", creator.id)
    : { data: [] };

  // Top 12 — read-only on the profile editor; all management lives
  // in the dedicated builder at /me/top-12.
  const topTitles = await getTopTitlesForUser(session.userId);

  // Block 3.2 onboarding nudge: when the user got bounced here from
  // a /c/[handle]/upload attempt AND they have no verified socials
  // yet, surface a banner explaining why they need to verify. The
  // "no verified socials" check is defensive — if they're already
  // verified they wouldn't have been bounced, but a direct visit
  // with the return_to query param shouldn't surface the nudge.
  const hasAnyVerifiedSocial = ((socials ?? []) as Array<{
    verified_at: string | null;
  }>).some((s) => !!s.verified_at);
  const showUploadNudge =
    !!returnTo &&
    UPLOAD_RETURN_TO_RE.test(returnTo) &&
    !hasAnyVerifiedSocial;

  return (
    <>
      {showUploadNudge && (
        <div className="mx-auto mt-8 max-w-2xl px-6">
          <div className="rounded-2xl border border-moonbeem-violet/40 bg-moonbeem-violet/10 p-5">
            <h2 className="m-0 font-wordmark text-heading-sm text-moonbeem-ink">
              Verify a social account to upload
            </h2>
            <p className="mt-2 text-body-sm text-moonbeem-ink-muted leading-relaxed">
              Fan edits attribute to a verified social handle. Verify your
              TikTok, Instagram, or X account below. It takes about 30 seconds.
              Once you&apos;re verified, your upload will pick up where you left
              off.
            </p>
            <a
              href="#verify-socials"
              className="mt-3 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
            >
              Start verifying →
            </a>
          </div>
        </div>
      )}
      <EditProfileForm
        handle={data.handle as string}
        initialDisplayName={(data.display_name ?? "") as string}
        initialBio={(data.bio ?? "") as string}
        initialAvatarUrl={(data.avatar_url ?? null) as string | null}
        initialLinks={normalizeLinks(data.links)}
        topTitles={topTitles.map((t) => ({
          title_id: t.title_id,
          slug: t.title.slug,
          title: t.title.title,
          poster_url: t.title.poster_url,
        }))}
      />
      <div
        id="verify-socials"
        className="mx-auto flex max-w-2xl flex-col gap-8 px-6 pb-12 scroll-mt-8"
      >
        <VerifySocialsCard
          initialSocials={(socials ?? []) as never}
          returnTo={returnTo}
        />
      </div>
    </>
  );
}
