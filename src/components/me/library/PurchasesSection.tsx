// Purchases section of the Library. One card per owned/refunded title. Empty state
// is a single line plus a Browse films link (no placeholder art) — it renders
// immediately, since live data today is rentals-only.

import Link from "next/link";
import LibraryCard from "./LibraryCard";
import type { LibraryItem } from "@/lib/entitlements/library";

export default function PurchasesSection({
  purchases,
}: {
  purchases: LibraryItem[];
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="m-0 text-heading-sm text-moonbeem-ink">Purchases</h2>
      {purchases.length === 0 ? (
        <p className="m-0 text-body-sm text-moonbeem-ink-muted">
          You have not bought any films yet.{" "}
          <Link href="/browse" className="text-moonbeem-pink hover:underline">
            Browse films
          </Link>
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {purchases.map((item) => (
            <LibraryCard key={item.entitlementId} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
