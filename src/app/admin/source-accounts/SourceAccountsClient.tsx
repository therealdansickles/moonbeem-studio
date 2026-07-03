"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import TitlePicker, { type TitleHit } from "@/components/admin/TitlePicker";

export type MatchView = {
  id: string;
  confidence: number;
  title: {
    id: string;
    slug: string;
    title: string;
    year: number | null;
    is_public: boolean;
  };
};

export type PostGroup = {
  id: string;
  shortcode: string;
  post_url: string;
  caption: string | null;
  taken_at: number | null;
  is_pinned: boolean;
  media_type: string | null;
  video_view_count: number | null;
  like_count: number | null;
  matches: MatchView[];
};

export type AccountView = {
  id: string;
  handle: string;
  platform: string;
  external_user_id: string | null;
  last_scraped_at: string | null;
  cursor_max_taken_at: number | null;
  active: boolean;
  total_posts: number;
  pending_posts: number;
  pending_matches: number;
  groups: PostGroup[];
};

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function unixDate(sec: number | null): string {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleDateString();
}

function pct(conf: number): string {
  return `${Math.round(conf * 100)}%`;
}

function count(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function filterCls(active: boolean): string {
  return active
    ? "rounded-md border border-moonbeem-pink bg-moonbeem-pink/15 px-3 py-1 text-body-sm text-moonbeem-pink"
    : "rounded-md border border-white/15 px-3 py-1 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink";
}

export default function SourceAccountsClient({
  accounts: initial,
}: {
  accounts: AccountView[];
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountView[]>(initial);
  const [busyMatch, setBusyMatch] = useState<string | null>(null);
  const [scrapingId, setScrapingId] = useState<string | null>(null);
  const [scrapeMsg, setScrapeMsg] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [addHandle, setAddHandle] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [correctingMatchId, setCorrectingMatchId] = useState<string | null>(null);

  // Sync from the server whenever router.refresh() (after a scrape) delivers fresh
  // props. useState(initial) alone seeds ONCE at mount, so without this the client
  // keeps rendering the pre-scrape snapshot even though the rows persisted — that
  // was the "nothing persisted" acceptance failure: the writes landed, the queue
  // just never repainted. Confirmed/rejected matches are DB-status-changed, so the
  // fresh server props already exclude them and this reset stays consistent.
  useEffect(() => {
    setAccounts(initial);
  }, [initial]);

  function removeMatch(accountId: string, groupId: string, matchId: string) {
    setAccounts((prev) =>
      prev.map((a) => {
        if (a.id !== accountId) return a;
        const groups = a.groups
          .map((g) =>
            g.id === groupId
              ? { ...g, matches: g.matches.filter((m) => m.id !== matchId) }
              : g,
          )
          .filter((g) => g.matches.length > 0);
        const pending_matches = groups.reduce((s, g) => s + g.matches.length, 0);
        return { ...a, groups, pending_posts: groups.length, pending_matches };
      }),
    );
  }

  async function decide(
    account: AccountView,
    group: PostGroup,
    match: MatchView,
    action: "confirm" | "reject",
  ) {
    if (busyMatch) return;
    setBusyMatch(match.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/source-accounts/matches/${match.id}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? `${action} failed`);
        return;
      }
      removeMatch(account.id, group.id, match.id);
    } finally {
      setBusyMatch(null);
    }
  }

  async function scrape(account: AccountView, mode: "backfill" | "incremental") {
    if (scrapingId) return;
    setScrapingId(account.id);
    setError(null);
    setScrapeMsg((m) => ({ ...m, [account.id]: "Scraping… (this can take a minute)" }));
    try {
      const res = await fetch(`/api/admin/source-accounts/${account.id}/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const parts = [json.error, json.category, json.detail]
          .filter(Boolean)
          .join(" · ");
        setScrapeMsg((m) => ({
          ...m,
          [account.id]: json.message ?? (parts || "scrape failed"),
        }));
        return;
      }
      // DB-CONFIRMED counts (post-write SELECT), not in-memory tallies. Incremental
      // stops at the cursor — leftover older posts are not a truncation — so it never
      // shows TRUNCATED; that stays reserved for a backfill that didn't fully drain.
      const dbLine = `DB-confirmed: ${json.dbPostsTotal} posts in queue · ${json.dbPendingMatches} pending matches`;
      const run = `${json.fetched} fetched, ${json.matchesInserted} new`;
      let runLine: string;
      if (json.mode === "incremental") {
        runLine = json.truncated
          ? `Partial — a burst exceeded one pass; cursor held, run again or backfill. ${dbLine}. (${run})`
          : `Up to date — caught up to cursor. ${dbLine}. (${run})`;
      } else {
        runLine = `Done — ${dbLine}. (this run: ${run}${json.truncated ? ", TRUNCATED — more remain" : ""})`;
      }
      setScrapeMsg((m) => ({ ...m, [account.id]: runLine }));
      // Reload the server queue with the freshly-inserted pending matches.
      router.refresh();
    } finally {
      setScrapingId(null);
    }
  }

  async function createAccount(e: FormEvent) {
    e.preventDefault();
    if (addBusy) return;
    const handle = addHandle.trim().replace(/^@+/, "");
    if (!handle) return;
    setAddBusy(true);
    setAddMsg(null);
    try {
      const res = await fetch("/api/admin/source-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAddMsg(json.message ?? json.error ?? "Could not add account.");
        return;
      }
      setAddHandle("");
      setAddMsg(`Added @${handle}. Run backfill to seed it.`);
      router.refresh();
    } finally {
      setAddBusy(false);
    }
  }

  async function toggleActive(account: AccountView) {
    if (togglingId) return;
    setTogglingId(account.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/source-accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !account.active }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "Could not update account.");
        return;
      }
      router.refresh();
    } finally {
      setTogglingId(null);
    }
  }

  async function confirmOverride(
    account: AccountView,
    group: PostGroup,
    match: MatchView,
    hit: TitleHit,
  ) {
    if (busyMatch) return;
    setBusyMatch(match.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/source-accounts/matches/${match.id}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title_id: hit.id }),
        },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "Could not correct the title.");
        return;
      }
      setCorrectingMatchId(null);
      removeMatch(account.id, group.id, match.id);
    } finally {
      setBusyMatch(null);
    }
  }

  const totalPending = accounts.reduce((s, a) => s + a.pending_matches, 0);
  const queueItems = accounts
    .filter((a) => selectedAccountId == null || a.id === selectedAccountId)
    .flatMap((a) => a.groups.map((group) => ({ account: a, group })));

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-body-sm uppercase tracking-wider text-moonbeem-ink-subtle">
              Admin — discovery
            </p>
            <h1 className="m-0 font-wordmark text-display-md font-bold text-moonbeem-pink">
              Source accounts
            </h1>
            <p className="text-body-sm text-moonbeem-ink-muted">
              Scrape curator accounts · caption→catalog matches await review
            </p>
          </div>
          <Link
            href="/admin"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Admin
          </Link>
        </div>

        <form
          onSubmit={createAccount}
          className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.02] p-5"
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-caption uppercase tracking-wider text-moonbeem-ink-subtle">
                Platform
              </span>
              <select
                disabled
                value="instagram"
                className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted"
              >
                <option value="instagram">instagram</option>
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-caption uppercase tracking-wider text-moonbeem-ink-subtle">
                Handle
              </span>
              <input
                type="text"
                value={addHandle}
                onChange={(e) => setAddHandle(e.target.value)}
                placeholder="curatorhandle"
                className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink placeholder:text-moonbeem-ink-subtle"
              />
            </label>
            <button
              type="submit"
              disabled={addBusy || addHandle.trim() === ""}
              className="rounded-md border border-moonbeem-pink/40 bg-moonbeem-pink/10 px-3 py-1.5 text-body-sm text-moonbeem-pink hover:bg-moonbeem-pink/20 disabled:opacity-40"
            >
              {addBusy ? "Adding…" : "Add account"}
            </button>
          </div>
          <p className="m-0 text-caption text-moonbeem-ink-subtle">
            New accounts need one Backfill (all) to seed the cursor before the weekly
            cron maintains them.
          </p>
          {addMsg && (
            <p className="m-0 text-caption text-moonbeem-ink-muted">{addMsg}</p>
          )}
        </form>

        {error && (
          <div className="rounded-md border border-moonbeem-magenta/40 bg-moonbeem-magenta/10 px-3 py-2 text-body-sm text-moonbeem-magenta">
            {error}
          </div>
        )}

        {/* Roster — compact account cards */}
        <section className="flex flex-col gap-3">
          <h2 className="m-0 text-heading-sm text-moonbeem-ink">Roster</h2>
          {accounts.length === 0 ? (
            <p className="rounded-md border border-white/10 bg-white/[0.02] p-6 text-body-sm text-moonbeem-ink-muted">
              No source accounts yet. Add one above.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {accounts.map((account) => (
                <div
                  key={account.id}
                  className="rounded-2xl border border-white/10 bg-white/[0.02] p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-moonbeem-violet/20 px-2.5 py-0.5 text-caption font-medium text-moonbeem-violet-soft">
                          {account.platform}
                        </span>
                        <span className="text-body font-medium text-moonbeem-ink">
                          @{account.handle}
                        </span>
                        {!account.active && (
                          <span className="rounded-full bg-white/10 px-2 py-0.5 text-caption text-moonbeem-ink-subtle">
                            inactive
                          </span>
                        )}
                      </div>
                      <p className="text-caption text-moonbeem-ink-subtle">
                        user id {account.external_user_id ?? "unresolved"} · last scraped{" "}
                        {timeAgo(account.last_scraped_at)} · cursor{" "}
                        {unixDate(account.cursor_max_taken_at)} · {account.total_posts}{" "}
                        posts scraped
                      </p>
                      <p className="text-body-sm text-moonbeem-ink-muted">
                        {account.pending_matches} pending match
                        {account.pending_matches === 1 ? "" : "es"} across{" "}
                        {account.pending_posts} post
                        {account.pending_posts === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => scrape(account, "backfill")}
                          disabled={scrapingId === account.id}
                          className="rounded-md border border-moonbeem-pink/40 bg-moonbeem-pink/10 px-3 py-1.5 text-body-sm text-moonbeem-pink hover:bg-moonbeem-pink/20 disabled:opacity-40"
                        >
                          {scrapingId === account.id ? "Scraping…" : "Backfill (all)"}
                        </button>
                        <button
                          type="button"
                          onClick={() => scrape(account, "incremental")}
                          disabled={scrapingId === account.id}
                          className="rounded-md border border-white/15 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40"
                        >
                          Scrape new
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleActive(account)}
                          disabled={togglingId === account.id}
                          className="rounded-md border border-white/15 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40"
                        >
                          {togglingId === account.id
                            ? "Saving…"
                            : account.active
                              ? "Deactivate"
                              : "Activate"}
                        </button>
                      </div>
                      {scrapeMsg[account.id] && (
                        <p className="max-w-xs text-right text-caption text-moonbeem-ink-subtle">
                          {scrapeMsg[account.id]}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Review queue — post-grouped, filterable by account (defaults to All) */}
        <section className="flex flex-col gap-3">
          <h2 className="m-0 text-heading-sm text-moonbeem-ink">Review queue</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSelectedAccountId(null)}
              className={filterCls(selectedAccountId === null)}
            >
              All ({totalPending})
            </button>
            {accounts
              .filter((a) => a.pending_matches > 0)
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedAccountId(a.id)}
                  className={filterCls(selectedAccountId === a.id)}
                >
                  @{a.handle} ({a.pending_matches})
                </button>
              ))}
          </div>
          {queueItems.length === 0 ? (
            <p className="rounded-md border border-white/10 bg-white/[0.02] p-5 text-body-sm text-moonbeem-ink-muted">
              No pending matches{selectedAccountId ? " for this account" : ""}. Run a
              scrape to populate the queue.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {queueItems.map(({ account, group }) => (
                <li
                  key={group.id}
                  className="flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.02] p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-caption uppercase tracking-wider text-moonbeem-ink-subtle">
                        <span className="rounded-full bg-moonbeem-violet/20 px-2 py-0.5 text-moonbeem-violet-soft normal-case">
                          @{account.handle}
                        </span>
                        {group.is_pinned && (
                          <span className="rounded-full bg-moonbeem-violet/20 px-2 py-0.5 text-moonbeem-violet-soft normal-case">
                            pinned
                          </span>
                        )}
                        <span>{group.media_type ?? "post"}</span>
                        <span>· {unixDate(group.taken_at)}</span>
                        <span>· {count(group.video_view_count)} views</span>
                        <span>· {count(group.like_count)} likes</span>
                      </p>
                      {group.caption && (
                        <p className="mt-1 line-clamp-3 whitespace-pre-line text-body-sm text-moonbeem-ink-muted">
                          {group.caption}
                        </p>
                      )}
                      <a
                        href={group.post_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block truncate text-caption text-moonbeem-ink-subtle hover:text-moonbeem-pink"
                      >
                        {group.post_url}
                      </a>
                    </div>
                  </div>

                  <ul className="flex flex-col divide-y divide-white/5 border-t border-white/5">
                    {group.matches.map((match) => (
                      <li key={match.id} className="flex flex-col gap-2 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <Link
                              href={`/t/${match.title.slug}`}
                              target="_blank"
                              className="text-body-sm text-moonbeem-ink hover:text-moonbeem-pink"
                            >
                              {match.title.title}
                            </Link>
                            <span className="ml-2 text-caption text-moonbeem-ink-subtle">
                              {match.title.year ?? "—"} ·{" "}
                              <span
                                className={
                                  match.title.is_public
                                    ? "text-emerald-300"
                                    : "text-moonbeem-ink-subtle"
                                }
                              >
                                {match.title.is_public ? "Live" : "Catalog"}
                              </span>{" "}
                              · {pct(match.confidence)} match
                            </span>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              onClick={() => decide(account, group, match, "confirm")}
                              disabled={busyMatch === match.id}
                              className="rounded-md border border-emerald-700 bg-emerald-950/40 px-3 py-1 text-body-sm text-emerald-300 hover:bg-emerald-950/60 disabled:opacity-40"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setCorrectingMatchId(
                                  correctingMatchId === match.id ? null : match.id,
                                )
                              }
                              disabled={busyMatch === match.id}
                              className="rounded-md border border-white/15 px-3 py-1 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40"
                            >
                              {correctingMatchId === match.id ? "Close" : "Correct title"}
                            </button>
                            <button
                              type="button"
                              onClick={() => decide(account, group, match, "reject")}
                              disabled={busyMatch === match.id}
                              className="rounded-md border border-white/15 px-3 py-1 text-body-sm text-moonbeem-ink-muted hover:border-moonbeem-magenta hover:text-moonbeem-magenta disabled:opacity-40"
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                        {correctingMatchId === match.id && (
                          <TitlePicker
                            busy={busyMatch === match.id}
                            onCancel={() => setCorrectingMatchId(null)}
                            onPick={(hit) => confirmOverride(account, group, match, hit)}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
