// Partner segment error boundary. Business-tone — partners are
// commercial accounts and may need to escalate.

"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

export default function PartnerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[partner error.tsx]", error.message, error.digest);
  }, [error]);

  return (
    <ErrorState
      heading="Couldn't load this dashboard."
      body="Try again in a moment. If this keeps happening, reach out at support@moonbeem.studio and reference the digest below."
      primary={{ kind: "button", onClick: reset, label: "Try again" }}
      secondary={{ kind: "link", href: "/", label: "Go home" }}
      diagnostic={error.digest ? `ref: ${error.digest}` : undefined}
    />
  );
}
