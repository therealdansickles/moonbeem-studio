// Dynamic per-title OG card. Poster on the left, title metadata
// stack on the right with brand colors. Honors the same canViewTitle
// gate as the page so unlisted titles don't leak via OpenGraph
// previews — they fall through to a generic Moonbeem branded card.
//
// Auto-mounts at /t/[slug]/opengraph-image and overrides the
// page-level openGraph.images for free.

import { ImageResponse } from "next/og";
import { getTitleBySlug } from "@/lib/queries/titles";
import { canViewTitle } from "@/lib/title-access";

export const alt = "Title on Moonbeem";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const title = await getTitleBySlug(slug);

  // Hidden / unknown title → generic brand card. Mirrors the page's
  // metadata fallback so OG previews don't leak title names for
  // is_public=false rows shared with non-members.
  const visible =
    title &&
    (await canViewTitle({
      is_public: title.is_public,
      partner_id: title.partner_id,
    }));

  if (!title || !visible) {
    return new ImageResponse(genericCard(), { ...size });
  }

  return new ImageResponse(titleCard(title), { ...size });
}

function genericCard(): React.ReactElement {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(ellipse at center, #011754 0%, #121212 100%)",
        padding: "80px",
      }}
    >
      <div
        style={{
          fontSize: 200,
          fontWeight: 700,
          color: "#ffd4f9",
          letterSpacing: "-0.04em",
          lineHeight: 0.95,
          display: "flex",
        }}
      >
        moonbeem.
      </div>
      <div
        style={{
          marginTop: 24,
          fontSize: 32,
          color: "rgba(255,255,255,0.78)",
          fontWeight: 500,
          display: "flex",
        }}
      >
        Authorized fan distribution for independent film
      </div>
    </div>
  );
}

function titleCard(title: {
  title: string;
  year: number | null;
  poster_url: string | null;
  synopsis: string | null;
}): React.ReactElement {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "row",
        background:
          "radial-gradient(ellipse at center, #011754 0%, #121212 100%)",
        padding: "60px",
        gap: "60px",
        alignItems: "center",
      }}
    >
      {/* Left: poster */}
      <div
        style={{
          width: 340,
          height: 510,
          flexShrink: 0,
          borderRadius: 16,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(255,255,255,0.04)",
          boxShadow:
            "0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)",
        }}
      >
        {title.poster_url
          ? (
            <img
              src={title.poster_url}
              alt=""
              width={340}
              height={510}
              style={{ width: 340, height: 510, objectFit: "cover" }}
            />
          )
          : (
            <div
              style={{
                fontSize: 28,
                color: "rgba(255,255,255,0.4)",
                display: "flex",
              }}
            >
              No poster
            </div>
          )}
      </div>

      {/* Right: title + meta */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          flex: 1,
          gap: 18,
          // Cap the title's vertical space so very long titles don't
          // collide with the wordmark below.
          maxHeight: "100%",
        }}
      >
        <div
          style={{
            fontSize: clampFontSize(title.title),
            fontWeight: 700,
            color: "#ffffff",
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
            display: "flex",
            // Length-aware font clamping (clampFontSize below) keeps
            // titles within the right-column bounds without needing
            // line-clamp; longer titles just render smaller.
          }}
        >
          {title.title}
        </div>
        {title.year && (
          <div
            style={{
              fontSize: 30,
              color: "rgba(255,255,255,0.55)",
              fontWeight: 500,
              display: "flex",
            }}
          >
            {title.year}
          </div>
        )}
        <div
          style={{
            marginTop: 24,
            fontSize: 36,
            color: "#ffd4f9",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            display: "flex",
          }}
        >
          on moonbeem.
        </div>
      </div>
    </div>
  );
}

// Title font size scales down as the title gets longer so a 60-char
// title doesn't collide with the right-edge or wordmark. Tuned to
// the 720px right-column width (1200 - 60 padding - 340 poster - 60
// gap - 20 right padding).
function clampFontSize(title: string): number {
  const len = title.length;
  if (len <= 18) return 80;
  if (len <= 28) return 64;
  if (len <= 44) return 52;
  return 44;
}
