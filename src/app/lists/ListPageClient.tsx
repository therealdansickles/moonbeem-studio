"use client";

// Interactive grid shared by every /lists/* page (curated [slug]
// lists, Featured, Recently added). Owns the same optimistic
// add/remove state as the Top 12 builder, for a flat membership
// view (no ordering). Unmatched-catalog positions render as explicit
// placeholders. Unauthenticated viewers can browse freely; clicking
// +Add surfaces an inline sign-in prompt rather than hitting the
// auth-gated API.

import Link from "next/link";
import { useState, useCallback } from "react";
import {
  fetchJson,
  FetchJsonError,
  RateLimitedError,
} from "@/lib/fetch-json";
import type { BuilderTitle } from "@/app/me/top-12/Top12Builder";
import BuilderTitleCard from "@/app/me/top-12/BuilderTitleCard";

export type ListSlot = { position: number; title: BuilderTitle | null };

const MAX_PICKS = 12;

function mutationError(err: unknown, fallback: string): string {
  if (err instanceof RateLimitedError || err instanceof FetchJsonError) {
    return err.userMessage;
  }
  return fallback;
}

export default function ListPageClient({
  redirectPath,
  slots,
  isAuthed,
  initialPickedIds,
  initialPickCount,
}: {
  // Where /login should return after sign-in — the current page path
  // (e.g. "/lists/afi-top-100", "/lists/featured").
  redirectPath: string;
  slots: ListSlot[];
  isAuthed: boolean;
  initialPickedIds: string[];
  initialPickCount: number;
}) {
  const [pickedIds, setPickedIds] = useState<Set<string>>(
    () => new Set(initialPickedIds),
  );
  const [pickCount, setPickCount] = useState(initialPickCount);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showSignInPrompt, setShowSignInPrompt] = useState(false);

  const atCapacity = pickCount >= MAX_PICKS;

  const markPending = useCallback((id: string, on: boolean) => {
    setPendingIds((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  async function addPick(t: BuilderTitle) {
    if (atCapacity || pickedIds.has(t.id) || pendingIds.has(t.id)) return;
    setPickedIds((s) => new Set(s).add(t.id));
    setPickCount((c) => c + 1);
    setErrorMsg(null);
    markPending(t.id, true);
    try {
      // position is a best guess; the add endpoint reassigns to the
      // next free slot if it's taken. Order isn't shown here anyway.
      await fetchJson("/api/profile/top-titles/add", {
        method: "POST",
        body: { title_id: t.id, position: pickCount + 1 },
      });
    } catch (err) {
      setPickedIds((s) => {
        const next = new Set(s);
        next.delete(t.id);
        return next;
      });
      setPickCount((c) => c - 1);
      // Defensive fallback: anonymous adds are already pre-empted by
      // the isAuthed check in handleToggle, but if a 403 (auth_required)
      // does come back from the gated endpoint, surface the same
      // sign-in prompt rather than a generic error.
      if (err instanceof FetchJsonError && err.status === 403) {
        setShowSignInPrompt(true);
        return;
      }
      setErrorMsg(mutationError(err, "Couldn't add that title. Try again."));
    } finally {
      markPending(t.id, false);
    }
  }

  async function removePick(titleId: string) {
    if (pendingIds.has(titleId)) return;
    setPickedIds((s) => {
      const next = new Set(s);
      next.delete(titleId);
      return next;
    });
    setPickCount((c) => c - 1);
    setErrorMsg(null);
    markPending(titleId, true);
    try {
      await fetchJson("/api/profile/top-titles/remove", {
        method: "POST",
        body: { title_id: titleId },
      });
    } catch (err) {
      setPickedIds((s) => new Set(s).add(titleId));
      setPickCount((c) => c + 1);
      setErrorMsg(
        mutationError(err, "Couldn't remove that title. Try again."),
      );
    } finally {
      markPending(titleId, false);
    }
  }

  function handleToggle(t: BuilderTitle) {
    if (!isAuthed) {
      setShowSignInPrompt(true);
      return;
    }
    if (pickedIds.has(t.id)) removePick(t.id);
    else addPick(t);
  }

  return (
    <div className="flex flex-col gap-6">
      {showSignInPrompt && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-moonbeem-pink/30 bg-moonbeem-pink/[0.06] p-4">
          <p className="m-0 text-body-sm text-moonbeem-ink">
            Sign in to add titles to your top 12.
          </p>
          <Link
            href={`/login?redirect_to=${encodeURIComponent(redirectPath)}`}
            className="inline-block rounded-md bg-moonbeem-pink px-4 py-1.5 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
          >
            Sign in →
          </Link>
        </div>
      )}

      {errorMsg && (
        <p className="m-0 text-caption text-moonbeem-magenta">{errorMsg}</p>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {slots.map((slot) =>
          slot.title ? (
            <BuilderTitleCard
              key={slot.title.id}
              title={slot.title}
              isAdded={pickedIds.has(slot.title.id)}
              atCapacity={atCapacity}
              pending={pendingIds.has(slot.title.id)}
              onToggle={() => handleToggle(slot.title as BuilderTitle)}
              fill
            />
          ) : (
            <PlaceholderCard
              key={`gap-${slot.position}`}
              position={slot.position}
            />
          ),
        )}
      </div>
    </div>
  );
}

// Empty position — a title from the source list that hasn't been
// matched to the catalog yet. Rendered explicitly so the ranking gap
// is visible content, not a silent omission.
function PlaceholderCard({ position }: { position: number }) {
  return (
    <div
      className="flex w-full flex-col gap-2"
      title="Title pending catalog match"
    >
      <div className="flex aspect-[2/3] w-full items-center justify-center rounded-lg border border-dashed border-white/10 bg-white/[0.02]">
        <span className="font-wordmark text-heading-md tabular-nums text-moonbeem-ink-subtle">
          {position}
        </span>
      </div>
      <p className="m-0 text-caption text-moonbeem-ink-subtle">
        Position {position}
      </p>
    </div>
  );
}
