// /me/settings — the signed-in creator's account/settings hub. This is a
// SECURITY-credential surface (it hosts API-token management), so it is
// verifySession-gated: verifySession() redirects to /login when there is no
// session. (Deliberately NOT modeled on the auth-optional /me/privacy-settings.)
//
// Minimal + extensible: a header + a vertical stack of section cards. Today the
// only section is ApiTokensCard; more account/settings sections can be added to
// the stack later without restructuring.

import Link from "next/link";
import { verifySession } from "@/lib/dal";
import ApiTokensCard from "@/components/me/ApiTokensCard";

export default async function SettingsPage() {
  // Gates the page: redirects to /login if there is no session.
  await verifySession();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-3">
        <Link
          href="/me"
          className="self-start rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink hover:border-moonbeem-pink hover:text-moonbeem-pink"
        >
          ← Dashboard
        </Link>
        <h1 className="font-wordmark text-heading-lg text-moonbeem-ink m-0">
          Settings
        </h1>
      </header>

      <ApiTokensCard />
    </div>
  );
}
