// Root 404. Triggered by notFound() calls anywhere below the root
// layout that aren't caught by a more specific not-found.tsx.

import Link from "next/link";
import ErrorState from "@/components/ErrorState";

export default function NotFound() {
  return (
    <ErrorState
      heading="Couldn't find that."
      body="The page may have moved, or the link might be off. Try one of these instead."
      primary={{ kind: "link", href: "/", label: "Go home" }}
      secondary={{ kind: "link", href: "/browse", label: "Browse films" }}
    />
  );
}
