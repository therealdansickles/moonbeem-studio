"use client";

// Client wrapper around the offer-button anchor on /t/[slug]. Fires
// the GA external_click event on click. Visual / target / rel
// behaviour is identical to the original server-rendered <a>.
//
// This is split into a client component because the parent
// /t/[slug] page is a Server Component — server components can't
// attach onClick handlers.

import { trackExternalClick } from "@/lib/analytics/track";

export default function OfferButtonClient({
  href,
  label,
  className,
  titleId,
  offerType,
  destinationUrl,
}: {
  href: string;
  label: string;
  className: string;
  titleId: string;
  offerType: string | null;
  destinationUrl: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className={className}
      onClick={() => {
        trackExternalClick({
          title_id: titleId,
          offer_type: offerType,
          destination_url: destinationUrl,
        });
      }}
    >
      {label}
    </a>
  );
}
