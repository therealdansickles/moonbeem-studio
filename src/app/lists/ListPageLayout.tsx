// Shared chrome for every /lists/* page (curated [slug] lists,
// Featured, Recently added). Owns the auth-aware Back link, the
// header, and the viewer's Top 12 read — so each route page only has
// to fetch its own titles and hand over a ListSlot[].

import Link from "next/link";
import { getUser } from "@/lib/dal";
import { getTopTitlesForUser } from "@/lib/queries/profiles";
import ListPageClient, { type ListSlot } from "./ListPageClient";

export default async function ListPageLayout({
  name,
  description,
  itemCount,
  noun,
  slots,
  pagePath,
}: {
  name: string;
  description: string | null;
  itemCount: number;
  /** "films" / "series" / "titles" — the unit for the count line. */
  noun: string;
  slots: ListSlot[];
  /** The current page path, for the sign-in redirect back. */
  pagePath: string;
}) {
  // Auth-aware: drives both the Back link target and the card state.
  const user = await getUser();
  const isAuthed = !!user;
  let initialPickedIds: string[] = [];
  let initialPickCount = 0;
  if (user) {
    const picks = await getTopTitlesForUser(user.id);
    initialPickedIds = picks.map((p) => p.title_id);
    initialPickCount = picks.length;
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)] px-6 py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <Link
          href={isAuthed ? "/me/top-12" : "/"}
          className="self-start text-body-sm text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
        >
          ← {isAuthed ? "Back to your top 12" : "Browse"}
        </Link>

        <header className="flex flex-col gap-2">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            {name}
          </h1>
          {description && (
            <p className="m-0 max-w-2xl text-body text-moonbeem-ink-muted leading-relaxed">
              {description}
            </p>
          )}
          <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
            {itemCount} {noun}
          </p>
        </header>

        <ListPageClient
          redirectPath={pagePath}
          slots={slots}
          isAuthed={isAuthed}
          initialPickedIds={initialPickedIds}
          initialPickCount={initialPickCount}
        />
      </div>
    </div>
  );
}
