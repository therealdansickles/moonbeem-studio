import type { Metadata } from "next";
import "./globals.css";
import { inter, jost } from "./fonts";
import TopNav from "@/components/TopNav";

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
        <TopNav />
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
