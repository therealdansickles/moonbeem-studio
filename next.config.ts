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
      // Security response headers — applied to all routes. Vercel
      // already sets Strict-Transport-Security (max-age=63072000); we
      // don't override that here to avoid duplicate-header noise.
      // Content-Security-Policy is intentionally NOT set — getting it
      // wrong is worse than not having it; tracked as a followup so
      // we can build a per-origin allowlist (R2, Supabase, TMDb,
      // Vercel analytics, etc.) carefully.
      {
        source: "/:path*",
        headers: [
          // Clickjacking defense: only this origin can iframe us.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Prevent MIME sniffing: browsers must honor declared
          // Content-Type instead of guessing.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Send full origin only to same-origin requests; cross-
          // origin requests get just the origin (no path). Sensible
          // default that doesn't leak request paths to third parties.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Deny camera/mic/geolocation by default. If a feature
          // needs one of these (e.g., a creator-side recording
          // tool), opt in per-page via a route-specific override.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
      // CORS on /api/:path* — see ALLOWED_ORIGIN block above for
      // threat-model context. Same-origin enforcement.
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
