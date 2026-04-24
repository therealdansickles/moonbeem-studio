import { Inter, Jost } from "next/font/google";

export const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin"],
  weight: ["700"],
  display: "swap",
});
