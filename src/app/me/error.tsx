// User account error boundary. Friendly, suggests refresh or sign
// out + back in for state-related issues.

"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

export default function MeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[me error.tsx]", error.message, error.digest);
  }, [error]);

  return (
    <ErrorState
      heading="Couldn't load your account."
      body="Try refreshing. If that doesn't help, signing out and back in usually does."
      primary={{ kind: "button", onClick: reset, label: "Try again" }}
      secondary={{ kind: "link", href: "/", label: "Go home" }}
    />
  );
}
