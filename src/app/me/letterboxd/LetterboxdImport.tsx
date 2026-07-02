"use client";

// Phase 2B import surface: upload a Letterboxd export ZIP -> presign -> PUT ->
// create job -> poll (2s) -> render the preview. NO apply: the Apply button is
// disabled and labeled as the next step (Phase 2C). Re-upload starts a new job.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  identifyCsvFiles,
  buildSyntheticZip,
  type IdentifyResult,
  type AssignedFile,
  type CsvCategory,
} from "@/lib/letterboxd/csv-select";

const MAX_BYTES = 25 * 1024 * 1024;

// A one-line "Detected: ratings, diary, watchlist, watched, 3 lists" summary of
// what the loose-CSV path is about to upload — shown while the synthetic zip
// analyzes, so the CSV path telegraphs the same content a zip would.
function describeAssignments(assigned: AssignedFile[]): string {
  const labels: string[] = [];
  const singles: Array<[CsvCategory, string]> = [
    ["ratings", "ratings"],
    ["diary", "diary"],
    ["reviews", "reviews"],
    ["watchlist", "watchlist"],
    ["watched", "watched"],
  ];
  for (const [cat, label] of singles) {
    if (assigned.some((a) => a.category === cat)) labels.push(label);
  }
  const lists = assigned.filter((a) => a.category === "list").length;
  if (lists) labels.push(`${lists} list${lists === 1 ? "" : "s"}`);
  if (assigned.some((a) => a.category === "likesFilms")) labels.push("likes (skipped)");
  if (assigned.some((a) => a.category === "profile")) labels.push("profile (skipped)");
  if (assigned.some((a) => a.category === "comments")) labels.push("comments (skipped)");
  return labels.length ? `Detected: ${labels.join(", ")}` : "";
}

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
    watched: CategoryStats;
    lists: CategoryStats;
  };
  lists: ListPreview[];
  fuzzy_pairs: FuzzyPair[];
  unmatched: UnmatchedRef[];
  fuzzy_truncated: number;
  unmatched_truncated: number;
  skipped: { likes: number; comments: number; profile: number };
  warnings: Warning[];
};

type Phase =
  | "idle"
  | "resolving"
  | "uploading"
  | "analyzing"
  | "ready"
  | "applying"
  | "applied"
  | "publishing"
  | "published"
  | "failed";

type AppliedCategory = { attempted: number; inserted: number; skipped: number };
type PublishCounts = {
  ratings_published: number;
  diary_published: number;
  watched_published: number;
  lists_published: number;
  watchlist_merged: number;
  watchlist_skipped: number;
  titles_recomputed: number;
};
type AppliedCounts = {
  ratings: AppliedCategory;
  diary: AppliedCategory;
  watched: AppliedCategory;
  lists: AppliedCategory;
  list_items: AppliedCategory;
};

const CATEGORY_ORDER: Array<{ key: keyof ImportPreview["categories"]; label: string }> = [
  { key: "ratings", label: "Ratings" },
  { key: "diary", label: "Diary" },
  { key: "reviews", label: "Reviews" },
  { key: "watchlist", label: "Watchlist" },
  { key: "watched", label: "Watched" },
  { key: "lists", label: "List films" },
];

export default function LetterboxdImport({
  handle,
  alreadyPublished,
  resumeCounts,
}: {
  handle: string;
  alreadyPublished: boolean;
  // Server-computed from the creator's remaining private letterboxd rows: when a
  // completed import exists but nothing's published yet, open on the applied view
  // (Publish enabled) instead of idle, so a returning user can finish the flow.
  resumeCounts: AppliedCounts | null;
}) {
  const [phase, setPhase] = useState<Phase>(
    alreadyPublished ? "published" : resumeCounts ? "applied" : "idle",
  );
  const [statusText, setStatusText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [applied, setApplied] = useState<AppliedCounts | null>(resumeCounts);
  const [publishedCounts, setPublishedCounts] = useState<PublishCounts | null>(
    null,
  );
  // Loose-CSV path: when a selection needs user input (ambiguous / conflicting /
  // unrecognized files), the identification result is parked here and phase goes
  // to "resolving" (an inline step inside the card, not a modal).
  const [identify, setIdentify] = useState<IdentifyResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Drag-enter depth counter: dragenter/dragleave fire for every child boundary
  // as the cursor moves across the card's inner text/button, so a naive
  // leave->false flickers the visual and can clear it mid-drag. Counting keeps
  // the drop zone "active" until the cursor truly leaves the card.
  const dragDepth = useRef(0);
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
    setIdentify(null);
    setDragOver(false);
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

  // Shared uploader: presign -> PUT the zip bytes -> create import job -> poll.
  // Byte-identical to the original for the .zip path (a File IS a Blob, passed
  // straight through); the loose-CSV path passes a synthesized zip Blob + a
  // "Detected: …" detail line. NOTHING server-side changes — same three calls.
  const startUpload = useCallback(
    async (body: Blob, statusDetail?: string) => {
      setPhase("uploading");
      setStatusText(statusDetail ? `Uploading. ${statusDetail}` : "Uploading…");
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
          body,
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
        setStatusText(
          statusDetail
            ? `Analyzing your export. ${statusDetail}`
            : "Analyzing your export…",
        );
        poll(job_id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("failed");
      }
    },
    [poll],
  );

  // Single .zip — the original path, unchanged validation + messages.
  const onZipFile = useCallback(
    (file: File) => {
      setError(null);
      if (!file.name.toLowerCase().endsWith(".zip")) {
        setError("Please choose your Letterboxd export .zip file.");
        return;
      }
      if (file.size > MAX_BYTES) {
        setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB.`);
        return;
      }
      void startUpload(file);
    },
    [startUpload],
  );

  // Synthesize the export-shaped zip from resolved assignments and upload it
  // through the exact same cycle a real export uses.
  const finalizeAssignments = useCallback(
    (assigned: AssignedFile[]) => {
      // Guarded: this is also reachable from the ResolutionView Continue button
      // (outside any try), so a buildSyntheticZip throw must surface, not vanish.
      try {
        const bytes = buildSyntheticZip(
          assigned.map((a) => ({ category: a.category, name: a.name, text: a.text })),
        );
        // Re-wrap in a plain ArrayBuffer-backed view so Blob's typing is
        // satisfied (zipSync output is already ArrayBuffer-backed — this is a
        // lib-type formality, not a real copy-of-shared-memory concern).
        const blob = new Blob([new Uint8Array(bytes)], { type: "application/zip" });
        void startUpload(blob, describeAssignments(assigned));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("failed");
      }
    },
    [startUpload],
  );

  // One-or-more .csv (no zip). Read text, identify, then either upload straight
  // through (clean) or open the inline resolution step (messy).
  const onCsvFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      // Instant processing feedback, and the WHOLE read -> identify -> zip path
      // wrapped so no exception can be silent (an uncaught throw here — e.g. the
      // minifier ReferenceError — previously rendered nothing at all).
      setPhase("uploading");
      setStatusText("Reading your files…");
      try {
        const totalBytes = files.reduce((s, f) => s + f.size, 0);
        if (totalBytes > MAX_BYTES) {
          setError(
            `Those files are ${(totalBytes / 1024 / 1024).toFixed(1)} MB total. The limit is 25 MB.`,
          );
          setPhase("failed");
          return;
        }
        const inputs = await Promise.all(
          files.map(async (f) => ({ name: f.name, text: await f.text() })),
        );
        const result = identifyCsvFiles(inputs);
        const clean =
          result.ambiguous.length === 0 &&
          result.conflicts.length === 0 &&
          result.unrecognized.length === 0;
        if (clean) {
          finalizeAssignments(result.assigned);
        } else {
          setIdentify(result);
          setPhase("resolving");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("failed");
      }
    },
    [finalizeAssignments],
  );

  // Branch a selection by extension. Exactly one .zip -> zip path; one-or-more
  // .csv with no zip -> CSV path; anything mixed (zip+csv, multiple zips, or
  // nothing usable) -> the inline "not both" error.
  const onSelection = useCallback(
    (files: File[]) => {
      setError(null);
      const zips = files.filter((f) => f.name.toLowerCase().endsWith(".zip"));
      const csvs = files.filter((f) => f.name.toLowerCase().endsWith(".csv"));
      if (zips.length > 1 || (zips.length === 1 && csvs.length > 0)) {
        setError("Drop either your export .zip or your .csv files, not both.");
        return;
      }
      if (zips.length === 1) {
        onZipFile(zips[0]);
        return;
      }
      if (csvs.length > 0) {
        void onCsvFiles(csvs);
        return;
      }
      setError("Drop either your export .zip or your .csv files.");
    },
    [onZipFile, onCsvFiles],
  );

  // Phase-aware entry for BOTH the file input and drag-drop. A drop mid-
  // resolution is rejected (never silently resets in-progress choices); drops
  // mid-upload are ignored. Only idle/failed accept a fresh selection.
  const handleIncoming = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (phase === "resolving") {
        setError(
          "Finish choosing for these files, or start over, before adding more.",
        );
        return;
      }
      if (phase !== "idle" && phase !== "failed") return;
      // Top-level sync guard so a synchronous throw in the branch selection
      // (zip validation, extension routing) can never bubble uncaught. The async
      // CSV path self-guards inside onCsvFiles.
      try {
        onSelection(files);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("failed");
      }
    },
    [phase, onSelection],
  );

  // The HTML drag-and-drop spec requires cancelling BOTH dragenter AND dragover
  // to register an element as a valid drop zone. Cancelling only dragover works
  // for some in-page drags but NOT reliably for OS-originated file drags (macOS
  // Chrome from Finder) — without the dragenter cancel the browser never fires
  // `drop`. So we cancel every drag event on the card + stopPropagation so the
  // dashed card owns the whole gesture.
  const onDragEnterCard = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current += 1;
      if (phase === "idle" || phase === "failed") setDragOver(true);
    },
    [phase],
  );

  const onDragOverCard = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Show the copy cursor while hovering with files.
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeaveCard = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  }, []);

  const onDropCard = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDragOver(false);
      handleIncoming(Array.from(e.dataTransfer.files));
    },
    [handleIncoming],
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

  const onPublish = useCallback(async () => {
    setError(null);
    setStatusText("Publishing to your profile…");
    setPhase("publishing");
    try {
      const res = await fetch("/api/me/letterboxd/publish", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        published?: PublishCounts;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `publish ${res.status}`);
      }
      setPublishedCounts(data.published ?? null);
      setPhase("published");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    }
  }, []);

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
            Moonbeem and show you a preview. Nothing is imported yet.
            You&apos;ll confirm on the next step.
          </p>
        </header>

        {(phase === "idle" || phase === "failed") && (
          <section className="flex flex-col gap-4">
            <div
              onDragEnter={onDragEnterCard}
              onDragOver={onDragOverCard}
              onDragLeave={onDragLeaveCard}
              onDrop={onDropCard}
              className={`rounded-lg border border-dashed p-6 text-center transition-colors ${
                dragOver
                  ? "border-moonbeem-pink/60 bg-moonbeem-pink/5"
                  : "border-white/15 bg-white/[0.02]"
              }`}
            >
              <p className="text-body-sm text-moonbeem-ink-muted m-0">
                In Letterboxd, go to{" "}
                <span className="text-moonbeem-ink">
                  Settings → Data → Export your data
                </span>
                . Then drop the .zip or your .csv files here.
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".zip,.csv,application/zip,text/csv"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) handleIncoming(files);
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
                Choose your export (.zip or .csv files)
              </button>
              <p className="mt-3 text-caption text-moonbeem-ink-subtle m-0">
                Up to 25 MB. We import ratings, diary, reviews, watchlist,
                watched, and lists. Likes and comments are skipped.
              </p>
              <ExportHelp />
            </div>
            {error && (
              <p className="text-body-sm text-red-300 m-0">{error}</p>
            )}
          </section>
        )}

        {phase === "resolving" && identify && (
          <ResolutionView
            identify={identify}
            onContinue={finalizeAssignments}
            onStartOver={reset}
            error={error}
          />
        )}

        {(phase === "uploading" ||
          phase === "analyzing" ||
          phase === "applying" ||
          phase === "publishing") && (
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
          <AppliedView applied={applied} onPublish={onPublish} onReupload={reset} />
        )}

        {phase === "published" && (
          <PublishedView
            handle={handle}
            counts={publishedCounts}
            onReupload={reset}
          />
        )}
      </div>
    </div>
  );
}

const CATEGORY_LABEL: Record<CsvCategory, string> = {
  ratings: "Ratings",
  diary: "Diary",
  reviews: "Reviews",
  watchlist: "Watchlist",
  watched: "Watched",
  likesFilms: "Likes",
  comments: "Comments",
  profile: "Profile",
  list: "List",
};

// Inline resolution step for the loose-CSV path (NOT a modal — lives in the same
// dashed card). Renders one row per file needing input: ambiguous bare files get
// a Watchlist/Watched/Skip select (no pre-selection); conflicting same-category
// files get a pick-one; unrecognized files are shown as skipped. Continue stays
// disabled until every ambiguous AND every conflict is resolved and at least one
// file remains to import.
function ResolutionView({
  identify,
  onContinue,
  onStartOver,
  error,
}: {
  identify: IdentifyResult;
  onContinue: (assigned: AssignedFile[]) => void;
  onStartOver: () => void;
  error: string | null;
}) {
  const [ambChoices, setAmbChoices] = useState<
    Array<"" | "watchlist" | "watched" | "skip">
  >(() => identify.ambiguous.map(() => ""));
  const [conflictChoices, setConflictChoices] = useState<number[]>(() =>
    identify.conflicts.map(() => -1),
  );

  const buildFinal = (): AssignedFile[] => {
    const out: AssignedFile[] = [...identify.assigned];
    identify.ambiguous.forEach((amb, i) => {
      const c = ambChoices[i];
      if (c === "watchlist" || c === "watched") {
        out.push({
          category: c,
          name: amb.name,
          text: amb.text,
          rowCount: amb.rowCount,
          note: null,
        });
      }
    });
    identify.conflicts.forEach((conf, j) => {
      const k = conflictChoices[j];
      if (k >= 0) {
        const file = conf.files[k];
        out.push({
          category: conf.category,
          name: file.name,
          text: file.text,
          rowCount: file.rowCount,
          note: null,
        });
      }
    });
    return out;
  };

  const allAmbChosen = ambChoices.every((c) => c !== "");
  const allConflictsChosen = conflictChoices.every((i) => i >= 0);
  const final = buildFinal();
  const canContinue = allAmbChosen && allConflictsChosen && final.length > 0;

  const ready = describeAssignments(identify.assigned);
  const assignedNotes = identify.assigned
    .map((a) => a.note)
    .filter((n): n is string => Boolean(n));

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.02] p-6">
        <h2 className="text-body font-medium text-moonbeem-ink m-0">
          A few files need your input
        </h2>
        <p className="mt-1 text-caption text-moonbeem-ink-subtle m-0">
          We recognized most of your files. Tell us about the rest, then
          continue. Nothing is imported yet.
        </p>

        {ready && (
          <p className="mt-4 text-body-sm text-moonbeem-ink-muted m-0">
            Ready: <span className="text-moonbeem-ink">{ready}</span>
          </p>
        )}
        {assignedNotes.map((n, i) => (
          <p key={`an-${i}`} className="mt-1 text-caption text-moonbeem-ink-subtle m-0">
            {n}
          </p>
        ))}

        {/* Ambiguous — bare {date,name,year,uri}: watchlist vs watched vs skip */}
        {identify.ambiguous.length > 0 && (
          <div className="mt-5 flex flex-col gap-2">
            {identify.ambiguous.map((amb, i) => (
              <div
                key={`amb-${i}`}
                className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-body-sm text-moonbeem-ink m-0">
                    {amb.name}
                  </p>
                  <p className="text-caption text-moonbeem-ink-subtle m-0">
                    {amb.rowCount} row{amb.rowCount === 1 ? "" : "s"} · could be
                    watchlist or watched
                  </p>
                </div>
                <select
                  value={ambChoices[i]}
                  onChange={(e) => {
                    const v = e.target.value as "" | "watchlist" | "watched" | "skip";
                    setAmbChoices((prev) => {
                      const next = [...prev];
                      next[i] = v;
                      return next;
                    });
                  }}
                  className="shrink-0 rounded-md border border-white/15 bg-moonbeem-navy px-2 py-1 text-body-sm text-moonbeem-ink"
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="watchlist">Watchlist</option>
                  <option value="watched">Watched</option>
                  <option value="skip">Skip</option>
                </select>
              </div>
            ))}
          </div>
        )}

        {/* Conflicts — two files map to the same single-slot category */}
        {identify.conflicts.length > 0 && (
          <div className="mt-5 flex flex-col gap-3">
            {identify.conflicts.map((conf, j) => (
              <div
                key={`conf-${j}`}
                className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2"
              >
                <p className="text-body-sm text-moonbeem-ink m-0">
                  Two files look like {CATEGORY_LABEL[conf.category].toLowerCase()}.
                  Choose which to import.
                </p>
                <div className="mt-2 flex flex-col gap-1">
                  {conf.files.map((file, k) => (
                    <label
                      key={`conf-${j}-${k}`}
                      className="flex cursor-pointer items-center gap-2 text-body-sm text-moonbeem-ink-muted"
                    >
                      <input
                        type="radio"
                        name={`conflict-${j}`}
                        checked={conflictChoices[j] === k}
                        onChange={() =>
                          setConflictChoices((prev) => {
                            const next = [...prev];
                            next[j] = k;
                            return next;
                          })
                        }
                        className="accent-moonbeem-pink"
                      />
                      <span className="truncate">
                        {file.name}
                        <span className="ml-2 text-caption text-moonbeem-ink-subtle">
                          {file.rowCount} row{file.rowCount === 1 ? "" : "s"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-caption text-moonbeem-ink-subtle m-0">
                  The other file is skipped.
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Unrecognized — informational, no action */}
        {identify.unrecognized.length > 0 && (
          <div className="mt-5 flex flex-col gap-1">
            {identify.unrecognized.map((u, i) => (
              <p
                key={`unrec-${i}`}
                className="text-caption text-moonbeem-ink-subtle m-0"
              >
                <span className="text-moonbeem-ink-muted">{u.name}</span>: skipped. Not
                a Letterboxd export file
              </p>
            ))}
          </div>
        )}

        <div className="mt-6 flex items-center gap-4 border-t border-white/10 pt-4">
          <button
            type="button"
            disabled={!canContinue}
            onClick={() => onContinue(final)}
            className="inline-block rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Continue
          </button>
          <button
            type="button"
            onClick={onStartOver}
            className="text-body-sm text-moonbeem-pink hover:opacity-90"
          >
            Start over
          </button>
        </div>
      </div>
      {error && <p className="text-body-sm text-red-300 m-0">{error}</p>}
    </section>
  );
}

// Collapsible "how to export from Letterboxd" help, inline inside the import
// card. Collapsed by default; state is component-local (no persistence). When
// collapsed it adds only the one toggle link and does not disturb the layout.
function ExportHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-caption text-moonbeem-pink transition-opacity hover:opacity-90"
      >
        <span>Need help exporting from Letterboxd?</span>
        <svg
          className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 4.5 6 7.5 9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="mt-3 text-left">
          <h3 className="text-body-sm font-medium text-moonbeem-ink m-0">
            How to export your Letterboxd data
          </h3>
          <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-body-sm text-moonbeem-ink-muted">
            <li>Sign in at letterboxd.com.</li>
            <li>Click your username in the top menu, then Settings.</li>
            <li>Open the Data tab.</li>
            <li>Click Export your data.</li>
            <li>
              Confirm in the window that appears. Letterboxd downloads a .zip of
              your films, ratings, reviews, and lists.
            </li>
            <li>
              Drop that .zip here. If your download arrived as separate .csv
              files, drop those instead.
            </li>
          </ol>
          <p className="mt-3 text-caption text-moonbeem-ink-muted m-0">
            Your export usually downloads in a few seconds. On some devices it
            arrives as loose .csv files instead of a .zip. Both work here.
          </p>
        </div>
      )}
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
                          <span className="ml-2 inline-block whitespace-nowrap rounded-full bg-white/10 px-2 py-0.5 text-caption text-moonbeem-ink-subtle">
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
            Importing as text, not in our catalog yet ({preview.unmatched.length}
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
    ["Watched", c.watched.total],
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
  onPublish,
  onReupload,
}: {
  applied: AppliedCounts;
  onPublish: () => void;
  onReupload: () => void;
}) {
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const rows: Array<[string, AppliedCategory]> = [
    ["Ratings", applied.ratings],
    ["Diary & reviews", applied.diary],
    ["Watched", applied.watched],
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
          Your ratings, diary, watched films, and lists imported as private.
          Nothing shows on your profile until you publish. That&apos;s the next
          step.
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
          onClick={() => setShowPublishConfirm(true)}
          className="inline-block w-fit rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
        >
          Publish to your profile
        </button>
        {showPublishConfirm && (
          <PublishConfirmModal
            onCancel={() => setShowPublishConfirm(false)}
            onConfirm={() => {
              setShowPublishConfirm(false);
              onPublish();
            }}
          />
        )}
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

function PublishConfirmModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-moonbeem-navy p-6 shadow-xl">
        <h3 className="text-body font-medium text-moonbeem-ink m-0">
          Publish to your profile?
        </h3>
        <p className="mt-4 text-body-sm text-moonbeem-ink-muted">
          Your ratings, diary, watched films, and lists go live on your profile.
          Films not yet in our catalog stay as text and link up as it grows.
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
            Publish
          </button>
        </div>
      </div>
    </div>
  );
}

function PublishedView({
  handle,
  counts,
  onReupload,
}: {
  handle: string;
  counts: PublishCounts | null;
  onReupload: () => void;
}) {
  const rows: Array<[string, number]> = counts
    ? [
        ["Ratings", counts.ratings_published],
        ["Diary & reviews", counts.diary_published],
        ["Watched", counts.watched_published],
        ["Lists", counts.lists_published],
        ["Watchlist films", counts.watchlist_merged],
      ]
    : [];
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
          Published
        </h2>
        <p className="text-body-sm text-moonbeem-ink-muted m-0">
          Your ratings, diary, watched films, and lists are live on your profile.
          Films not yet in our catalog show as text and link up as it grows.
        </p>
      </div>

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-white/10">
          <table className="w-full text-body-sm">
            <tbody>
              {rows.map(([label, n]) => (
                <tr key={label} className="border-t border-white/10 first:border-t-0">
                  <td className="px-3 py-2 text-moonbeem-ink-muted">{label}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-moonbeem-ink">
                    {n}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-white/10 pt-4">
        <Link
          href={`/c/${handle}`}
          className="inline-block w-fit rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
        >
          View your profile →
        </Link>
        <button
          type="button"
          onClick={onReupload}
          className="w-fit text-body-sm text-moonbeem-pink hover:opacity-90"
        >
          Import another file →
        </button>
      </div>
    </section>
  );
}
