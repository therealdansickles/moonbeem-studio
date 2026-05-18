"use client";

// Partner-page hero logo wrapped in a React <ViewTransition>, paired
// with the matching PartnerLogoStrip ViewTransition by the shared
// name `partner-logo-${slug}`. Lets the logo morph from the
// homepage partner strip into the /p/[slug] hero.
//
// Thin client-component wrapper. The /p/[slug] page is a server
// component and stays that way — only the logo image moves into
// this client boundary so it can import the React 19 ViewTransition
// API. Plain <img> (not next/image) preserves the partner page's
// existing escape from the R2 domain whitelist for arbitrary
// partner-uploaded logo URLs.

import { ViewTransition } from "react";

type Props = {
  slug: string;
  src: string;
  alt: string;
};

export default function PartnerLogoShared({ slug, src, alt }: Props) {
  return (
    <ViewTransition name={`partner-logo-${slug}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        height={144}
        style={{ height: "144px", width: "auto" }}
        className="overflow-hidden rounded-lg"
        draggable={false}
      />
    </ViewTransition>
  );
}
