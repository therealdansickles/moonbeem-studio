"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProfileLink } from "@/lib/queries/profiles";
import AvatarUploader from "./AvatarUploader";

type Props = {
  handle: string;
  initialDisplayName: string;
  initialBio: string;
  initialAvatarUrl: string | null;
  initialLinks: ProfileLink[];
};

const MAX_DISPLAY_NAME = 50;
const MAX_BIO = 200;
const MAX_LINKS = 5;

export default function EditProfileForm({
  handle,
  initialDisplayName,
  initialBio,
  initialAvatarUrl,
  initialLinks,
}: Props) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [bio, setBio] = useState(initialBio);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialAvatarUrl);
  const [links, setLinks] = useState<ProfileLink[]>(initialLinks);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function updateLink(idx: number, patch: Partial<ProfileLink>) {
    setLinks((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    );
  }

  function removeLink(idx: number) {
    setLinks((prev) => prev.filter((_, i) => i !== idx));
  }

  function addLink() {
    if (links.length >= MAX_LINKS) return;
    setLinks((prev) => [...prev, { label: "", url: "" }]);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const cleanedLinks = links
        .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
        .filter((l) => l.label && l.url);

      const res = await fetch("/api/profile/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName.trim(),
          bio,
          avatar_url: avatarUrl,
          links: cleanedLinks,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? `update ${res.status}`);
        setSubmitting(false);
        return;
      }
      router.replace(`/c/${handle}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="font-wordmark text-heading-lg text-moonbeem-ink m-0">
          Edit profile
        </h1>
        <p className="text-body-sm text-moonbeem-ink-subtle">@{handle}</p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <AvatarUploader
          handle={handle}
          displayName={displayName.trim() || null}
          currentUrl={avatarUrl}
          onUploaded={(url) => setAvatarUrl(url)}
        />

        <label className="flex flex-col gap-1">
          <span className="text-body-sm text-moonbeem-ink-muted">
            Display name
          </span>
          <input
            type="text"
            value={displayName}
            onChange={(e) =>
              setDisplayName(e.target.value.slice(0, MAX_DISPLAY_NAME))
            }
            placeholder="Your name"
            maxLength={MAX_DISPLAY_NAME}
            className="rounded-md border border-moonbeem-border-strong bg-transparent px-4 py-3 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
          />
          <span className="text-caption text-moonbeem-ink-subtle">
            {displayName.length} / {MAX_DISPLAY_NAME}
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-body-sm text-moonbeem-ink-muted">Bio</span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value.slice(0, MAX_BIO))}
            placeholder="A short bio."
            rows={3}
            maxLength={MAX_BIO}
            className="rounded-md border border-moonbeem-border-strong bg-transparent px-4 py-3 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
          />
          <span className="text-caption text-moonbeem-ink-subtle">
            {bio.length} / {MAX_BIO}
          </span>
        </label>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-body-sm text-moonbeem-ink-muted mb-1">
            Links
          </legend>
          {links.length === 0 && (
            <p className="text-caption text-moonbeem-ink-subtle">
              No links yet.
            </p>
          )}
          {links.map((link, idx) => (
            <div key={idx} className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={link.label}
                onChange={(e) => updateLink(idx, { label: e.target.value })}
                placeholder="Label (e.g. Twitter)"
                maxLength={30}
                className="w-full sm:w-40 rounded-md border border-moonbeem-border-strong bg-transparent px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
              />
              <input
                type="url"
                value={link.url}
                onChange={(e) => updateLink(idx, { url: e.target.value })}
                placeholder="https://"
                maxLength={200}
                className="flex-1 rounded-md border border-moonbeem-border-strong bg-transparent px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
              />
              <button
                type="button"
                onClick={() => removeLink(idx)}
                className="self-start rounded-md border border-white/10 bg-white/5 px-3 py-2 text-caption text-moonbeem-ink-muted hover:border-moonbeem-magenta hover:text-moonbeem-magenta"
              >
                Remove
              </button>
            </div>
          ))}
          {links.length < MAX_LINKS && (
            <button
              type="button"
              onClick={addLink}
              className="self-start rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink hover:border-moonbeem-pink hover:text-moonbeem-pink"
            >
              + Add link
            </button>
          )}
        </fieldset>

        {error && <p className="text-body-sm text-moonbeem-magenta">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-moonbeem-pink px-5 py-3 text-body font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            disabled={submitting}
            className="rounded-md border border-white/15 bg-transparent px-5 py-3 text-body text-moonbeem-ink hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
