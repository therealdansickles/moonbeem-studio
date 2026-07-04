"use client";

// Per-Mux-episode subtitle management: list tracks, upload a VTT/SRT (validated
// client-side, presigned direct to R2, attached via Mux createTrack), delete.
// Silent by default: if no track exists, the player shows no CC menu — this card is
// authoring-only. SDH is an explicit accessibility checkbox, default off.

import { useEffect, useRef, useState } from "react";
import { validateSubtitle } from "@/lib/subtitles/validate";

type Track = {
  id: string;
  language_code: string;
  label: string | null;
  mux_track_id: string | null;
  closed_captions: boolean;
  status: string;
  error: string | null;
};

const LANGS: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "ar", name: "Arabic" },
  { code: "hi", name: "Hindi" },
  { code: "ru", name: "Russian" },
];
const MAX_BYTES = 2 * 1024 * 1024; // subtitle files are tiny

function statusLabel(s: string): { text: string; cls: string } {
  if (s === "ready") return { text: "ready", cls: "text-moonbeem-lime" };
  if (s === "errored") return { text: "failed", cls: "text-moonbeem-magenta" };
  return { text: "processing", cls: "text-moonbeem-ink-subtle" };
}

export default function SubtitlesCard({
  titleId,
  episodeId,
  episodeLabel,
}: {
  titleId: string;
  episodeId: string;
  episodeLabel: string;
}) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [lang, setLang] = useState("en");
  const [sdh, setSdh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const base = `/api/titles/${titleId}/episodes/${episodeId}/subtitles`;

  async function load() {
    const res = await fetch(base);
    const j = await res.json().catch(() => ({}));
    if (res.ok) setTracks(j.tracks ?? []);
    setLoading(false);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setMsg(null);
    const lower = file.name.toLowerCase();
    const ext = lower.endsWith(".vtt") ? "vtt" : lower.endsWith(".srt") ? "srt" : null;
    if (!ext) {
      setMsg("Choose a .vtt or .srt file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setMsg("That file is too large for a subtitle track.");
      return;
    }
    const text = await file.text();
    const v = validateSubtitle(text);
    if (!v.ok) {
      setMsg(v.error);
      return;
    }
    setBusy(true);
    try {
      const pres = await fetch(`${base}/presign?ext=${ext}&lang=${encodeURIComponent(lang)}`);
      const pj = await pres.json().catch(() => ({}));
      if (!pres.ok) {
        setMsg(pj.error ?? "Could not start the upload.");
        return;
      }
      const put = await fetch(pj.url, {
        method: "PUT",
        headers: { "Content-Type": pj.contentType, "Content-Disposition": pj.contentDisposition },
        body: text,
      });
      if (!put.ok) {
        setMsg(`Upload failed (${put.status}).`);
        return;
      }
      const att = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: pj.key,
          language_code: lang,
          label: LANGS.find((l) => l.code === lang)?.name ?? lang,
          closed_captions: sdh,
        }),
      });
      const aj = await att.json().catch(() => ({}));
      if (!att.ok) {
        setMsg(aj.detail ? `Mux rejected the track: ${aj.detail}` : (aj.error ?? "Could not attach the track."));
        return;
      }
      setSdh(false);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function del(trackId: string) {
    if (deletingId) return;
    setDeletingId(trackId);
    setMsg(null);
    try {
      const res = await fetch(`${base}/${trackId}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setMsg(j.detail ?? j.error ?? "Could not delete the track.");
        return;
      }
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <p className="m-0 text-body-sm font-medium text-moonbeem-ink">
        Subtitles — {episodeLabel}
      </p>

      {loading ? (
        <p className="mt-2 text-caption text-moonbeem-ink-subtle">Loading tracks…</p>
      ) : tracks.length === 0 ? (
        <p className="mt-2 text-caption text-moonbeem-ink-subtle">
          No subtitle tracks. Optional — the player shows no captions menu without one.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-white/5">
          {tracks.map((t) => {
            const st = statusLabel(t.status);
            return (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-body-sm text-moonbeem-ink">
                  {t.label ?? t.language_code}
                  <span className="ml-2 text-caption text-moonbeem-ink-subtle">{t.language_code}</span>
                  {t.closed_captions && (
                    <span className="ml-2 rounded-full bg-white/10 px-2 py-0.5 text-caption text-moonbeem-ink-subtle">
                      SDH
                    </span>
                  )}
                  <span className={`ml-2 text-caption ${st.cls}`}>{st.text}</span>
                  {t.status === "errored" && t.error && (
                    <span className="ml-2 text-caption text-moonbeem-magenta">{t.error}</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => del(t.id)}
                  disabled={deletingId === t.id}
                  className="shrink-0 rounded-md border border-white/15 px-3 py-1 text-caption text-moonbeem-ink-muted hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-40"
                >
                  {deletingId === t.id ? "Deleting…" : "Delete"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-caption uppercase tracking-wider text-moonbeem-ink-subtle">Language</span>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink"
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-body-sm text-moonbeem-ink-muted">
          <input type="checkbox" checked={sdh} onChange={(e) => setSdh(e.target.checked)} />
          SDH (for the deaf and hard of hearing)
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".vtt,.srt,text/vtt,application/x-subrip"
          disabled={busy}
          onChange={(e) => onFile(e.target.files?.[0])}
          className="text-body-sm text-moonbeem-ink-muted file:mr-3 file:rounded-md file:border file:border-moonbeem-pink/40 file:bg-moonbeem-pink/10 file:px-3 file:py-1.5 file:text-body-sm file:text-moonbeem-pink disabled:opacity-40"
        />
      </div>
      {busy && <p className="mt-2 text-caption text-moonbeem-ink-subtle">Uploading and attaching…</p>}
      {msg && <p className="mt-2 text-caption text-moonbeem-magenta">{msg}</p>}
    </div>
  );
}
