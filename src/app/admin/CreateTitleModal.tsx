"use client";

// Manually create a non-TMDB title (film/series) and attach it to a
// partner in one step. Patterned on AttachTitleModal — same partner
// picker (existing / inline-create) and the same is_active/is_public/
// is_featured controls — but instead of searching the catalog it takes
// title metadata and POSTs to /api/admin/titles (which INSERTs the row).
// media_type is restricted to movie/tv here, matching the endpoint's
// tier-3 guard.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PartnerLogoUploader from "@/components/admin/PartnerLogoUploader";
import { fetchJson, FetchJsonError, RateLimitedError } from "@/lib/fetch-json";

type Partner = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
};

type Mode = "pick-existing" | "create-new";
type Props = { onClose: () => void };

// "Last Tango in Park City" + 2026 → "last-tango-in-park-city-2026".
// Mirrors baseTitleSlug() in /api/admin/titles so the pre-fill matches
// what the server would generate.
function suggestTitleSlug(title: string, year: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const y = year.trim();
  return base && /^\d{4}$/.test(y) ? `${base}-${y}` : base;
}

// "Topic Studios" → "topic-studios" (partner slug suggester, same as attach).
function suggestPartnerSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function CreateTitleModal({ onClose }: Props) {
  const router = useRouter();

  // Title metadata
  const [title, setTitle] = useState("");
  const [mediaType, setMediaType] = useState<"movie" | "tv">("movie");
  const [year, setYear] = useState("");
  const [posterUrl, setPosterUrl] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  // Partner state (same shape as AttachTitleModal)
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const [partnersErr, setPartnersErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("pick-existing");
  const [partnerId, setPartnerId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newSlugTouched, setNewSlugTouched] = useState(false);
  const [newLogoKey, setNewLogoKey] = useState<string | null>(null);
  const [newLogoPreview, setNewLogoPreview] = useState<string | null>(null);

  // Flags — manual titles are created to launch, so public/active default on.
  const [isActive, setIsActive] = useState(true);
  const [isPublic, setIsPublic] = useState(true);
  const [isFeatured, setIsFeatured] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    titleInputRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  // Auto-suggest the title slug until the admin edits it.
  useEffect(() => {
    if (!slugTouched) setSlug(suggestTitleSlug(title, year));
  }, [title, year, slugTouched]);

  // Auto-suggest the new-partner slug until the admin edits it.
  useEffect(() => {
    if (!newSlugTouched) setNewSlug(suggestPartnerSlug(newName));
  }, [newName, newSlugTouched]);

  function partnerReady(): boolean {
    if (mode === "pick-existing") return !!partnerId;
    return newName.trim().length > 0 && SLUG_RE.test(newSlug);
  }
  function ready(): boolean {
    if (!title.trim()) return false;
    if (!SLUG_RE.test(slug)) return false;
    if (year.trim() && !/^\d{4}$/.test(year.trim())) return false;
    return partnerReady();
  }

  async function submit() {
    if (submitting || !ready()) return;
    setSubmitting(true);
    setSubmitErr(null);

    const payload: Record<string, unknown> = {
      title: title.trim(),
      media_type: mediaType,
      is_active: isActive,
      is_public: isPublic,
      is_featured: isFeatured,
    };
    if (year.trim()) payload.year = Number(year.trim());
    if (posterUrl.trim()) payload.poster_url = posterUrl.trim();
    if (synopsis.trim()) payload.synopsis = synopsis.trim();
    // Only send an explicit slug when the admin edited it; otherwise let
    // the server auto-generate + auto-disambiguate (-2, -3, …).
    if (slugTouched && slug.trim()) payload.slug = slug.trim();
    if (mode === "pick-existing") {
      payload.partner_id = partnerId;
    } else {
      const np: Record<string, unknown> = {
        name: newName.trim(),
        slug: newSlug.trim(),
      };
      if (newLogoKey) np.logo_key = newLogoKey;
      payload.new_partner = np;
    }

    try {
      const j = await fetchJson<{ ok?: boolean; title?: { slug: string } }>(
        "/api/admin/titles",
        { method: "POST", body: payload },
      );
      if (!j.ok || !j.title) {
        setSubmitErr("Create didn't complete. Try again.");
        return;
      }
      router.push(`/admin/titles/${j.title.slug}`);
    } catch (e) {
      setSubmitErr(
        e instanceof RateLimitedError || e instanceof FetchJsonError
          ? e.userMessage
          : e instanceof Error
            ? e.message
            : String(e),
      );
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
              Create a title
            </h2>
            <p className="mt-1 text-caption text-moonbeem-ink-subtle">
              For a film or series that isn&apos;t in the TMDB catalog. Public
              and Active by default so it&apos;s campaign-ready.
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

        {/* STEP 1 — title metadata */}
        <section className="mt-6 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-body-sm font-medium text-moonbeem-ink">
            Title
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Last Tango in Park City"
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
            />
          </label>

          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
              Type
              <select
                value={mediaType}
                onChange={(e) => setMediaType(e.target.value as "movie" | "tv")}
                className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
              >
                <option value="movie">Film (movie)</option>
                <option value="tv">Series (tv)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
              Year
              <input
                type="text"
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder="2026"
                className="w-24 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            Slug
            <input
              type="text"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder="last-tango-in-park-city-2026"
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            />
            <span className="text-caption text-moonbeem-ink-subtle">
              URL becomes /t/{slug || "<slug>"}. Auto-generated; edit to override
              (a collision returns 409). Lower-case, hyphens only.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            Poster URL (optional)
            <input
              type="text"
              value={posterUrl}
              onChange={(e) => setPosterUrl(e.target.value)}
              placeholder="https://…/poster.jpg"
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            Synopsis (optional)
            <textarea
              value={synopsis}
              onChange={(e) => setSynopsis(e.target.value)}
              rows={3}
              placeholder="One or two sentences…"
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
            />
          </label>
        </section>

        {/* STEP 2 — pick / create partner (same controls as AttachTitleModal) */}
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
                <p className="text-caption text-moonbeem-magenta">{partnersErr}</p>
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
              <div className="flex flex-col gap-2">
                <span className="text-caption text-moonbeem-ink-subtle">
                  Logo (optional)
                </span>
                <PartnerLogoUploader
                  partnerSlug={newSlug}
                  initialUrl={newLogoPreview}
                  onUploaded={({ key, previewUrl }) => {
                    setNewLogoKey(key);
                    setNewLogoPreview(previewUrl);
                  }}
                  onCleared={() => {
                    setNewLogoKey(null);
                    setNewLogoPreview(null);
                  }}
                />
              </div>
            </div>
          )}
        </section>

        {/* STEP 3 — initial flags (same controls as AttachTitleModal) */}
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
            <label className={`flex items-center gap-2 ${isActive ? "" : "opacity-50"}`}>
              <input
                type="checkbox"
                checked={isPublic}
                disabled={!isActive}
                onChange={(e) => setIsPublic(e.target.checked)}
                className="accent-moonbeem-pink"
              />
              <span className="text-moonbeem-ink">Public</span>
              <span className="text-caption text-moonbeem-ink-subtle">
                (anonymous /t/{slug || "<slug>"} renders)
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isFeatured}
                onChange={(e) => setIsFeatured(e.target.checked)}
                className="accent-moonbeem-pink"
              />
              <span className="text-moonbeem-ink">Add to Featured carousel</span>
              <span className="text-caption text-moonbeem-ink-subtle">
                (appears on homepage Featured row)
              </span>
            </label>
          </div>
        </section>

        {/* Submit */}
        <div className="mt-8 flex items-center justify-end gap-3">
          {submitErr && (
            <p className="mr-auto text-caption text-moonbeem-magenta">{submitErr}</p>
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
            disabled={!ready() || submitting}
            className="rounded-md bg-moonbeem-pink px-5 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create title"}
          </button>
        </div>
      </div>
    </div>
  );
}
