// Static OG card for the homepage. Branded gradient background with
// the moonbeem. wordmark + tagline. Auto-mounts at /opengraph-image
// per Next 16 file conventions and is statically optimized at build
// time.
//
// Brand colors mirror the homepage radial gradient (#011754 → #121212)
// and the --color-moonbeem-pink #ffd4f9 wordmark. Default Inter font
// from next/og — exact brand font (Jost) intentionally skipped to
// keep render fast and avoid bundling a font asset for v1.

import { ImageResponse } from "next/og";

export const alt =
  "Moonbeem — authorized fan distribution for independent film";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
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
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 220,
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
            marginTop: 28,
            fontSize: 36,
            color: "rgba(255,255,255,0.78)",
            fontWeight: 500,
            display: "flex",
          }}
        >
          Authorized fan distribution for independent film
        </div>
      </div>
    ),
    { ...size },
  );
}
