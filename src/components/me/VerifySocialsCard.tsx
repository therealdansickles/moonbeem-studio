"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ALLOWED_SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "@/lib/socials/handle";
import {
  PLATFORM_BIO_LABEL,
  PLATFORM_LABEL,
  buildSocialProfileUrl,
} from "@/lib/socials/profile-url";
import PlatformIcon from "@/components/PlatformIcon";

type SocialRow = {
  platform: SocialPlatform;
  handle: string | null;
  verified_at: string | null;
  is_verified: boolean | null;
  verification_code: string | null;
  verification_started_at: string | null;
  display_on_profile: boolean | null;
};

type Props = {
  // Pre-fetched on the server. The component refreshes via
  // /api/me/socials after each successful verification.
  initialSocials: SocialRow[];
  // Same-origin path to return to after a successful verification —
  // set when the user arrived here from a gate (Gating Phase 1).
  // null = stay on /me/edit. Validated server-side in the page.
  returnTo?: string | null;
};

const platformLabel = PLATFORM_LABEL;
const bioWordFor = PLATFORM_BIO_LABEL;

export default function VerifySocialsCard({
  initialSocials,
  returnTo = null,
}: Props) {
  const [socials, setSocials] = useState<SocialRow[]>(initialSocials);
  const router = useRouter();
  const searchParams = useSearchParams();

  async function refresh(): Promise<void> {
    const res = await fetch("/api/me/socials", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { socials: SocialRow[] };
    setSocials(json.socials ?? []);
  }

  // Called only on an actual verification success (not on visibility
  // toggles). When the user came from a gate, send them back so they
  // can re-take the action they were blocked on.
  function handleVerified(): void {
    if (returnTo) router.push(returnTo);
  }

  // Prefill from URL query params (Block 2.5 → 2.5.1 follow-up).
  // /me's "Edits to claim" CTA sends users here with
  // ?platform=X&handle=Y so the right platform row auto-expands with
  // the handle filled in. Skip silently when:
  //   - either param missing
  //   - platform isn't in the allowed list
  //   - the user already has a verified or pending row for that
  //     platform (don't clobber active state)
  // Compute once from initialSocials (not the reactive `socials`) so
  // a successful verify mid-page-life doesn't re-trigger the prefill.
  const paramPlatform = searchParams.get("platform");
  const paramHandle = searchParams.get("handle");
  const prefillForPlatform: SocialPlatform | null = (() => {
    if (!paramPlatform || !paramHandle) return null;
    if (
      !ALLOWED_SOCIAL_PLATFORMS.includes(paramPlatform as SocialPlatform)
    ) {
      return null;
    }
    const existing = initialSocials.find((s) => s.platform === paramPlatform);
    if (existing?.verified_at) return null;
    if (existing?.verification_code) return null;
    return paramPlatform as SocialPlatform;
  })();
  let decodedHandle: string | null = null;
  if (prefillForPlatform && paramHandle) {
    try {
      decodedHandle = decodeURIComponent(paramHandle);
    } catch {
      decodedHandle = null;
    }
  }

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-moonbeem-black/60 p-6">
      <h2 className="m-0 font-wordmark text-heading-md text-moonbeem-ink">
        Verify your social accounts
      </h2>
      <p className="mt-1 text-body-sm text-moonbeem-ink-subtle">
        Prove you own a handle by adding a short code to your bio. Verifying
        also claims any fan edits we&apos;ve already attributed to that
        handle.
      </p>
      <div className="mt-5 flex flex-col gap-4">
        {ALLOWED_SOCIAL_PLATFORMS.map((p) => {
          const row = socials.find((s) => s.platform === p) ?? null;
          return (
            <PlatformRow
              key={p}
              platform={p}
              row={row}
              onChange={refresh}
              onVerified={handleVerified}
              prefillHandle={
                prefillForPlatform === p ? decodedHandle : null
              }
            />
          );
        })}
      </div>
    </div>
  );
}

type PlatformRowProps = {
  platform: SocialPlatform;
  row: SocialRow | null;
  onChange: () => Promise<void>;
  onVerified: () => void;
  // When non-null AND this row has no pending/verified state, the
  // parent decided to prefill the handle input on mount + scroll
  // this row into view. Computed in VerifySocialsCard from URL
  // params; nullable here so per-row decoupling stays clean.
  prefillHandle?: string | null;
};

function PlatformRow({
  platform,
  row,
  onChange,
  onVerified,
  prefillHandle = null,
}: PlatformRowProps) {
  const verified = !!row?.verified_at;
  // Seed the input from the URL prefill on first render. Subsequent
  // edits replace it normally — we don't keep "prefilled" as a
  // separate state because there's no UX difference once the user
  // sees the value.
  const [handleInput, setHandleInput] = useState(prefillHandle ?? "");
  const rowRef = useRef<HTMLDivElement | null>(null);
  const didScrollRef = useRef(false);

  // Smooth-scroll the prefilled row into view once on mount. Guarded
  // by a ref so re-renders (e.g. visibility toggles, pending-state
  // changes) don't keep yanking the page.
  useEffect(() => {
    if (!prefillHandle || didScrollRef.current) return;
    didScrollRef.current = true;
    rowRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [prefillHandle]);
  // Pending code state lives in-component (not persisted to DB-as-
  // user). On page refresh, pending state is lost; user re-starts.
  // Documented v1 tradeoff.
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [pendingHandle, setPendingHandle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Optimistic visibility — server is source of truth on refresh.
  const [displayOn, setDisplayOn] = useState<boolean>(
    row?.display_on_profile !== false,
  );
  const [visBusy, setVisBusy] = useState(false);

  async function toggleVisibility(next: boolean) {
    if (visBusy) return;
    setVisBusy(true);
    setDisplayOn(next);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/me/socials/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, display_on_profile: next }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setDisplayOn(!next);
        setErrorMsg(humanizeError(json.error) ?? "Couldn't save visibility.");
        return;
      }
      // Refresh so any other consumers (e.g. /c/[handle] preview)
      // see the latest state.
      await onChange();
    } catch (err) {
      setDisplayOn(!next);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setVisBusy(false);
    }
  }

  async function start() {
    if (!handleInput.trim() || busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/me/socials/verify/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, handle: handleInput }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        verification_code?: string;
        handle?: string;
        error?: string;
      };
      if (!res.ok) {
        setErrorMsg(humanizeError(json.error) ?? null);
        return;
      }
      setPendingCode(json.verification_code ?? null);
      setPendingHandle(json.handle ?? handleInput);
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (!pendingHandle || busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/me/socials/verify/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, handle: pendingHandle }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        verified?: boolean;
        error?: string;
      };
      if (!res.ok || !json.verified) {
        setErrorMsg(humanizeError(json.error) ?? "Verification failed.");
        return;
      }
      setPendingCode(null);
      setPendingHandle(null);
      setHandleInput("");
      await onChange();
      // Verification succeeded — if the user arrived from a gate,
      // this returns them to where they were.
      onVerified();
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!pendingCode) return;
    try {
      await navigator.clipboard.writeText(pendingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Some browsers refuse clipboard without user gesture; ignore.
    }
  }

  return (
    <div
      ref={rowRef}
      className="rounded-lg border border-white/10 bg-white/[0.02] p-4"
    >
      <div className="flex items-center gap-2">
        <PlatformIcon
          platform={platform}
          className="h-4 w-4 text-moonbeem-ink"
        />
        <span className="text-body font-medium text-moonbeem-ink">
          {platformLabel[platform]}
        </span>
        {verified && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-caption text-emerald-300">
            <span aria-hidden="true">✓</span>
            Verified
          </span>
        )}
      </div>

      {verified && row?.handle && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <a
            href={buildSocialProfileUrl(platform, row.handle)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            @{row.handle}
          </a>
          <label className="ml-auto flex items-center gap-2 text-caption text-moonbeem-ink-subtle">
            <span>Show on profile</span>
            <button
              type="button"
              onClick={() => toggleVisibility(!displayOn)}
              disabled={visBusy}
              aria-pressed={displayOn}
              aria-label="Toggle public visibility"
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                displayOn ? "bg-moonbeem-pink" : "bg-white/15"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  displayOn ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
        </div>
      )}

      {!verified && pendingCode && pendingHandle && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-body-sm text-moonbeem-ink">
            Verifying as{" "}
            <span className="text-moonbeem-pink">@{pendingHandle}</span>
          </p>
          <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/40 px-3 py-2">
            <code className="flex-1 select-all font-mono text-body text-moonbeem-ink">
              {pendingCode}
            </code>
            <button
              type="button"
              onClick={copyCode}
              className="rounded-md px-2 py-1 text-caption text-moonbeem-ink-subtle hover:text-moonbeem-ink"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-body-sm text-moonbeem-ink-subtle">
            Paste this code anywhere in your {bioWordFor[platform]}, save,
            then click below.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={check}
              disabled={busy}
              className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Checking…" : "I added it, check now"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingCode(null);
                setPendingHandle(null);
                setErrorMsg(null);
              }}
              className="text-body-sm text-moonbeem-ink-subtle hover:text-moonbeem-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!verified && !pendingCode && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-body-sm text-moonbeem-ink-subtle">@</span>
          <input
            type="text"
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value)}
            placeholder="your_handle"
            spellCheck={false}
            autoCapitalize="off"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
          />
          <button
            type="button"
            onClick={start}
            disabled={busy || !handleInput.trim()}
            className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate code"}
          </button>
        </div>
      )}

      {errorMsg && (
        <p className="mt-3 text-body-sm text-moonbeem-magenta">{errorMsg}</p>
      )}
    </div>
  );
}

function humanizeError(code: string | undefined): string | null {
  if (!code) return null;
  if (code === "no_creator") {
    return "Claim a Moonbeem handle first (we'll make this seamless soon).";
  }
  if (code === "code_not_found_in_bio") {
    return "Code not found in bio. Make sure you saved your profile, then try again.";
  }
  if (code === "no_active_verification") {
    return "No active verification — generate a code first.";
  }
  if (code === "verification_expired") {
    return "Code expired. Generate a new one.";
  }
  if (code === "invalid_handle") return "Handle doesn't look right.";
  if (code === "invalid_platform") return "Platform not supported.";
  if (code === "handle_not_found") {
    return "We couldn't find that handle. Double-check the spelling.";
  }
  if (code === "bio_empty") {
    return "Your bio looks empty. Add the code anywhere in your bio, save, then try again.";
  }
  if (code === "rate_limited") {
    return "Too many requests right now. Try again in a minute.";
  }
  if (code === "platform_unavailable") {
    return "Couldn't reach the platform. Try again in a moment.";
  }
  if (code === "shape_mismatch") {
    return "Couldn't read the bio (Moonbeem-side hiccup). We've logged it; please reach out if it persists.";
  }
  if (code === "token_missing") {
    return "Server misconfigured. We've logged it.";
  }
  return code;
}
