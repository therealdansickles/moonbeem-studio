// Title page error boundary. Soft, brand-aligned tone for the
// highest-traffic public surface.

"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

export default function TitleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[title error.tsx]", error.message, error.digest);
  }, [error]);

  return (
    <ErrorState
      heading="Couldn't load that page."
      body="Try again, or browse other films."
      primary={{ kind: "button", onClick: reset, label: "Try again" }}
      secondary={{ kind: "link", href: "/browse", label: "Browse films" }}
    />
  );
}
