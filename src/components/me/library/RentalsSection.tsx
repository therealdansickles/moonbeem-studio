// Rentals section of the Library. Active rentals (with a countdown) and
// recently-inactive rentals (expired or refunded) render in the grid; inactive
// rentals older than the 90-day threshold collapse under a native show-more
// (no client JS needed). Empty state is one line plus a Browse films link.

import Link from "next/link";
import LibraryCard from "./LibraryCard";
import type { LibraryItem } from "@/lib/entitlements/library";

export default function RentalsSection({
  active,
  inactiveRecent,
  inactiveOlder,
}: {
  active: LibraryItem[];
  inactiveRecent: LibraryItem[];
  inactiveOlder: LibraryItem[];
}) {
  const hasAny =
    active.length + inactiveRecent.length + inactiveOlder.length > 0;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="m-0 text-heading-sm text-moonbeem-ink">Rentals</h2>
      {!hasAny ? (
        <p className="m-0 text-body-sm text-moonbeem-ink-muted">
          You have not rented any films yet.{" "}
          <Link href="/browse" className="text-moonbeem-pink hover:underline">
            Browse films
          </Link>
        </p>
      ) : (
        <>
          {(active.length > 0 || inactiveRecent.length > 0) && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {active.map((item) => (
                <LibraryCard key={item.entitlementId} item={item} />
              ))}
              {inactiveRecent.map((item) => (
                <LibraryCard key={item.entitlementId} item={item} />
              ))}
            </div>
          )}
          {inactiveOlder.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink">
                Show older rentals ({inactiveOlder.length})
              </summary>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {inactiveOlder.map((item) => (
                  <LibraryCard key={item.entitlementId} item={item} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
