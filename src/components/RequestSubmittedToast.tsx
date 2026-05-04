"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Phase = "hidden" | "entering" | "visible" | "leaving";

const ENTER_MS = 20;
const VISIBLE_MS = 6000;
const EXIT_MS = 200;

export default function RequestSubmittedToast() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [phase, setPhase] = useState<Phase>("hidden");
  const [titleName, setTitleName] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get("request_submitted") !== "1") return;
    setTitleName(searchParams.get("title"));
    setPhase("entering");

    const clean = new URLSearchParams(searchParams.toString());
    clean.delete("request_submitted");
    clean.delete("title");
    const q = clean.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });

    const enterT = setTimeout(() => setPhase("visible"), ENTER_MS);
    const exitT = setTimeout(() => setPhase("leaving"), VISIBLE_MS);
    const unmountT = setTimeout(
      () => setPhase("hidden"),
      VISIBLE_MS + EXIT_MS,
    );
    return () => {
      clearTimeout(enterT);
      clearTimeout(exitT);
      clearTimeout(unmountT);
    };
  }, [searchParams, pathname, router]);

  if (phase === "hidden") return null;

  const visible = phase === "visible";
  const message = titleName
    ? `Your fan edit request for ${titleName} has been submitted.`
    : "Your fan edit request has been submitted.";

  function dismiss() {
    setPhase("leaving");
    setTimeout(() => setPhase("hidden"), EXIT_MS);
  }

  return (
    <div
      className={[
        "fixed z-50 max-w-sm w-[calc(100%-2rem)]",
        "bottom-6 left-1/2 -translate-x-1/2",
        "sm:left-auto sm:right-6 sm:translate-x-0",
        "bg-moonbeem-black/95 backdrop-blur-md",
        "border border-white/10 border-l-4 border-l-moonbeem-pink",
        "rounded-md shadow-2xl shadow-black/50",
        "px-4 py-3 pr-10",
        "transition-all duration-200 ease-out",
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
      ].join(" ")}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <svg
          className="h-4 w-4 mt-0.5 shrink-0 text-moonbeem-pink"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 8.5l3.5 3.5L13 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className="text-body-sm text-moonbeem-ink leading-snug">{message}</p>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="absolute top-2 right-2 h-6 w-6 flex items-center justify-center rounded text-moonbeem-ink-muted hover:text-moonbeem-ink hover:bg-white/5 transition-colors"
      >
        <svg
          className="h-3 w-3"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 2l8 8M10 2l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
