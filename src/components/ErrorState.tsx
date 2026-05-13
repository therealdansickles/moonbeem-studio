// Shared error-state UI for error.tsx + not-found.tsx boundaries.
//
// Brand voice (per Dan's 2026-05-13 style guide):
//   - Soft, editorial, never alarmist
//   - Short declarative sentences
//   - No em dashes, no exclamation marks
//   - Don't blame the user
//   - Specific over generic where useful
//   - Always one clear next action
//
// Surface variants pass tone + body + actions; the component handles
// layout, typography, and the brand-aligned visual frame.

"use client";

import Link from "next/link";

export type ErrorStateAction =
  | { kind: "link"; href: string; label: string }
  | { kind: "button"; onClick: () => void; label: string };

export type ErrorStateProps = {
  /** Single short headline, e.g. "Couldn't load that page." */
  heading: string;
  /** Optional body paragraph (one or two sentences). */
  body?: string;
  /** Primary action (e.g., Refresh, Go home). */
  primary?: ErrorStateAction;
  /** Optional secondary action. */
  secondary?: ErrorStateAction;
  /** Diagnostic line shown below actions (admin surfaces only). */
  diagnostic?: string;
};

export default function ErrorState({
  heading,
  body,
  primary,
  secondary,
  diagnostic,
}: ErrorStateProps) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6 py-12">
      <div className="max-w-md flex flex-col items-center gap-6 text-center">
        <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
          {heading}
        </h1>
        {body && (
          <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
            {body}
          </p>
        )}
        {(primary || secondary) && (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {primary && <ActionButton action={primary} variant="primary" />}
            {secondary && <ActionButton action={secondary} variant="secondary" />}
          </div>
        )}
        {diagnostic && (
          <p className="font-mono text-caption text-moonbeem-ink-subtle m-0 break-all">
            {diagnostic}
          </p>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  variant,
}: {
  action: ErrorStateAction;
  variant: "primary" | "secondary";
}) {
  const cls =
    variant === "primary"
      ? "bg-moonbeem-pink text-moonbeem-navy rounded-md px-5 py-2.5 text-body-sm font-semibold hover:opacity-90 transition-opacity"
      : "border border-white/15 text-moonbeem-ink rounded-md px-5 py-2.5 text-body-sm hover:border-moonbeem-pink hover:text-moonbeem-pink transition-colors";
  if (action.kind === "link") {
    return (
      <Link href={action.href} className={cls}>
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={cls}>
      {action.label}
    </button>
  );
}
