"use client";

// Partner-admin territory selector (Unit 3b). Declares WHERE a film is licensed
// to play -> PATCH /api/titles/[id]/territories. Three layers: one-click presets,
// search, and collapsible region groups. "Worldwide" sets the territory_worldwide
// flag; the others seed an editable allow-list. A title can't be made public
// (the publish route's no_territories_set guard) until something is declared, so
// this is the forcing function's UI. Client island, rendered by TitleUploadPanel.

import { useMemo, useState } from "react";
import {
  REGION_ORDER,
  countriesByRegion,
  PRESET_US_ONLY,
  PRESET_NORTH_AMERICA,
  PRESET_EUROPE,
  type Country,
  type Region,
} from "@/lib/playback/countries";

function friendlyError(code: string | undefined, status: number): string {
  switch (code) {
    case "unknown_country":
      return "One of the selected countries isn't recognized.";
    case "invalid_territories":
      return "Invalid territory selection.";
    case "not_authorized":
      return "You don't have permission to set territories here.";
    case "not_authenticated":
      return "Please sign in again.";
    default:
      return code ?? `Couldn't save territories (${status}).`;
  }
}

const PRESETS: ReadonlyArray<{
  label: string;
  apply: "worldwide" | readonly string[];
}> = [
  { label: "Worldwide", apply: "worldwide" },
  { label: "United States only", apply: PRESET_US_ONLY },
  { label: "North America", apply: PRESET_NORTH_AMERICA },
  { label: "Europe", apply: PRESET_EUROPE },
];

export default function TerritorySelector({
  titleId,
  initialWorldwide,
  initialAllowed,
}: {
  titleId: string;
  initialWorldwide: boolean;
  initialAllowed: string[];
}) {
  const [worldwide, setWorldwide] = useState(initialWorldwide);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialAllowed),
  );
  const [search, setSearch] = useState("");
  const [openRegions, setOpenRegions] = useState<Set<Region>>(new Set());
  const [phase, setPhase] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [savedWorldwide, setSavedWorldwide] = useState(initialWorldwide);
  const [savedAllowed, setSavedAllowed] = useState(
    [...initialAllowed].sort().join(","),
  );

  // Dirty = current state differs from the last-saved snapshot.
  const currentSig = worldwide ? "WW" : [...selected].sort().join(",");
  const savedSig = savedWorldwide ? "WW" : savedAllowed;
  const dirty = currentSig !== savedSig;

  function clearFeedback() {
    setError(null);
    if (phase === "saved") setPhase("idle");
  }

  function applyPreset(apply: "worldwide" | readonly string[]) {
    clearFeedback();
    if (apply === "worldwide") {
      setWorldwide(true);
      setSelected(new Set());
    } else {
      setWorldwide(false);
      setSelected(new Set(apply));
    }
  }

  function presetActive(apply: "worldwide" | readonly string[]): boolean {
    if (apply === "worldwide") return worldwide;
    if (worldwide) return false;
    return apply.length === selected.size && apply.every((c) => selected.has(c));
  }

  function toggleCountry(code: string) {
    clearFeedback();
    setWorldwide(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleRegion(codes: string[]) {
    clearFeedback();
    setWorldwide(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = codes.every((c) => next.has(c));
      if (allIn) codes.forEach((c) => next.delete(c));
      else codes.forEach((c) => next.add(c));
      return next;
    });
  }

  const filteredByRegion = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<Region, Country[]>();
    for (const region of REGION_ORDER) {
      map.set(
        region,
        countriesByRegion(region).filter(
          (c) =>
            !q ||
            c.name.toLowerCase().includes(q) ||
            c.code.toLowerCase().includes(q),
        ),
      );
    }
    return map;
  }, [search]);

  async function save() {
    setPhase("saving");
    setError(null);
    try {
      const res = await fetch(`/api/titles/${titleId}/territories`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          territory_worldwide: worldwide,
          allowed_territories: worldwide ? [] : [...selected],
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(friendlyError(json.error, res.status));
        setPhase("idle");
        return;
      }
      setSavedWorldwide(worldwide);
      setSavedAllowed([...selected].sort().join(","));
      setPhase("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  const summary = worldwide
    ? "Worldwide — plays everywhere"
    : selected.size > 0
      ? `${selected.size} ${selected.size === 1 ? "country" : "countries"} selected`
      : "No territories set — required before publishing";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
          Territories
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          Where this film is licensed to play
        </span>
      </div>

      {/* Presets */}
      <div className="mt-4 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyPreset(p.apply)}
            className={`rounded-md border px-3 py-1.5 text-body-sm transition-colors ${
              presetActive(p.apply)
                ? "border-moonbeem-pink bg-moonbeem-pink/10 text-moonbeem-pink"
                : "border-white/10 text-moonbeem-ink-muted hover:border-moonbeem-pink"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Live summary */}
      <p
        className={`mt-4 text-body-sm m-0 ${
          worldwide
            ? "text-moonbeem-lime"
            : selected.size > 0
              ? "text-moonbeem-ink"
              : "text-moonbeem-magenta"
        }`}
      >
        {summary}
      </p>

      {/* Granular picker — dimmed/disabled while Worldwide is on. */}
      <div className={worldwide ? "pointer-events-none opacity-40" : ""}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={worldwide}
          placeholder="Search countries…"
          className="mt-4 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none disabled:opacity-60"
        />

        <div className="mt-3 flex flex-col gap-2">
          {REGION_ORDER.map((region) => {
            const all = countriesByRegion(region);
            const shown = filteredByRegion.get(region) ?? [];
            if (shown.length === 0) return null;
            const selCount = all.filter((c) => selected.has(c.code)).length;
            const allIn = selCount === all.length;
            const open = openRegions.has(region) || search.trim().length > 0;
            return (
              <div key={region} className="rounded-lg border border-white/5">
                <div className="flex w-full items-center justify-between gap-3 px-3 py-2">
                  <button
                    type="button"
                    onClick={() =>
                      setOpenRegions((prev) => {
                        const next = new Set(prev);
                        if (next.has(region)) next.delete(region);
                        else next.add(region);
                        return next;
                      })
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="text-caption text-moonbeem-ink-subtle">
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="text-body-sm font-medium text-moonbeem-ink">
                      {region}
                    </span>
                    <span className="text-caption text-moonbeem-ink-subtle tabular-nums">
                      {selCount}/{all.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleRegion(all.map((c) => c.code))}
                    className="text-caption text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
                  >
                    {allIn ? "clear" : "all"}
                  </button>
                </div>
                {open && (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 pb-3 sm:grid-cols-3">
                    {shown.map((c) => (
                      <label
                        key={c.code}
                        className="flex cursor-pointer items-center gap-2 text-caption text-moonbeem-ink-muted"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(c.code)}
                          onChange={() => toggleCountry(c.code)}
                          className="accent-moonbeem-pink"
                        />
                        <span className="truncate">{c.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <p className="mt-3 text-caption text-moonbeem-magenta m-0">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={phase === "saving" || !dirty}
          className="rounded-md bg-moonbeem-pink px-4 py-2 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {phase === "saving" ? "Saving…" : "Save territories"}
        </button>
        {phase === "saved" && !dirty && (
          <span className="text-caption text-moonbeem-lime">Saved</span>
        )}
      </div>
    </div>
  );
}
