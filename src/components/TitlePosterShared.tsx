"use client";

// Title-page hero poster wrapped in a React <ViewTransition>, paired
// with the matching TitleCard ViewTransition by the shared name
// `title-poster-${slug}`. Lets the poster morph from any TitleCard
// click (homepage carousels, /search results, profile Top-12 grids)
// into the title-page hero.
//
// Thin client-component wrapper. The /t/[slug] page is a server
// component and stays that way — only the poster image moves into
// this client boundary so it can import the React 19 ViewTransition
// API.

import { ViewTransition } from "react";
import Image from "next/image";

type Props = {
  slug: string;
  src: string;
  alt: string;
};

export default function TitlePosterShared({ slug, src, alt }: Props) {
  return (
    <ViewTransition name={`title-poster-${slug}`}>
      <Image
        src={src}
        alt={alt}
        width={600}
        height={900}
        className="w-full h-auto"
        priority
      />
    </ViewTransition>
  );
}
