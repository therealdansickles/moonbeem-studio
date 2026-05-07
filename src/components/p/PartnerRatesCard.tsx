"use client";

import { useState } from "react";

type TitleRate = {
  title_id: string;
  title: string;
  // null when no row exists yet for this title.
  rate_cents_per_thousand: number | null;
};

type Props = {
  partnerSlug: string;
  isAdmin: boolean;
  titles: TitleRate[];
  // From last calculation run, scoped to this partner.
  paid_this_month_cents: number;
  unique_creators_paid: number;
};

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function PartnerRatesCard({
  partnerSlug,
  isAdmin,
  titles,
  paid_this_month_cents,
  unique_creators_paid,
}: Props) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
          Pay creators
        </span>
        <span className="text-caption text-moonbeem-ink-subtle">
          CPM rate per title
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <div className="text-display-sm text-moonbeem-ink leading-none">
            {formatDollars(paid_this_month_cents)}
          </div>
          <div className="mt-1 text-caption text-moonbeem-ink-subtle">
            calculated this month
          </div>
        </div>
        <div>
          <div className="text-display-sm text-moonbeem-ink leading-none">
            {unique_creators_paid}
          </div>
          <div className="mt-1 text-caption text-moonbeem-ink-subtle">
            creators with earnings
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {titles.map((t) => (
          <RateRow
            key={t.title_id}
            partnerSlug={partnerSlug}
            isAdmin={isAdmin}
            titleId={t.title_id}
            titleName={t.title}
            initialRate={t.rate_cents_per_thousand}
          />
        ))}
      </div>

      {!isAdmin && (
        <p className="mt-4 text-caption text-moonbeem-ink-subtle">
          You have viewer access to this partner. Contact an admin to change
          rates.
        </p>
      )}
    </div>
  );
}

function RateRow({
  partnerSlug,
  isAdmin,
  titleId,
  titleName,
  initialRate,
}: {
  partnerSlug: string;
  isAdmin: boolean;
  titleId: string;
  titleName: string;
  initialRate: number | null;
}) {
  // Display state: rate as dollars (string), what user types.
  const [rateInput, setRateInput] = useState<string>(
    initialRate === null ? "" : (initialRate / 100).toFixed(2),
  );
  const [savedRate, setSavedRate] = useState<number | null>(initialRate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedJustNow, setSavedJustNow] = useState(false);

  const dirty = parseDollars(rateInput) !== savedRate;

  async function save() {
    const cents = parseDollars(rateInput);
    if (cents === null) {
      setError("Enter a non-negative dollar amount.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/p/${partnerSlug}/title-rates`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title_id: titleId,
          rate_cents_per_thousand: cents,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `request failed (${res.status})`);
        return;
      }
      setSavedRate(cents);
      setSavedJustNow(true);
      setTimeout(() => setSavedJustNow(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-sm font-medium text-moonbeem-ink">
          {titleName}
        </div>
        <div className="text-caption text-moonbeem-ink-subtle">
          per 1,000 views
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-body-sm text-moonbeem-ink-muted">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={rateInput}
          onChange={(e) => setRateInput(e.target.value)}
          disabled={!isAdmin || saving}
          placeholder="0.00"
          className="w-24 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-right text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none disabled:opacity-60"
        />
        {isAdmin && (
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-md bg-moonbeem-pink px-3 py-1.5 text-caption font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {saving ? "Saving…" : savedJustNow ? "Saved" : "Save"}
          </button>
        )}
      </div>
      {error && (
        <p className="basis-full text-caption text-moonbeem-magenta">
          {error}
        </p>
      )}
    </div>
  );
}

// "1.50" → 150. Returns null on invalid input.
function parseDollars(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}
