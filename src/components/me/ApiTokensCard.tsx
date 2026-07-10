"use client";

// API-token management for creators (Stage 2 UI). Self-contained: fetches its own
// list, handles its own create/reveal-once/revoke state, so it is portable if the
// settings layout changes. Wires to the Stage-1 CRUD routes (/api/me/api-tokens).
//
// Content-only: this component never touches money. It does NOT offer scope
// selection — scopes default server-side to the content-only set; the UI sends a
// name only.
//
// Chrome + the reveal/copy affordance are modeled on VerifySocialsCard (the
// codebase's create -> reveal-once -> copy -> list -> manage precedent): the raw
// secret is shown exactly once in a <code className="select-all font-mono"> box
// with a Copy button, lives in component state only, and is gone on refresh.

import { useEffect, useState } from "react";

type ApiTokenRow = {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
};

function formatDate(value: string | null): string {
  if (!value) return "never";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "never";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ApiTokensCard() {
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The raw token, shown EXACTLY ONCE after creation. Component state only —
  // never refetched, never persisted; cleared on dismiss or refresh.
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const res = await fetch("/api/me/api-tokens", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { api_tokens?: ApiTokenRow[] };
    setTokens(json.api_tokens ?? []);
  }

  useEffect(() => {
    void (async () => {
      await refresh();
      setLoading(false);
    })();
  }, []);

  async function createToken() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/me/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        token?: string;
        error?: string;
      };
      if (!res.ok || !json.token) {
        setError(json.error ?? `create ${res.status}`);
        return;
      }
      setRawToken(json.token);
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function copyToken() {
    if (!rawToken) return;
    try {
      await navigator.clipboard.writeText(rawToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Some browsers refuse clipboard without a user gesture; ignore.
    }
  }

  async function revokeToken(id: string) {
    if (revokingId) return;
    if (!window.confirm("Revoke this token? Any tool using it will stop working.")) {
      return;
    }
    setRevokingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/me/api-tokens/${id}`, { method: "PATCH" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? `revoke ${res.status}`);
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-moonbeem-black/60 p-6">
      <h2 className="m-0 font-wordmark text-heading-md text-moonbeem-ink">
        API tokens
      </h2>
      <p className="mt-1 text-body-sm text-moonbeem-ink-subtle">
        API tokens let approved tools, like the Moonbeem panel for Premiere,
        access your permissioned clips on your behalf. Generate one below, then
        paste it into the panel&apos;s sign-in field in Premiere Pro to connect.
      </p>

      {/* Create */}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 80))}
          placeholder="Token name (e.g. My Premiere panel)"
          maxLength={80}
          className="flex-1 rounded-md border border-moonbeem-border-strong bg-transparent px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
        />
        <button
          type="button"
          onClick={createToken}
          disabled={creating || !name.trim()}
          className="shrink-0 rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? "Generating…" : "Generate token"}
        </button>
      </div>

      {error && (
        <p className="mt-3 text-body-sm text-moonbeem-magenta">{error}</p>
      )}

      {/* Reveal-once: the raw token, shown only here, never again */}
      {rawToken && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-moonbeem-pink/40 bg-moonbeem-pink/5 p-4">
          <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/40 px-3 py-2">
            <code className="flex-1 select-all break-all font-mono text-body-sm text-moonbeem-ink">
              {rawToken}
            </code>
            <button
              type="button"
              onClick={copyToken}
              className="shrink-0 rounded-md px-2 py-1 text-caption text-moonbeem-ink-subtle hover:text-moonbeem-ink"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-body-sm text-moonbeem-ink">
            Copy this token now and store it somewhere safe, like a password
            manager. You won&apos;t be able to see it again. If you lose it,
            revoke it and generate a new one.
          </p>
          <button
            type="button"
            onClick={() => setRawToken(null)}
            className="self-start rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            Done
          </button>
        </div>
      )}

      {/* List */}
      <div className="mt-6 flex flex-col gap-2">
        {loading ? (
          <p className="text-body-sm text-moonbeem-ink-subtle">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-body-sm text-moonbeem-ink-subtle">
            You have no API tokens yet. Generate one above to connect an approved
            tool.
          </p>
        ) : (
          tokens.map((t) => {
            const revoked = !!t.revoked_at;
            return (
              <div
                key={t.id}
                className={`flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-4 sm:flex-row sm:items-center sm:justify-between ${
                  revoked ? "opacity-50" : ""
                }`}
              >
                <div className="min-w-0">
                  <p className="m-0 truncate text-body-sm text-moonbeem-ink">
                    {t.name}
                    {revoked && (
                      <span className="ml-2 text-caption text-moonbeem-ink-subtle">
                        revoked
                      </span>
                    )}
                  </p>
                  <p className="m-0 mt-0.5 font-mono text-caption text-moonbeem-ink-subtle">
                    {t.token_prefix}
                  </p>
                  <p className="m-0 mt-1 text-caption text-moonbeem-ink-subtle">
                    {t.scopes.join(", ")} · created {formatDate(t.created_at)} ·
                    last used{" "}
                    {t.last_used_at ? formatDate(t.last_used_at) : "never"}
                  </p>
                </div>
                {!revoked && (
                  <button
                    type="button"
                    onClick={() => revokeToken(t.id)}
                    disabled={revokingId === t.id}
                    className="shrink-0 self-start rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-caption text-moonbeem-ink-muted hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-50 sm:self-center"
                  >
                    {revokingId === t.id ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
