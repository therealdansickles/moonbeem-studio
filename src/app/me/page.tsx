import Link from "next/link";
import { verifySession } from "@/lib/dal";
import { SignOutButton } from "@/components/SignOutButton";
import VerifySocialsCard from "@/components/me/VerifySocialsCard";
import { createServiceRoleClient } from "@/lib/supabase/service";

export default async function MePage() {
  const session = await verifySession();

  // Pre-fetch the user's creator + socials so the verification card
  // can render without a client-side roundtrip on first paint.
  const supabase = createServiceRoleClient();
  const { data: creator } = await supabase
    .from("creators")
    .select("id, moonbeem_handle")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();

  const { data: socials } = creator
    ? await supabase
      .from("creator_socials")
      .select(
        "platform, handle, verified_at, is_verified, verification_code, verification_started_at",
      )
      .eq("creator_id", creator.id)
    : { data: [] };

  return (
    <div className="min-h-screen flex flex-col items-center gap-10 px-6 py-16 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <h1 className="font-wordmark font-bold text-display-md text-moonbeem-pink m-0">
        moonbeem.
      </h1>
      <p className="text-body-lg text-moonbeem-ink-muted text-center">
        Signed in as{" "}
        <span className="text-moonbeem-ink">{session.email}</span>
      </p>

      {creator
        ? (
          <VerifySocialsCard
            initialSocials={(socials ?? []) as never}
          />
        )
        : (
          <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-moonbeem-black/60 p-6 text-center">
            <p className="text-body text-moonbeem-ink">
              Claim a Moonbeem handle first to verify your socials.
            </p>
            <Link
              href="/onboarding/handle"
              className="mt-4 inline-block rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90"
            >
              Claim your handle
            </Link>
          </div>
        )}

      <SignOutButton />
    </div>
  );
}
