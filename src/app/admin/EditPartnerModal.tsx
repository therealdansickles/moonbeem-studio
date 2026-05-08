"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Partner = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  title_count: number;
};

type Props = {
  partner: Partner;
  onClose: () => void;
};

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function EditPartnerModal({ partner, onClose }: Props) {
  const router = useRouter();
  const [name, setName] = useState(partner.name);
  const [slug, setSlug] = useState(partner.slug);
  const [logoUrl, setLogoUrl] = useState(partner.logo_url ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    nameRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const slugChanged = slug !== partner.slug;
  const slugValid = SLUG_RE.test(slug);
  const dirty =
    name.trim() !== partner.name ||
    slug !== partner.slug ||
    (logoUrl.trim() || null) !== (partner.logo_url ?? null);
  const canSave = dirty && name.trim().length > 0 && slugValid && !saving;
  const canDelete = partner.title_count === 0 && !deleting;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/partners/${partner.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim().toLowerCase(),
          logo_url: logoUrl.trim() || null,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setError(humanizeError(j.error) ?? `request failed (${res.status})`);
        return;
      }
      router.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function destroy() {
    if (!canDelete) return;
    const ok = window.confirm(
      `Delete partner "${partner.name}"?\n\nNo titles are attached, so this is safe. The partner row will be permanently removed.`,
    );
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/partners/${partner.id}`, {
        method: "DELETE",
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        title_count?: number;
      };
      if (!res.ok || !j.ok) {
        setError(humanizeError(j.error, j.title_count) ?? `request failed (${res.status})`);
        return;
      }
      router.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4 pt-12"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-moonbeem-black p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 font-wordmark text-heading-md text-moonbeem-pink">
              Edit partner
            </h2>
            <p className="mt-1 text-caption text-moonbeem-ink-subtle">
              {partner.title_count} {partner.title_count === 1 ? "title" : "titles"}{" "}
              attached
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-white/10 px-2 py-1 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            ✕
          </button>
        </div>

        <div className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            Name
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            Slug
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            />
            {slugChanged && (
              <span className="text-caption text-moonbeem-magenta">
                Changing the slug breaks any bookmarked /p/{partner.slug}
                {" "}URLs. New URL: /p/{slug || "<slug>"}.
              </span>
            )}
            {!slugValid && slug && (
              <span className="text-caption text-moonbeem-magenta">
                Slug must be lowercase letters, digits, and hyphens.
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
            Logo URL (optional)
            <input
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://…"
              className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
            />
          </label>
        </div>

        {error && (
          <p className="mt-4 text-caption text-moonbeem-magenta">{error}</p>
        )}

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={destroy}
            disabled={!canDelete}
            title={
              canDelete
                ? "Delete this partner"
                : "Detach all titles before deleting"
            }
            className="rounded-md border border-moonbeem-magenta/40 px-3 py-2 text-caption text-moonbeem-magenta hover:bg-moonbeem-magenta/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {deleting ? "Deleting…" : "Delete partner"}
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              className="rounded-md bg-moonbeem-pink px-5 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function humanizeError(code?: string, titleCount?: number): string | null {
  if (!code) return null;
  if (code === "slug_taken") return "That slug is already in use.";
  if (code === "name_required") return "Name can't be empty.";
  if (code === "invalid_slug") {
    return "Slug must be lowercase letters, digits, and hyphens.";
  }
  if (code === "titles_attached") {
    return `Detach the ${titleCount ?? "attached"} title${
      titleCount === 1 ? "" : "s"
    } first, then delete.`;
  }
  if (code === "partner_not_found") return "Partner no longer exists.";
  return code;
}
