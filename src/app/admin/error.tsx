// Admin error boundary. Viewer is super-admin, so we can surface
// diagnostic info (error.digest, message) that we'd hide on public
// pages.

"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin error.tsx]", error);
  }, [error]);

  const diagnostic = [
    error.digest ? `digest: ${error.digest}` : null,
    error.message ? `message: ${error.message}` : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <ErrorState
      heading="Admin route errored."
      body="Surfacing the digest below for log correlation. Try again or back out."
      primary={{ kind: "button", onClick: reset, label: "Try again" }}
      secondary={{ kind: "link", href: "/admin", label: "Back to admin" }}
      diagnostic={diagnostic || undefined}
    />
  );
}
