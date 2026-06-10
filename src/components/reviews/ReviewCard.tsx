"use client";

// Phase 1B — a single public review on the title page Reviews tab. Byline
// (avatar / name / @handle → /c/[handle]) + optional star rating + watched_on
// + body. Spoiler reviews collapse behind a reveal toggle. The owner sees a
// delete control (ConfirmModal → DELETE → router.refresh()).

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StarRatingDisplay } from "@/components/StarRating";
import ConfirmModal from "@/components/ui/ConfirmModal";
import type { PublicReview } from "@/lib/queries/reviews";

function formatWatchedOn(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function ReviewCard({
  review,
  isOwner,
}: {
  review: PublicReview;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [revealed, setRevealed] = useState(!review.contains_spoilers);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  const name =
    review.display_name ?? (review.handle ? `@${review.handle}` : "Someone");

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/diary", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: review.id }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't delete.");
        setBusy(false);
        return;
      }
      setDeleted(true);
      setConfirmOpen(false);
      router.refresh();
    } catch {
      setError("Couldn't delete.");
      setBusy(false);
    }
  }

  if (deleted) return null;

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center gap-3">
        {review.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={review.avatar_url}
            alt=""
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          <div className="h-9 w-9 rounded-full bg-moonbeem-navy/50" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          {review.handle ? (
            <Link
              href={`/c/${review.handle}`}
              className="text-body-sm font-semibold text-moonbeem-ink hover:text-moonbeem-pink"
            >
              {name}
            </Link>
          ) : (
            <span className="text-body-sm font-semibold text-moonbeem-ink">
              {name}
            </span>
          )}
          {review.handle && review.display_name && (
            <span className="ml-2 text-caption text-moonbeem-ink-subtle">
              @{review.handle}
            </span>
          )}
        </div>
        {review.rating != null && (
          <StarRatingDisplay value={review.rating} size={14} />
        )}
      </div>

      <p className="m-0 text-caption text-moonbeem-ink-subtle">
        Watched {formatWatchedOn(review.watched_on)}
      </p>

      {revealed ? (
        <p className="m-0 whitespace-pre-wrap text-body-sm leading-relaxed text-moonbeem-ink">
          {review.review_text}
        </p>
      ) : (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="self-start rounded-md border border-white/10 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
        >
          This review contains spoilers — show
        </button>
      )}

      {isOwner && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="text-caption text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-magenta"
          >
            Delete
          </button>
          {error && (
            <span className="text-caption text-moonbeem-magenta">{error}</span>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        title="Delete your review?"
        description="This removes the whole diary entry (watch + review)."
        detail="Your star rating for this title is kept."
        confirmLabel="Delete review"
        tone="destructive"
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </article>
  );
}
