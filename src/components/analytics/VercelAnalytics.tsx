"use client";

// Wrapper around @vercel/analytics's <Analytics /> component.
//
// Exists because the root layout is a Server Component and Next.js
// 16 + RSC forbids passing function props (like `beforeSend`) from
// server to client components — they can't be serialized across the
// boundary. Defining the function inside this "use client" wrapper
// keeps it on the client side throughout.
//
// beforeSend filter drops /admin and /p/ traffic so internal +
// partner-dashboard usage stays out of public-traffic stats —
// matches the EXCLUDED_PREFIXES list used by GoogleAnalytics and
// MicrosoftClarity. /api isn't filtered because it doesn't render
// pages, so Vercel Analytics never fires for those URLs anyway.

import { Analytics } from "@vercel/analytics/next";

export default function VercelAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => {
        if (event.url.includes("/admin") || event.url.includes("/p/")) {
          return null;
        }
        return event;
      }}
    />
  );
}
