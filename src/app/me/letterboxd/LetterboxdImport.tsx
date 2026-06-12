"use client";

// Phase 2B import surface: upload a Letterboxd export ZIP -> presign -> PUT ->
// create job -> poll (2s) -> render the preview. NO apply: the Apply button is
// disabled and labeled as the next step (Phase 2C). Re-upload starts a new job.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

const MAX_BYTES = 25 * 1024 * 1024;

type CategoryStats = {
  total: number;
  matched_exact: number;
  matched_fuzzy: number;
  matched_live: number;
  matched_catalog: number;
  unmatched: number;
  already_imported: number;
};
type FuzzyPair = {
  category: string;
  input_name: string;
  input_year: number | null;
  matched_name: string | null;
  matched_year: number | null;
  matched_slug: string | null;
  matched_is_public: boolean;
};
type UnmatchedRef = { category: string; name: string; year: number | null };
type ListPreview = {
  name: string | null;
  item_total: number;
  matched_exact: number;
  matched_fuzzy: number;
  unmatched: number;
  already_imported: number;
  already_imported_list: boolean;
};
type Warning = { category: string; row: number; message: string };
type ImportPreview = {
  categories: {
    ratings: CategoryStats;
    diary: CategoryStats;
    reviews: CategoryStats;
    watchlist: CategoryStats;
    lists: CategoryStats;
  };
  lists: ListPreview[];
  fuzzy_pairs: FuzzyPair[];
  unmatched: UnmatchedRef[];
  fuzzy_truncated: number;
  unmatched_truncated: number;
  skipped: { watched: number; likes: number; comments: number; profile: number };
  warnings: Warning[];
};

type Phase =
  | "idle"
  | "uploading"
  | "analyzing"
  | "ready"
  | "applying"
  | "applied"
  | "failed";

type AppliedCategory = { attempted: number; inserted: number; skipped: number };
type AppliedCounts = {
  ratings: AppliedCategory;
  diary: AppliedCategory;
  lists: AppliedCategory;
  list_items: AppliedCategory;
};

const CATEGORY_ORDER: Array<{ key: keyof ImportPreview["categories"]; label: string }> = [
  { key: "ratings", label: "Ratings" },
  { key: "diary", label: "Diary" },
  { key: "reviews", label: "Reviews" },
  { key: "watchlist", label: "Watchlist" },
  { key: "lists", label: "List films" },
];

export default function LetterboxdImport() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusText, setStatusText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [applied, setApplied] = useState<AppliedCounts | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set on unmount so an in-flight poll fetch that resolves after teardown does
  // not schedule another tick or setState on the unmounted component.
  const cancelledRef = useRef(false);

  const reset = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
    setPhase("idle");
    setStatusText("");
    setError(null);
    setPreview(null);
    setJobId(null);
    setApplied(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const poll = useCallback((jobId: string) => {
    const MAX_POLL_ERRORS = 3;
    let consecutiveErrors = 0;
    const tick = async () => {
      if (cancelledRef.current) return;
      try {
        const res = await fetch(
          `/api/me/letterboxd/import?job_id=${encodeURIComponent(jobId)}`,
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as {
          status: string;
          preview: ImportPreview | null;
          error: string | null;
        };
        if (cancelledRef.current) return;
        consecutiveErrors = 0;
        if (data.status === "preview_ready") {
          setPreview(data.preview);
          setPhase("ready");
          return;
        }
        if (data.status === "failed") {
          setError(data.error ?? "Import failed.");
          setPhase("failed");
          return;
        }
        // pending | parsing -> keep polling
        setStatusText("Analyzing your export…");
        pollRef.current = setTimeout(tick, 2000);
      } catch (e) {
        if (cancelledRef.current) return;
        // Tolerate a few transient poll blips before giving up — the worker may
        // still be succeeding behind a momentary network/5xx error.
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_POLL_ERRORS) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("failed");
          return;
        }
        pollRef.current = setTimeout(tick, 2000);
      }
    };
    void tick();
  }, []);

  const onFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!file.name.toLowerCase().endsWith(".zip")) {
        setError("Please choose your Letterboxd export .zip file.");
        return;
      }
      if (file.size > MAX_BYTES) {
        setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 25 MB.`);
        return;
      }
      setPhase("uploading");
      setStatusText("Uploading…");
      try {
        const presignRes = await fetch("/api/me/letterboxd/presign", {
          method: "POST",
        });
        if (!presignRes.ok) {
          const j = (await presignRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `presign ${presignRes.status}`);
        }
        const { url, key, contentType, contentDisposition } =
          (await presignRes.json()) as {
            url: string;
            key: string;
            contentType: string;
            contentDisposition: string;
          };

        const putRes = await fetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": contentDisposition,
          },
          body: file,
        });
        if (!putRes.ok) throw new Error(`upload failed (${putRes.status})`);

        const importRes = await fetch("/api/me/letterboxd/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ r2_key: key }),
        });
        if (!importRes.ok) {
          const j = (await importRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `import ${importRes.status}`);
        }
        const { job_id } = (await importRes.json()) as { job_id: string };
        setJobId(job_id);
        setPhase("analyzing");
        setStatusText("Analyzing your export…");
        poll(job_id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("failed");
      }
    },
    [poll],
  );

  const onApply = useCallback(async () => {
    if (!jobId) return;
    setError(null);
    setStatusText("Applying your import…");
    setPhase("applying");
    try {
      const res = await fetch("/api/me/letterboxd/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        applied?: AppliedCounts;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.applied) {
        throw new Error(data.error ?? `apply ${res.status}`);
      }
      setApplied(data.applied);
      setPhase("applied");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    }
  }, [jobId]);

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Link
            href="/me"
            className="text-caption text-moonbeem-ink-subtle hover:text-moonbeem-pink"
          >
            ← Back to your profile
          </Link>
          <h1 className="text-heading-lg font-medium text-moonbeem-ink m-0">
            Import from Letterboxd
          </h1>
          <p className="text-body-sm text-moonbeem-ink-muted m-0">
            Upload your Letterboxd export and we&apos;ll match your films to
            Moonbeem and show you a preview. Nothing is imported yet —
            you&apos;ll confirm on the next step.
          </p>
        </header>

        {(phase === "idle" || phase === "failed") && (
          <section className="flex flex-col gap-4">
            <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.02] p-6 text-center">
              <p className="text-body-sm text-moonbeem-ink-muted m-0">
                In Letterboxd, go to{" "}
                <span className="text-moonbeem-ink">
                  Settings → Import &amp; Export → Export your data
                </span>
                , then drop the .zip here.
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
              <button
                type="button"
                onClick={() => {
                  // Clear first so re-selecting the SAME file after a failure
                  // still fires onChange (browsers suppress it otherwise).
                  if (inputRef.current) inputRef.current.value = "";
                  inputRef.current?.click();
                }}
                className="mt-4 inline-block rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
              >
                Choose your export .zip
              </button>
              <p className="mt-3 text-caption text-moonbeem-ink-subtle m-0">
                Up to 25 MB. We import ratings, diary, reviews, watchlist, and
                lists. Watched, likes, and comments are skipped.
              </p>
            </div>
            {error && (
              <p className="text-body-sm text-red-300 m-0">{error}</p>
            )}
          </section>
        )}

        {(phase === "uploading" ||
          phase === "analyzing" ||
          phase === "applying") && (
          <section className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-6">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-moonbeem-pink border-t-transparent" />
            <p className="text-body-sm text-moonbeem-ink-muted m-0">
              {statusText}
            </p>
          </section>
        )}

        {phase === "ready" && preview && (
          <PreviewView preview={preview} onApply={onApply} onReupload={reset} />
        )}

        {phase === "applied" && applied && (
          <AppliedView applied={applied} onReupload={reset} />
        )}
      </div>
    </div>
  );
}

function StatCard({ label, s }: { label: string; s: CategoryStats }) {
  const matched = s.matched_exact + s.matched_fuzzy;
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-body-sm text-moonbeem-ink">{label}</span>
        <span className="font-wordmark text-heading-md text-moonbeem-pink leading-none">
          {s.total}
        </span>
      </div>
      <div className="mt-2 flex flex-col gap-0.5 text-caption text-moonbeem-ink-subtle">
        <span>{matched} matched{s.matched_fuzzy > 0 ? ` (${s.matched_fuzzy} fuzzy)` : ""}</span>
        {s.matched_catalog > 0 && (
          <span>{s.matched_catalog} in our catalog, not yet live</span>
        )}
        <span>{s.unmatched} unmatched</span>
        {s.already_imported > 0 && <span>{s.already_imported} already imported</span>}
      </div>
    </div>
  );
}

function PreviewView({
  preview,
  onApply,
  onReupload,
}: {
  preview: ImportPreview;
  onApply: () => void;
  onReupload: () => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const { skipped } = preview;
  const skippedParts = [
    skipped.watched ? `${skipped.watched} watched` : null,
    skipped.likes ? `${skipped.likes} liked films` : null,
    skipped.comments ? `${skipped.comments} comments` : null,
    skipped.profile ? `profile` : null,
  ].filter(Boolean);

  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
        Preview
      </h2>

      {/* Per-category count cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {CATEGORY_ORDER.map(({ key, label }) => (
          <StatCard key={key} label={label} s={preview.categories[key]} />
        ))}
      </div>

      {/* Per-list breakdown */}
      {preview.lists.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-body-sm font-medium text-moonbeem-ink m-0">
            Lists ({preview.lists.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {preview.lists.map((l, i) => (
              <li
                key={`${l.name ?? "untitled"}-${i}`}
                className="flex items-center justify-between rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-body-sm"
              >
                <span className="text-moonbeem-ink-muted truncate">
                  {l.name ?? "Untitled list"}
                  {l.already_imported_list ? " · already imported" : ""}
                </span>
                <span className="ml-3 shrink-0 tabular-nums text-moonbeem-ink-subtle">
                  {l.matched_exact + l.matched_fuzzy}/{l.item_total} matched
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Fuzzy-match review table */}
      {preview.fuzzy_pairs.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-body-sm font-medium text-moonbeem-ink m-0">
            Fuzzy matches to review ({preview.fuzzy_pairs.length}
            {preview.fuzzy_truncated > 0 ? `+${preview.fuzzy_truncated} more` : ""})
          </h3>
          <p className="text-caption text-moonbeem-ink-subtle m-0">
            These matched by similar title within a year. Check them before
            applying.
          </p>
          <div className="overflow-x-auto rounded-md border border-white/10">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="text-left text-caption text-moonbeem-ink-subtle">
                  <th className="px-3 py-2 font-normal">Your film</th>
                  <th className="px-3 py-2 font-normal">Matched to</th>
                  <th className="px-3 py-2 font-normal">From</th>
                </tr>
              </thead>
              <tbody>
                {preview.fuzzy_pairs.map((f, i) => (
                  <tr key={i} className="border-t border-white/10">
                    <td className="px-3 py-2 text-moonbeem-ink-muted">
                      {f.input_name}
                      {f.input_year ? ` (${f.input_year})` : ""}
                    </td>
                    <td className="px-3 py-2 text-moonbeem-ink">
                      {f.matched_is_public && f.matched_slug ? (
                        <Link
                          href={`/t/${f.matched_slug}`}
                          className="text-moonbeem-pink hover:opacity-90"
                        >
                          {f.matched_name ?? f.matched_slug}
                          {f.matched_year ? ` (${f.matched_year})` : ""}
                        </Link>
                      ) : f.matched_name ? (
                        <span>
                          {f.matched_name}
                          {f.matched_year ? ` (${f.matched_year})` : ""}
                          <span className="ml-2 rounded-full bg-white/10 px-2 py-0.5 text-caption text-moonbeem-ink-subtle">
                            in our catalog, not yet live
                          </span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-moonbeem-ink-subtle">
                      {f.category}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Unmatched table */}
      {preview.unmatched.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-body-sm font-medium text-moonbeem-ink m-0">
            Importing as text — not in our catalog yet ({preview.unmatched.length}
            {preview.unmatched_truncated > 0 ? `+${preview.unmatched_truncated} more` : ""})
          </h3>
          <p className="text-caption text-moonbeem-ink-subtle m-0">
            These come along with you and get matched as our catalog grows.
          </p>
          <div className="overflow-x-auto rounded-md border border-white/10">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="text-left text-caption text-moonbeem-ink-subtle">
                  <th className="px-3 py-2 font-normal">Film</th>
                  <th className="px-3 py-2 font-normal">Year</th>
                  <th className="px-3 py-2 font-normal">From</th>
                </tr>
              </thead>
              <tbody>
                {preview.unmatched.map((u, i) => (
                  <tr key={i} className="border-t border-white/10">
                    <td className="px-3 py-2 text-moonbeem-ink-muted">{u.name}</td>
                    <td className="px-3 py-2 text-moonbeem-ink-subtle tabular-nums">
                      {u.year ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-moonbeem-ink-subtle">
                      {u.category}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Skipped categories + warnings */}
      {skippedParts.length > 0 && (
        <p className="text-caption text-moonbeem-ink-subtle m-0">
          Not imported: {skippedParts.join(", ")}.
        </p>
      )}
      {preview.warnings.length > 0 && (
        <details className="text-caption text-moonbeem-ink-subtle">
          <summary className="cursor-pointer hover:text-moonbeem-ink">
            {preview.warnings.length} warning
            {preview.warnings.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {preview.warnings.slice(0, 50).map((w, i) => (
              <li key={i}>
                {w.category} row {w.row}: {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Apply (Phase 2C): confirm, then write everything as private. */}
      <div className="flex flex-col gap-2 border-t border-white/10 pt-4">
        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          className="inline-block w-fit rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
        >
          Apply import
        </button>
        <p className="text-caption text-moonbeem-ink-subtle m-0">
          Everything imports as private. Nothing appears on your profile until
          you publish.
        </p>
        <button
          type="button"
          onClick={onReupload}
          className="w-fit text-body-sm text-moonbeem-pink hover:opacity-90"
        >
          Upload a different file →
        </button>
      </div>

      {showConfirm && (
        <ConfirmModal
          preview={preview}
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => {
            setShowConfirm(false);
            onApply();
          }}
        />
      )}
    </section>
  );
}

function ConfirmModal({
  preview,
  onConfirm,
  onCancel,
}: {
  preview: ImportPreview;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const c = preview.categories;
  const listCount = preview.lists.length;
  const lines: Array<[string, number]> = [
    ["Ratings", c.ratings.total],
    ["Diary", c.diary.total],
    ["Reviews", c.reviews.total],
    ["Watchlist", c.watchlist.total],
    [`List films (${listCount} list${listCount === 1 ? "" : "s"})`, c.lists.total],
  ];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-moonbeem-navy p-6 shadow-xl">
        <h3 className="text-body font-medium text-moonbeem-ink m-0">
          Import to your library?
        </h3>
        <ul className="mt-4 flex flex-col gap-1 text-body-sm text-moonbeem-ink-muted">
          {lines.map(([label, n]) => (
            <li key={label} className="flex justify-between gap-4">
              <span>{label}</span>
              <span className="tabular-nums text-moonbeem-ink">{n}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-caption text-moonbeem-ink-subtle">
          Everything imports as private. Nothing appears on your profile until
          you publish in the next step.
        </p>
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="text-body-sm text-moonbeem-ink-subtle hover:text-moonbeem-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
          >
            Import as private
          </button>
        </div>
      </div>
    </div>
  );
}

function AppliedView({
  applied,
  onReupload,
}: {
  applied: AppliedCounts;
  onReupload: () => void;
}) {
  const rows: Array<[string, AppliedCategory]> = [
    ["Ratings", applied.ratings],
    ["Diary & reviews", applied.diary],
    ["Lists", applied.lists],
    ["List films", applied.list_items],
  ];
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
          Imported
        </h2>
        <p className="text-body-sm text-moonbeem-ink-muted m-0">
          Everything imported as private. Nothing shows on your profile until you
          publish — that&apos;s the next step.
        </p>
      </div>

      <div className="overflow-x-auto rounded-md border border-white/10">
        <table className="w-full text-body-sm">
          <thead>
            <tr className="text-left text-caption text-moonbeem-ink-subtle">
              <th className="px-3 py-2 font-normal">Category</th>
              <th className="px-3 py-2 font-normal">Added</th>
              <th className="px-3 py-2 font-normal">Already there</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, cat]) => (
              <tr key={label} className="border-t border-white/10">
                <td className="px-3 py-2 text-moonbeem-ink-muted">{label}</td>
                <td className="px-3 py-2 tabular-nums text-moonbeem-ink">
                  {cat.inserted}
                </td>
                <td className="px-3 py-2 tabular-nums text-moonbeem-ink-subtle">
                  {cat.skipped}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 border-t border-white/10 pt-4">
        <Link
          href="/me/diary"
          className="w-fit text-body-sm text-moonbeem-pink hover:opacity-90"
        >
          View your diary →
        </Link>
        <button
          type="button"
          disabled
          aria-disabled="true"
          title="Publishing arrives in the next release"
          className="inline-flex w-fit cursor-not-allowed items-center gap-2 rounded-md bg-white/10 px-4 py-2 text-body-sm font-semibold text-moonbeem-ink-subtle"
        >
          Publish
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-caption">
            next step
          </span>
        </button>
        <button
          type="button"
          onClick={onReupload}
          className="w-fit text-body-sm text-moonbeem-pink hover:opacity-90"
        >
          Upload a different file →
        </button>
      </div>
    </section>
  );
}
