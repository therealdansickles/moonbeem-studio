"use client";

// Single-session campaign-creation wizard. Mirrors the
// AttachTitleModal pattern from /admin: a modal with flat useState
// slots and progressive disclosure via a mode sentinel ("edit" ->
// "review"). NOT a persisted-draft flow — closing the modal mid-build
// loses the in-progress state. The codebase has no resumable form
// pattern (see 3a recon Group 2), and creating one for a ~5-field
// wizard would be net-new weight.
//
// The "draft" in campaigns.status='draft' is a saved-row lifecycle
// stage, not a saved form-in-progress. 3a writes that row on submit;
// 3b funds it.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";

type PartnerTitle = {
  id: string;
  slug: string;
  title: string;
  poster_url: string | null;
  is_active: boolean;
};

type Props = {
  partnerSlug: string;
  titles: PartnerTitle[];
  onClose: () => void;
};

// Same dollar-input shape PartnerRatesCard's RateRow uses: free-form
// string the user types, parsed to integer cents at validation time.
function parseDollars(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Mirrors the DB default campaigns.moonbeem_fee_pct (0.10). Display-only:
// the actual fee is computed server-side at funding from the campaign row
// (src/app/api/p/[slug]/campaigns/[id]/fund/route.ts). Keep these in sync.
const MOONBEEM_FEE_PCT = 0.1;

// Friendly mapping of the API's snake_case error codes. Anything we
// don't recognize falls back to the raw code so it's at least
// debuggable in the UI.
function friendlyError(code: string): string {
  switch (code) {
    case "invalid_name":
      return "Add a campaign name (1–200 characters).";
    case "invalid_title_ids":
      return "Pick at least one title for this campaign.";
    case "invalid_cpm_rate":
      return "Enter a CPM rate of at least $0.01 per 1,000 views.";
    case "invalid_budget":
      return "Enter a budget greater than $0.";
    case "invalid_dates":
      return "Check the start/end dates — end must be after start.";
    case "title_not_in_partner":
      return "One of the selected titles isn't on this partner.";
    case "not_authorized":
      return "You don't have admin access on this partner.";
    case "not_authenticated":
      return "Please sign in again.";
    case "not_found":
      return "Partner not found.";
    case "invalid_json":
      return "Something went wrong sending the request. Try again.";
    default:
      return code;
  }
}

function PosterThumb({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return (
      <div
        className="h-[60px] w-[40px] shrink-0 rounded-sm border border-white/10 bg-white/[0.03]"
        aria-hidden="true"
      />
    );
  }
  return (
    <div className="h-[60px] w-[40px] shrink-0 overflow-hidden rounded-sm bg-white/[0.03]">
      <Image
        src={url}
        alt={alt}
        width={40}
        height={60}
        className="h-full w-full object-cover"
        unoptimized
      />
    </div>
  );
}

export default function CampaignWizard({
  partnerSlug,
  titles,
  onClose,
}: Props) {
  const router = useRouter();

  // Flat field state.
  const [name, setName] = useState("");
  const [selectedTitleIds, setSelectedTitleIds] = useState<Set<string>>(
    new Set(),
  );
  const [cpmInput, setCpmInput] = useState("");
  const [budgetInput, setBudgetInput] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  // Mode sentinel: "edit" shows the form, "review" shows the summary
  // + submit. Single-direction progression with a "Back to edit" door
  // — same shape as AttachTitleModal's selected/!selected toggle.
  const [mode, setMode] = useState<"edit" | "review">("edit");

  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // Esc-to-close + focus on the name input on open.
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    nameInputRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Derived state for validation gates.
  const trimmedName = name.trim();
  const nameOk = trimmedName.length > 0 && trimmedName.length <= 200;
  const cpmCents = parseDollars(cpmInput);
  const cpmOk = cpmCents !== null && cpmCents >= 1;
  const budgetCents = parseDollars(budgetInput);
  const budgetOk = budgetCents !== null && budgetCents > 0;

  // Display-only fee/total. Computed in the same integer order as the
  // backend (Math.round on cents, fee on top of budget) so the readout
  // matches the funding charge to the cent. Null when budget is empty or
  // invalid — we render nothing rather than flash a $0.00 fee.
  const feeCents = budgetOk ? Math.round(budgetCents! * MOONBEEM_FEE_PCT) : null;
  const totalCents =
    budgetCents !== null && feeCents !== null ? budgetCents + feeCents : null;
  const titlesOk = selectedTitleIds.size > 0;
  const datesOk =
    !startsAt || !endsAt || new Date(endsAt) > new Date(startsAt);
  const allOk = nameOk && cpmOk && budgetOk && titlesOk && datesOk;

  // Active titles surface first; inactive titles are visible but
  // visually demoted and labeled — CPM only flows for active titles
  // (TitleRowControls comment), so a partner picking an inactive one
  // is a meaningful choice we want them to see clearly rather than
  // hide.
  const activeTitles = titles.filter((t) => t.is_active);
  const inactiveTitles = titles.filter((t) => !t.is_active);
  const selectedTitles = titles.filter((t) => selectedTitleIds.has(t.id));

  function toggleTitle(id: string) {
    setSelectedTitleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!allOk || submitting) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const res = await fetch(`/api/p/${partnerSlug}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          title_ids: Array.from(selectedTitleIds),
          cpm_rate_cents: cpmCents,
          budget_pool_cents: budgetCents,
          starts_at: startsAt || undefined,
          ends_at: endsAt || undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        campaign_id?: string;
      };
      if (!res.ok || !json.ok) {
        setSubmitErr(friendlyError(json.error ?? `request_failed_${res.status}`));
        setSubmitting(false);
        return;
      }
      router.refresh();
      onClose();
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : "network_error");
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
              {mode === "review" ? "Review campaign" : "New campaign"}
            </h2>
            <p className="mt-1 text-caption text-moonbeem-ink-subtle">
              {mode === "review"
                ? "Confirm the details below. Campaigns start as drafts; funding happens next."
                : "Set the rules of a CPM campaign. You can review before saving."}
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

        {mode === "edit" && (
          <>
            {/* STEP 1 — name */}
            <section className="mt-6 flex flex-col gap-2">
              <label className="text-body-sm font-medium text-moonbeem-ink">
                Campaign name
              </label>
              <input
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Summer push, Reels for opening weekend, …"
                maxLength={200}
                className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:border-moonbeem-pink focus:outline-none"
              />
            </section>

            {/* STEP 2 — title selection */}
            <section className="mt-6 flex flex-col gap-2">
              <label className="text-body-sm font-medium text-moonbeem-ink">
                Titles
              </label>
              <p className="text-caption text-moonbeem-ink-subtle">
                Pick one or more titles this campaign covers. Only active
                titles accrue CPM payouts.
              </p>
              {titles.length === 0 && (
                <p className="text-caption text-moonbeem-magenta">
                  No titles on this partner yet — attach one before
                  creating a campaign.
                </p>
              )}
              <div className="max-h-72 overflow-y-auto rounded-lg border border-white/5 bg-black/30">
                {activeTitles.map((t) => {
                  const checked = selectedTitleIds.has(t.id);
                  return (
                    <label
                      key={t.id}
                      className={`flex w-full items-center gap-3 border-b border-white/5 px-3 py-2 text-left last:border-b-0 cursor-pointer transition-colors ${
                        checked
                          ? "bg-moonbeem-pink/5"
                          : "hover:bg-white/[0.02]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTitle(t.id)}
                        className="accent-moonbeem-pink"
                      />
                      <PosterThumb
                        url={t.poster_url}
                        alt={`${t.title} poster`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body-sm text-moonbeem-ink">
                          {t.title}
                        </div>
                        <div className="font-mono text-caption text-moonbeem-ink-subtle">
                          /t/{t.slug}
                        </div>
                      </div>
                    </label>
                  );
                })}
                {inactiveTitles.map((t) => {
                  const checked = selectedTitleIds.has(t.id);
                  return (
                    <label
                      key={t.id}
                      className={`flex w-full items-center gap-3 border-b border-white/5 px-3 py-2 text-left last:border-b-0 cursor-pointer opacity-60 transition-colors ${
                        checked
                          ? "bg-moonbeem-pink/5"
                          : "hover:bg-white/[0.02]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTitle(t.id)}
                        className="accent-moonbeem-pink"
                      />
                      <PosterThumb
                        url={t.poster_url}
                        alt={`${t.title} poster`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body-sm text-moonbeem-ink">
                          {t.title}
                        </div>
                        <div className="font-mono text-caption text-moonbeem-ink-subtle">
                          /t/{t.slug}
                        </div>
                      </div>
                      <span className="rounded-full border border-white/10 px-2 py-0.5 text-caption text-moonbeem-ink-subtle">
                        inactive — no CPM
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>

            {/* STEP 3 — CPM rate */}
            <section className="mt-6 flex flex-col gap-2">
              <label className="text-body-sm font-medium text-moonbeem-ink">
                CPM rate
              </label>
              <p className="text-caption text-moonbeem-ink-subtle">
                Dollars paid per 1,000 metered views.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-body-sm text-moonbeem-ink-muted">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={cpmInput}
                  onChange={(e) => setCpmInput(e.target.value)}
                  placeholder="2.50"
                  className="w-32 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-right text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
                />
                <span className="text-caption text-moonbeem-ink-subtle">
                  per 1,000 views
                </span>
              </div>
            </section>

            {/* STEP 4 — budget pool */}
            <section className="mt-6 flex flex-col gap-2">
              <label className="text-body-sm font-medium text-moonbeem-ink">
                Budget pool
              </label>
              <p className="text-caption text-moonbeem-ink-subtle">
                The total Moonbeem will draw from to pay creators on this
                campaign. Funding happens after you save.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-body-sm text-moonbeem-ink-muted">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  placeholder="2500.00"
                  className="w-40 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-right text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
                />
                <span className="text-caption text-moonbeem-ink-subtle">
                  total
                </span>
              </div>
              {feeCents !== null && totalCents !== null && (
                <div className="mt-1 flex flex-col gap-0.5 text-caption text-moonbeem-ink-subtle">
                  <div className="flex justify-between">
                    <span>Platform fee (10%)</span>
                    <span>{formatCents(feeCents)}</span>
                  </div>
                  <div className="flex justify-between text-moonbeem-ink-muted">
                    <span>Total charged at funding</span>
                    <span>{formatCents(totalCents)}</span>
                  </div>
                </div>
              )}
            </section>

            {/* STEP 5 — optional dates */}
            <section className="mt-6 flex flex-col gap-2">
              <label className="text-body-sm font-medium text-moonbeem-ink">
                Start &amp; end (optional)
              </label>
              <p className="text-caption text-moonbeem-ink-subtle">
                Leave blank for an open-ended campaign. End must be after
                start if both are set.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
                  Start
                  <input
                    type="date"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
                  End
                  <input
                    type="date"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
                  />
                </label>
              </div>
              {!datesOk && (
                <p className="text-caption text-moonbeem-magenta">
                  End date must be after start date.
                </p>
              )}
            </section>

            <div className="mt-8 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setMode("review")}
                disabled={!allOk}
                className="rounded-md bg-moonbeem-pink px-5 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Review
              </button>
            </div>
          </>
        )}

        {mode === "review" && (
          <>
            <section className="mt-6 flex flex-col gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-4">
              <Row label="Name" value={trimmedName} />
              <Row
                label="Titles"
                value={
                  <ul className="m-0 flex flex-col gap-1 p-0 list-none">
                    {selectedTitles.map((t) => (
                      <li
                        key={t.id}
                        className="font-mono text-caption text-moonbeem-ink-subtle"
                      >
                        /t/{t.slug}{" "}
                        {!t.is_active && (
                          <span className="ml-1 text-moonbeem-magenta">
                            (inactive — no CPM)
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                }
              />
              <Row
                label="CPM rate"
                value={`${formatCents(cpmCents ?? 0)} per 1,000 views`}
              />
              <Row label="Budget pool" value={formatCents(budgetCents ?? 0)} />
              <Row
                label="Platform fee (10%)"
                value={formatCents(feeCents ?? 0)}
              />
              <Row label="Total at funding" value={formatCents(totalCents ?? 0)} />
              <Row
                label="Window"
                value={
                  startsAt || endsAt
                    ? `${startsAt || "open"} → ${endsAt || "open"}`
                    : "Open-ended"
                }
              />
            </section>

            <p className="mt-4 text-caption text-moonbeem-ink-subtle">
              A 10% platform fee is added to your budget and charged up front
              when you fund the campaign. Your full budget goes to the creator
              pool. Saving creates the campaign as a draft — you fund it in the
              next step.
            </p>

            {submitErr && (
              <p className="mt-3 text-caption text-moonbeem-magenta">
                {submitErr}
              </p>
            )}

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setMode("edit")}
                disabled={submitting}
                className="rounded-md border border-white/10 px-4 py-2 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:cursor-not-allowed disabled:opacity-50"
              >
                Back to edit
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!allOk || submitting}
                className="rounded-md bg-moonbeem-pink px-5 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? "Creating…" : "Create campaign"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-4">
      <div className="sm:w-32 text-caption text-moonbeem-ink-subtle">
        {label}
      </div>
      <div className="flex-1 text-body-sm text-moonbeem-ink">{value}</div>
    </div>
  );
}
