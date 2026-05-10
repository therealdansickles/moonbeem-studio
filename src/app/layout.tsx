import type { Metadata } from "next";
import "./globals.css";
import { inter, jost } from "./fonts";
import TopNav from "@/components/TopNav";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body
        className={`${inter.variable} ${jost.variable} min-h-full flex flex-col font-sans antialiased`}
      >
        <GoogleAnalytics />
        <VercelAnalytics />
        <MicrosoftClarity />
        <TopNav />
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
