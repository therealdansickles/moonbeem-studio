"use client";

import { useState } from "react";
import {
  ALLOWED_SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "@/lib/socials/handle";
import PlatformIcon from "@/components/PlatformIcon";

type SocialRow = {
  platform: SocialPlatform;
  handle: string | null;
  verified_at: string | null;
  is_verified: boolean | null;
  verification_code: string | null;
  verification_started_at: string | null;
};

type Props = {
  // Pre-fetched on the server. The component refreshes via
  // /api/me/socials after each successful verification.
  initialSocials: SocialRow[];
};

const platformLabel: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
};

const bioWordFor: Record<SocialPlatform, string> = {
  tiktok: "TikTok bio",
  instagram: "Instagram bio",
  twitter: "X bio",
};

export default function VerifySocialsCard({ initialSocials }: Props) {
  const [socials, setSocials] = useState<SocialRow[]>(initialSocials);

  async function refresh(): Promise<void> {
    const res = await fetch("/api/me/socials", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { socials: SocialRow[] };
    setSocials(json.socials ?? []);
  }

  return (
    <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-moonbeem-black/60 p-6">
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
};

function PlatformRow({ platform, row, onChange }: PlatformRowProps) {
  const verified = !!row?.verified_at;
  const [handleInput, setHandleInput] = useState("");
  // Pending code state lives in-component (not persisted to DB-as-
  // user). On page refresh, pending state is lost; user re-starts.
  // Documented v1 tradeoff.
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [pendingHandle, setPendingHandle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
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
        <p className="mt-2 text-body-sm text-moonbeem-ink-muted">
          @{row.handle}
        </p>
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
  if (code.startsWith("bio_fetch_failed:")) {
    return "Couldn't read the bio from the platform. Try again in a moment.";
  }
  return code;
}
