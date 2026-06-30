"use client";

import { ViewTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import type { Title } from "@/lib/queries/titles";

type Props = {
  title: Pick<Title, "id" | "slug" | "title" | "poster_url">;
  // Optional CPM chip rendered in the top-right corner of the
  // poster. Only the active-campaigns homepage carousel passes this
  // today; all other call sites omit it and the chip is not
  // rendered. The string is preformatted server-side
  // ("$X.XX per 1,000 views") so the card doesn't reach for any
  // campaign internals.
  cpmDisplay?: string | null;
  // Affiliate attribution (Stage 3): when set (the profile Top-12 view-only
  // render passes the profile owner's creator_id), the card links through
  // /go/title so that curator is credited if the viewer rents. Every other
  // call site omits it → a bare /t/[slug] link, unchanged.
  viaCreatorId?: string;
};

export default function TitleCard({ title, cpmDisplay, viaCreatorId }: Props) {
  const href = viaCreatorId
    ? `/go/title?via=${encodeURIComponent(viaCreatorId)}&slug=${encodeURIComponent(title.slug)}`
    : `/t/${title.slug}`;

  return (
    <Link
      href={href}
      className="group relative block aspect-[2/3] w-full overflow-hidden rounded-xl bg-moonbeem-navy/40 transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] hover:scale-[1.03] hover:shadow-[0_20px_40px_rgba(245,197,225,0.3)] focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
    >
      {title.poster_url ? (
        <>
          <ViewTransition name={`title-poster-${title.slug}`}>
            <Image
              src={title.poster_url}
              alt={`${title.title} poster`}
              fill
              sizes="(max-width: 768px) 50vw, 240px"
              draggable={false}
              className="select-none object-cover"
            />
          </ViewTransition>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-3 pt-10">
            <p className="text-body-sm font-semibold text-moonbeem-ink leading-tight line-clamp-2">
              {title.title}
            </p>
          </div>
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-moonbeem-navy to-moonbeem-black p-4 text-center">
          <span className="font-wordmark text-heading-md text-moonbeem-ink">
            {title.title}
          </span>
        </div>
      )}
      {cpmDisplay ? (
        <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-moonbeem-pink px-2 py-0.5 text-[10px] font-semibold text-moonbeem-navy shadow-md">
          {cpmDisplay}
        </span>
      ) : null}
    </Link>
  );
}
