// One Library cell: the reused poster (TitleCard) plus state-specific meta.
// States (Q7): owned + active offer Watch; refunded is subdued and never offers
// Watch; expired is subdued with two copy flavors (never-started vs viewing-window
// ended) and a re-rent via the existing RentButton. Watch links to /t/[slug]#watch;
// the title page + playback-token gate enforce visibility and territory at watch
// time (entitlement alone is not watchable). Server component; TitleCard and
// RentButton are its client children.

import Link from "next/link";
import TitleCard from "@/components/TitleCard";
import RentButton from "@/components/RentButton";
import { formatTimeLeft, type LibraryItem } from "@/lib/entitlements/library";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function LibraryCard({ item }: { item: LibraryItem }) {
  const { title, state } = item;
  const canReRent =
    state === "expired" &&
    title.transact_enabled &&
    (title.transact_price_cents ?? 0) > 0;

  return (
    <div
      className={`flex flex-col gap-2 ${state === "refunded" ? "opacity-60" : ""}`}
    >
      <TitleCard
        title={{
          id: title.id,
          slug: title.slug,
          title: title.title,
          poster_url: title.poster_url,
        }}
      />

      <div className="flex flex-col gap-1 px-0.5">
        {state === "owned" && (
          <>
            <p className="m-0 text-caption text-moonbeem-ink-subtle">
              Purchased {formatDate(item.purchasedAt)}
            </p>
            <p className="m-0 text-body-sm text-moonbeem-ink">
              {dollars(item.pricePaidCents)}
            </p>
          </>
        )}

        {state === "refunded" && (
          <>
            <p className="m-0 text-caption text-moonbeem-ink-subtle">
              Refunded{item.refundedAt ? ` ${formatDate(item.refundedAt)}` : ""}
            </p>
            <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
              {dollars(item.pricePaidCents)}
            </p>
          </>
        )}

        {state === "active" && item.expiresAt && (
          <p className="m-0 text-caption text-moonbeem-ink-subtle">
            Expires {formatDate(item.expiresAt)} ({formatTimeLeft(item.expiresAt)})
          </p>
        )}

        {state === "expired" && (
          <p className="m-0 text-caption text-moonbeem-ink-subtle">
            {item.firstPlayedAt
              ? "Viewing window ended. Your 48 hour window is up."
              : "Rental window lapsed. You did not start watching within 30 days."}
          </p>
        )}

        {(state === "owned" || state === "active") && (
          <Link
            href={`/t/${title.slug}#watch`}
            className="mt-1 inline-block self-start rounded-md bg-moonbeem-pink px-3 py-1.5 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
          >
            Watch
          </Link>
        )}

        {canReRent && (
          <div className="mt-1">
            <RentButton
              titleId={title.id}
              priceCents={title.transact_price_cents as number}
              authState="ready"
              returnTo="/me/library"
            />
          </div>
        )}
      </div>
    </div>
  );
}
