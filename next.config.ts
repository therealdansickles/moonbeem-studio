import type { NextConfig } from "next";

// Moonbeem CORS policy: same-origin enforcement.
//
// API routes are intended to be called only from moonbeem.studio
// itself — the SSR React UI fetches its own API. There are no
// public embed widgets, no third-party clients, no documented
// public API surface.
//
// The explicit Access-Control-Allow-Origin: https://www.moonbeem.studio
// is defense-in-depth: omitting the header would also block
// cross-origin browser requests by default, but the explicit value
// makes intent legible and prevents accidental loosening.
//
// If we ever add embed widgets on partner sites or open a public API,
// this allowlist needs broadening (likely via a function-based
// `headers()` that echoes back known-good origins). Until then,
// hardcoded primary origin only.
//
// Note: Stripe and other server-to-server webhook callers do NOT
// honor CORS (it's a browser-only mechanism), so this header has no
// effect on webhook delivery to /api/webhooks/stripe.

const ALLOWED_ORIGIN = "https://www.moonbeem.studio";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.squarespace-cdn.com",
      },
      {
        protocol: "https",
        hostname: "image.tmdb.org",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: ALLOWED_ORIGIN },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization",
          },
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Max-Age", value: "86400" },
        ],
      },
    ];
  },
};

export default nextConfig;
