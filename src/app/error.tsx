// Root error boundary — catches unhandled errors thrown anywhere
// below the root layout that aren't caught by a more specific
// segment-level error.tsx.
//
// Next.js convention: error.tsx is a Client Component, receives
// { error, reset } props. `reset()` re-renders the segment without
// the error state — useful when the error is transient.

"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[root error.tsx]", error.message, error.digest);
  }, [error]);

  return (
    <ErrorState
      heading="Something didn't load."
      body="Try again, or head back home and pick up where you left off."
      primary={{ kind: "button", onClick: reset, label: "Try again" }}
      secondary={{ kind: "link", href: "/", label: "Go home" }}
    />
  );
}
