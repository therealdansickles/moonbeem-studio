"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Partner = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
};

type TitleHit = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  partner_id: string | null;
  is_active: boolean;
  is_public: boolean;
};

type Mode = "pick-existing" | "create-new";

type Props = { onClose: () => void };

const SEARCH_DEBOUNCE_MS = 300;

// "Topic Studios" → "topic-studios". Conservative: keeps only
// alphanumerics + hyphens, collapses repeats, trims leading/trailing.
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export default function AttachTitleModal({ onClose }: Props) {
  const router = useRouter();

  // Title search state
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TitleHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<TitleHit | null>(null);

  // Partner state
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const [partnersErr, setPartnersErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("pick-existing");
  const [partnerId, setPartnerId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newSlugTouched, setNewSlugTouched] = useState(false);
  const [newLogoUrl, setNewLogoUrl] = useState("");

  // Flags + submit state
  const [isActive, setIsActive] = useState(true);
  const [isPublic, setIsPublic] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // Esc-to-close + focus the search field on open.
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    searchInputRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Load partners once.
  useEffect(() => {
    let alive = true;
    fetch("/api/admin/partners")
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (Array.isArray(j.partners)) setPartners(j.partners);
        else setPartnersErr(j.error ?? "load_failed");
      })
      .catch((e) => alive && setPartnersErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // Debounced title search.
  useEffect(() => {
    if (selected) return; // freeze search once a title is picked
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      setSearchErr(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/titles/search?q=${encodeURIComponent(q)}`,
        );
        const j = await res.json();
        if (!res.ok) {
          setSearchErr(j.error ?? `search ${res.status}`);
          setHits([]);
        } else {
          setSearchErr(null);
          setHits(j.results ?? []);
        }
      } catch (e) {
        setSearchErr(String(e));
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, selected]);

  // Auto-suggest the slug as the user types the partner name (until
  // they manually edit the slug input, which sets touched=true).
  useEffect(() => {
    if (!newSlugTouched) setNewSlug(suggestSlug(newName));
  }, [newName, newSlugTouched]);

  // Sanity gating.
  function activeReady(): boolean {
    if (!selected) return false;
    if (mode === "pick-existing") return !!partnerId;
    return newName.trim().length > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newSlug);
  }

  async function submit() {
    if (!selected || submitting) return;
    if (!activeReady()) return;
    setSubmitting(true);
    setSubmitErr(null);

    const payload: Record<string, unknown> = {
      title_id: selected.id,
      is_active: isActive,
      is_public: isPublic,
    };
    if (mode === "pick-existing") {
      payload.partner_id = partnerId;
    } else {
      payload.new_partner = {
        name: newName.trim(),
        slug: newSlug.trim(),
        logo_url: newLogoUrl.trim() || null,
      };
    }

    try {
      const res = await fetch("/api/admin/titles/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        title?: TitleHit;
        error?: string;
      };
      if (!res.ok || !j.ok || !j.title) {
        setSubmitErr(j.error ?? `request failed (${res.status})`);
        return;
      }
      // Success — navigate to the title detail page so the user
      // lands on the operational hub for the title they just attached.
      router.push(`/admin/titles/${j.title.slug}`);
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4 pt-12"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-moonbeem-black p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 font-wordmark text-heading-md text-moonbeem-pink">
              Activate new title
            </h2>
            <p className="mt-1 text-caption text-moonbeem-ink-subtle">
              Attribute a catalog title to a partner. Active by default;
              keep Public off until the title is ready to launch.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/10 px-2 py-1 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* STEP 1 — pick title */}
        <section className="mt-6 flex flex-col gap-3">
          <label className="text-body-sm font-medium text-moonbeem-ink">
            Title
          </label>
          {selected ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-moonbeem-pink/30 bg-moonbeem-pink/5 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-body-sm text-moonbeem-ink">
                  {selected.title}
                  {selected.year && (
                    <span className="ml-2 text-moonbeem-ink-subtle">
                      ({selected.year})
                    </span>
                  )}
                </div>
                <div className="font-mono text-caption text-moonbeem-ink-subtle">
                  /t/{selected.slug}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setQuery("");
                }}
                className="text-caption text-moonbeem-ink-muted hover:text-moonbeem-pink"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the catalog… (min 2 chars)"
                className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
              />
              {searchErr && (
                <p className="text-caption text-moonbeem-magenta">
                  {searchErr}
                </p>
              )}
              <div className="max-h-72 overflow-y-auto rounded-lg border border-white/5 bg-black/30">
                {searching && (
                  <p className="p-3 text-caption text-moonbeem-ink-subtle">
                    Searching…
                  </p>
                )}
                {!searching && query.trim().length >= 2 && hits.length === 0 && (
                  <p className="p-3 text-caption text-moonbeem-ink-subtle">
                    No matches.
                  </p>
                )}
                {hits.map((h) => {
                  const attached = !!h.partner_id;
                  return (
                    <button
                      key={h.id}
                      type="button"
                      disabled={attached}
                      onClick={() => setSelected(h)}
                      className={`flex w-full items-center justify-between gap-3 border-b border-white/5 px-3 py-2 text-left last:border-b-0 transition-colors ${
                        attached
                          ? "cursor-not-allowed opacity-60"
                          : "hover:bg-moonbeem-pink/5"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-body-sm text-moonbeem-ink">
                          {h.title}
                          {h.year && (
                            <span className="ml-2 text-moonbeem-ink-subtle">
                              ({h.year})
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-caption text-moonbeem-ink-subtle">
                          /t/{h.slug}
                        </div>
                      </div>
                      {attached && (
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-caption text-moonbeem-ink-subtle">
                          already attached
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {/* STEP 2 — pick / create partner */}
        {selected && (
          <section className="mt-6 flex flex-col gap-3">
            <label className="text-body-sm font-medium text-moonbeem-ink">
              Partner
            </label>
            <div className="flex items-center gap-4 text-caption">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={mode === "pick-existing"}
                  onChange={() => setMode("pick-existing")}
                  className="accent-moonbeem-pink"
                />
                <span>Existing</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={mode === "create-new"}
                  onChange={() => setMode("create-new")}
                  className="accent-moonbeem-pink"
                />
                <span>Create new</span>
              </label>
            </div>

            {mode === "pick-existing" && (
              <>
                {partnersErr && (
                  <p className="text-caption text-moonbeem-magenta">
                    {partnersErr}
                  </p>
                )}
                <select
                  value={partnerId}
                  onChange={(e) => setPartnerId(e.target.value)}
                  className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
                >
                  <option value="">— select a partner —</option>
                  {(partners ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.slug})
                    </option>
                  ))}
                </select>
              </>
            )}

            {mode === "create-new" && (
              <div className="flex flex-col gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-4">
                <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
                  Name
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Roadside Attractions"
                    className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
                  Slug
                  <input
                    type="text"
                    value={newSlug}
                    onChange={(e) => {
                      setNewSlug(e.target.value);
                      setNewSlugTouched(true);
                    }}
                    placeholder="roadside-attractions"
                    className="rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
                  />
                  <span className="text-caption text-moonbeem-ink-subtle">
                    Lower-case, hyphens only. URL becomes /p/{newSlug || "<slug>"}.
                  </span>
                </label>
                <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
                  Logo URL (optional)
                  <input
                    type="url"
                    value={newLogoUrl}
                    onChange={(e) => setNewLogoUrl(e.target.value)}
                    placeholder="https://…"
                    className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
                  />
                </label>
              </div>
            )}
          </section>
        )}

        {/* STEP 3 — initial flags */}
        {selected && (
          <section className="mt-6 flex flex-col gap-3">
            <label className="text-body-sm font-medium text-moonbeem-ink">
              Initial state
            </label>
            <div className="flex flex-wrap items-center gap-6 text-body-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => {
                    setIsActive(e.target.checked);
                    if (!e.target.checked) setIsPublic(false);
                  }}
                  className="accent-moonbeem-pink"
                />
                <span className="text-moonbeem-ink">Active</span>
                <span className="text-caption text-moonbeem-ink-subtle">
                  (CPM payouts, partner dashboard, view tracking)
                </span>
              </label>
              <label
                className={`flex items-center gap-2 ${
                  isActive ? "" : "opacity-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isPublic}
                  disabled={!isActive}
                  onChange={(e) => setIsPublic(e.target.checked)}
                  className="accent-moonbeem-pink"
                />
                <span className="text-moonbeem-ink">Public</span>
                <span className="text-caption text-moonbeem-ink-subtle">
                  (anonymous /t/{selected.slug} renders)
                </span>
              </label>
            </div>
          </section>
        )}

        {/* Submit */}
        {selected && (
          <div className="mt-8 flex items-center justify-end gap-3">
            {submitErr && (
              <p className="mr-auto text-caption text-moonbeem-magenta">
                {submitErr}
              </p>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!activeReady() || submitting}
              className="rounded-md bg-moonbeem-pink px-5 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Attaching…" : "Attach to partner"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
