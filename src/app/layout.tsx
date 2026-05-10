import type { Metadata } from "next";
import { Analytics as VercelAnalytics } from "@vercel/analytics/next";
import "./globals.css";
import { inter, jost } from "./fonts";
import TopNav from "@/components/TopNav";
import GoogleAnalytics from "@/components/analytics/GoogleAnalytics";
import MicrosoftClarity from "@/components/analytics/MicrosoftClarity";

export const metadata: Metadata = {
  title: "Moonbeem",
  description:
    "Authorized fan distribution for independent film. Hosting. Marketing. Distribution.",
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
        {/* Vercel Analytics — cookie-less, no consent banner needed.
            beforeSend drops events for /admin and /p/ so internal +
            partner-dashboard traffic doesn't pollute the public-
            traffic stats (matches GoogleAnalytics + MicrosoftClarity
            exclusions). API routes don't render this layout, so no
            /api filter is needed. */}
        <VercelAnalytics
          beforeSend={(event) => {
            if (
              event.url.includes("/admin") ||
              event.url.includes("/p/")
            ) {
              return null;
            }
            return event;
          }}
        />
        <MicrosoftClarity />
        <TopNav />
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
