// Creator profile error boundary. Soft, brand-aligned.

"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

export default function CreatorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[creator error.tsx]", error.message, error.digest);
  }, [error]);

  return (
    <ErrorState
      heading="Couldn't load that creator."
      body="Try again, or head back home."
      primary={{ kind: "button", onClick: reset, label: "Try again" }}
      secondary={{ kind: "link", href: "/", label: "Go home" }}
    />
  );
}
