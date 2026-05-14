// Site-wide footer. Rendered once in the root layout after <main>,
// so it sits at the bottom of every page. The root <body> is
// `min-h-full flex flex-col` with `<main>` as `flex-1`, so this
// footer naturally pins to the bottom on short pages without any
// sticky positioning.
//
// Server component — no interactivity. Kept deliberately minimal so
// it doesn't compete with the gradient hero on partner pages; a
// single hairline border-top and a faint bg tint do the delineation.

import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-white/10 bg-moonbeem-black/30">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-12 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <span className="font-wordmark text-heading-md text-moonbeem-pink">
            moonbeem.
          </span>
          <p className="m-0 text-body-sm text-moonbeem-ink-muted">
            Authorized fan distribution for media.
          </p>
        </div>

        <div className="flex flex-col gap-3 md:items-end">
          <nav className="flex flex-wrap items-center gap-5">
            <Link
              href="/privacy-policy"
              className="text-body-sm text-moonbeem-ink-muted transition-colors hover:text-moonbeem-pink"
            >
              Privacy
            </Link>
            <a
              href="mailto:privacy@moonbeem.xyz"
              className="text-body-sm text-moonbeem-ink-muted transition-colors hover:text-moonbeem-pink"
            >
              Contact
            </a>
          </nav>
          <p className="m-0 text-caption text-moonbeem-ink-subtle">
            © 2026 Moonbeem, Inc.
          </p>
        </div>
      </div>
    </footer>
  );
}
