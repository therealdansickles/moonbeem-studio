import Link from "next/link";

// Hardcoded for the 2026-05-12 Emerson Collective pitch. DB-driven
// ordering + super-admin partner activation are deferred to the
// post-pitch admin-UI scoping conversation. `kind` lets us render
// wordmark partners at 32px height and square/lockup partners at
// 48px height so the marquee reads as visually balanced rather
// than letting the square lockups become 32×32 thumbnails.
type Kind = "wordmark" | "square";
type Partner = {
  slug: string;
  name: string;
  kind: Kind;
};

const PARTNERS: Partner[] = [
  { slug: "magnolia-pictures", name: "Magnolia Pictures", kind: "wordmark" },
  { slug: "oscilloscope-laboratories", name: "Oscilloscope Laboratories", kind: "wordmark" },
  { slug: "roadside-attractions", name: "Roadside Attractions", kind: "square" },
  { slug: "topic-studios", name: "Topic Studios", kind: "square" },
  { slug: "1-2-special", name: "1-2 Special", kind: "wordmark" },
  { slug: "mitten-media", name: "Mitten Media", kind: "wordmark" },
];

const R2_BASE = "https://pub-8dcc0cdf788945bc87b3931edd0bb800.r2.dev";

function logoUrl(slug: string) {
  return `${R2_BASE}/partners/${slug}/logo.png`;
}

function PartnerCell({ partner }: { partner: Partner }) {
  // Plain <img> rather than next/image: 6 small logos rendered at
  // 32–48px on every page view, browser downscaling 1024² PNGs is
  // fine and avoids adding R2 to next.config remotePatterns.
  const height = partner.kind === "square" ? 48 : 32;
  return (
    <Link
      href={`/p/${partner.slug}`}
      aria-label={partner.name}
      className="flex shrink-0 items-center justify-center opacity-60 transition-opacity duration-200 hover:opacity-100"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={logoUrl(partner.slug)}
        alt={partner.name}
        height={height}
        style={{ height: `${height}px`, width: "auto" }}
        draggable={false}
      />
    </Link>
  );
}

export default function PartnerLogoScroll() {
  // Render the list twice so the -50% translate loops seamlessly.
  // aria-hidden on the duplicate keeps screen readers from
  // announcing each partner name twice.
  return (
    <div
      className="relative w-full overflow-hidden py-6"
      aria-label="Distribution partners"
    >
      <div className="marquee-track flex items-center gap-14 px-7">
        {PARTNERS.map((p) => (
          <PartnerCell key={`a-${p.slug}`} partner={p} />
        ))}
        {PARTNERS.map((p) => (
          <div key={`b-${p.slug}`} aria-hidden="true">
            <PartnerCell partner={p} />
          </div>
        ))}
      </div>
    </div>
  );
}
