import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Browse · Moonbeem",
};

export default function BrowsePage() {
  return (
    <div className="flex-1 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)] py-12">
      <div className="mx-auto max-w-7xl px-6">
        <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
          Browse
        </h1>
        <p className="mt-4 text-body text-moonbeem-ink-muted">
          Catalog browser coming soon.
        </p>
      </div>
    </div>
  );
}
