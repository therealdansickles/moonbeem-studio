import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "For You · Moonbeem",
};

export default function ForYouPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
        For You
      </h1>
      <p className="text-body text-moonbeem-ink-muted text-center max-w-md leading-relaxed">
        Your fan edit feed is on the way. We&apos;re tuning recommendations
        based on what you watch, save, and create. Check back soon.
      </p>
    </div>
  );
}
