import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { inter, jost } from "./fonts";
import TopNav from "@/components/TopNav";
import Footer from "@/components/Footer";
import FanEditModalProvider from "@/components/FanEditModalProvider";
import ConsentProvider from "@/components/consent/ConsentProvider";
import ConsentBanner from "@/components/consent/ConsentBanner";
import GoogleAnalytics from "@/components/analytics/GoogleAnalytics";
import VercelAnalytics from "@/components/analytics/VercelAnalytics";
import MicrosoftClarity from "@/components/analytics/MicrosoftClarity";

export const metadata: Metadata = {
  // metadataBase resolves all relative image URLs (per-route
  // opengraph-image.tsx outputs as /opengraph-image,
  // /t/<slug>/opengraph-image, etc.) to absolute URLs that link-
  // preview crawlers can fetch. Hard-coded to the canonical apex
  // since Vercel preview deploys still get correct OG previews via
  // the per-deploy URL the crawler sees.
  metadataBase: new URL("https://www.moonbeem.studio"),
  title: "Moonbeem",
  description:
    "Authorized fan distribution for independent film. Hosting. Marketing. Distribution.",
  openGraph: {
    title: "Moonbeem",
    description:
      "Authorized fan distribution for independent film. Hosting. Marketing. Distribution.",
    url: "https://www.moonbeem.studio",
    siteName: "Moonbeem",
    type: "website",
    // images intentionally omitted — root opengraph-image.tsx
    // auto-generates the branded 1200x630 homepage card and child
    // segments override with their own opengraph-image.tsx.
  },
  twitter: {
    card: "summary_large_image",
    title: "Moonbeem",
    description:
      "Authorized fan distribution for independent film. Hosting. Marketing. Distribution.",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Vercel injects the ISO-3166-1 alpha-2 country code on every
  // request via x-vercel-ip-country. Local dev / non-Vercel hosts
  // → undefined → ConsentProvider treats as opt-in (safer default).
  const hdrs = await headers();
  const country = hdrs.get("x-vercel-ip-country") ?? null;

  return (
    <html lang="en" className="h-full">
      <body
        className={`${inter.variable} ${jost.variable} min-h-full flex flex-col font-sans antialiased bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]`}
      >
        {/*
          GoogleAnalytics + MicrosoftClarity MUST render inside
          <ConsentProvider> because they call useConsent() at render
          time. Rendering them as siblings of the provider crashes
          SSR with "useConsent must be called inside
          <ConsentProvider>". VercelAnalytics doesn't read consent
          (cookie-less) and is safe outside; kept here for symmetry.
        */}
        <VercelAnalytics />
        <ConsentProvider initialCountry={country}>
          <GoogleAnalytics />
          <MicrosoftClarity />
          <FanEditModalProvider>
            <TopNav />
            <main className="flex-1 flex flex-col">{children}</main>
            <Footer />
            <ConsentBanner />
          </FanEditModalProvider>
        </ConsentProvider>
      </body>
    </html>
  );
}
