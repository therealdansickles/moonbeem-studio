"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const HANDLE_RE = /^[a-z0-9_]{3,30}$/;
type AvailStatus = "idle" | "checking" | "available" | "taken" | "invalid";

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30);
}

type Props = {
  next?: string | null;
  requestSubmittedTitle?: string | null;
};

export default function HandlePicker({
  next,
  requestSubmittedTitle,
}: Props = {}) {
  const router = useRouter();
  const [handle, setHandle] = useState("");
  const [status, setStatus] = useState<AvailStatus>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const value = handle.trim();
    if (value.length === 0) {
      setStatus("idle");
      return;
    }
    if (!HANDLE_RE.test(value)) {
      setStatus("invalid");
      return;
    }
    setStatus("checking");
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch("/api/users/handle/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ handle: value }),
          signal: ac.signal,
        });
        const json = (await res.json()) as { available?: boolean };
        if (!ac.signal.aborted) {
          setStatus(json.available ? "available" : "taken");
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") setStatus("idle");
      }
    }, 500);
    return () => clearTimeout(t);
  }, [handle]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status !== "available" || submitting) return;
    setSubmitting(true);
    setErrorMsg("");
    try {
      const res = await fetch("/api/users/handle/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: handle.trim() }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErrorMsg(json.error ?? `claim ${res.status}`);
        setSubmitting(false);
        return;
      }
      const dest = next ?? "/me";
      const tail = (() => {
        if (!requestSubmittedTitle) return "";
        const p = new URLSearchParams();
        p.set("request_submitted", "1");
        p.set("title", requestSubmittedTitle);
        return `?${p.toString()}`;
      })();
      router.replace(`${dest}${tail}`);
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const helper =
    status === "checking"
      ? "Checking..."
      : status === "available"
        ? "Available ✓"
        : status === "taken"
          ? "Already taken"
          : status === "invalid"
            ? "3–30 chars: a–z, 0–9, underscore"
            : "Lowercase letters, numbers, underscores";

  const helperClass =
    status === "available"
      ? "text-moonbeem-lime"
      : status === "taken" || status === "invalid"
        ? "text-moonbeem-magenta"
        : "text-moonbeem-ink-subtle";

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <h1 className="font-wordmark text-display-sm text-moonbeem-pink m-0">
            Pick your handle
          </h1>
          <p className="text-body-sm text-moonbeem-ink-muted">
            This is how others will find you on Moonbeem.
          </p>
        </div>

        <div className="flex items-center rounded-md border border-moonbeem-border-strong bg-transparent focus-within:border-moonbeem-pink transition-colors">
          <span className="pl-4 pr-1 text-body text-moonbeem-ink-subtle select-none">
            @
          </span>
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={handle}
            onChange={(e) => setHandle(sanitize(e.target.value))}
            placeholder="yourhandle"
            disabled={submitting}
            className="flex-1 bg-transparent py-3 pr-4 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none disabled:opacity-60"
          />
        </div>

        <p className={`text-body-sm ${helperClass}`}>{helper}</p>

        <button
          type="submit"
          disabled={status !== "available" || submitting}
          className="w-full rounded-md bg-moonbeem-pink text-moonbeem-navy px-4 py-3 text-body font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          {submitting ? "Claiming..." : `Claim @${handle || "handle"}`}
        </button>

        {errorMsg && (
          <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
        )}
      </form>
    </div>
  );
}
