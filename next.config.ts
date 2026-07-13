import { withSentryConfig } from "@sentry/nextjs";
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
  // React 19 / Next 16 View Transitions API integration. Enables the
  // <ViewTransition> component (imported from "react") to animate
  // route navigations. Marked experimental in the Next 16 docs but
  // is the documented path for cross-route shared-element morphs.
  // Browsers without View Transitions support fall back to instant
  // swap (progressive enhancement).
  experimental: {
    viewTransition: true,
  },
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
      {
        // R2 public bucket — durable poster/asset host (R2_PUBLIC_URL's
        // host; same value stored in titles.poster_url / partners.logo_url,
        // not a secret). Required so next/image (TitlePosterShared, TitleCard)
        // can optimize R2-hosted posters; without it the optimizer 400s →
        // broken placeholder. Exact host, not a wildcard.
        protocol: "https",
        hostname: "pub-8dcc0cdf788945bc87b3931edd0bb800.r2.dev",
      },
    ],
  },
  async redirects() {
    return [
      // /browse is a de facto alias for the homepage today — the
      // homepage (/) carries Trending Edits, Featured titles, the
      // marquee, and the carousels. The old /browse "Catalog browser
      // coming soon" placeholder is gone; "Browse" stays in the nav
      // and now lands somewhere real via this 308. Remove this
      // redirect when a proper /browse catalog browser ships.
      {
        source: "/browse",
        destination: "/",
        permanent: true,
      },
    ];
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

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "dpop-studios",

  project: "moonbeem-studio",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
