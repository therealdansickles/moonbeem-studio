// /me/library — the signed-in buyer's Library: films they have bought and rented.
// Private, verifySession-gated (the settings template, auth-only — NOT diary's
// creator/claimed-handle gate: this is keyed on the buyer's user_id, so a buyer who
// never claimed a profile must still see their own purchases). Reads all of the
// user's entitlements through the service-role client (RLS-no-policies) and
// classifies them into the two sections; the window rule + precedence live in
// lib/entitlements so the Library can never disagree with the playback gate.

import Link from "next/link";
import { verifySession } from "@/lib/dal";
import { getMyEntitlements } from "@/lib/entitlements/lookup";
import { classifyLibrary } from "@/lib/entitlements/library";
import PurchasesSection from "@/components/me/library/PurchasesSection";
import RentalsSection from "@/components/me/library/RentalsSection";

export default async function LibraryPage() {
  // Gates the page: redirects to /login if there is no session.
  const session = await verifySession();
  const entitlements = await getMyEntitlements(session.userId);
  const lib = classifyLibrary(entitlements);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-10">
      <header className="flex flex-col gap-3">
        <Link
          href="/me"
          className="self-start rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink hover:border-moonbeem-pink hover:text-moonbeem-pink"
        >
          ← Dashboard
        </Link>
        <h1 className="m-0 font-wordmark text-heading-lg text-moonbeem-ink">
          Library
        </h1>
        <p className="m-0 text-body-sm text-moonbeem-ink-muted">
          Films you have bought and rented.
        </p>
      </header>

      <PurchasesSection purchases={lib.purchases} />
      <RentalsSection
        active={lib.rentalsActive}
        inactiveRecent={lib.rentalsInactiveRecent}
        inactiveOlder={lib.rentalsInactiveOlder}
      />
    </div>
  );
}
