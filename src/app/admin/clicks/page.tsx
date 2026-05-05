// /admin/clicks — internal rollup of /go/ click telemetry.
//
// Three sections, plain tables, monospace numbers. Super-admin only
// via requireSuperAdmin; same gate as /admin/requests.
//
// Aggregations are JS-side over rows pulled from external_clicks
// with a generous fetch cap. At zero/low volume this is fine; if the
// table grows past ~100K rows over 30 days we'll move the rollups to
// SQL functions or a materialized view. Cap is informational —
// surfaced in the UI when reached so we know to upgrade.

import Link from "next/link";
import { requireSuperAdmin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

const FETCH_CAP = 100_000;
const TOP_N = 20;

type Click7d = {
  clicked_at: string;
  is_bot: boolean;
};

type TitleClickRow = {
  title_id: string;
  titles: { title: string; slug: string } | null;
};

type DirectCreatorClickRow = {
  creator_id: string | null;
  creators: { moonbeem_handle: string } | null;
};

type AffiliateClickRow = {
  affiliate_link_id: string | null;
  affiliate_links:
    | {
        creator_id: string | null;
        creators: { moonbeem_handle: string } | null;
      }
    | null;
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function AdminClicksPage() {
  await requireSuperAdmin();
  const supabase = await createClient();

  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  // ---- Section 1: clicks last 7 days, human vs bot ----
  const last7Result = await supabase
    .from("external_clicks")
    .select("clicked_at, is_bot")
    .gte("clicked_at", sevenDaysAgo)
    .limit(FETCH_CAP);

  const last7Rows = (last7Result.data ?? []) as Click7d[];
  const last7Truncated = last7Rows.length >= FETCH_CAP;

  const dailyMap = new Map<string, { humans: number; bots: number }>();
  for (const r of last7Rows) {
    const day = r.clicked_at.slice(0, 10);
    const entry = dailyMap.get(day) ?? { humans: 0, bots: 0 };
    if (r.is_bot) entry.bots += 1;
    else entry.humans += 1;
    dailyMap.set(day, entry);
  }
  const days7: { day: string; humans: number; bots: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = isoDay(d);
    const entry = dailyMap.get(key) ?? { humans: 0, bots: 0 };
    days7.push({ day: key, humans: entry.humans, bots: entry.bots });
  }

  // ---- Section 2: top titles by human clicks last 30 days ----
  const titleResult = await supabase
    .from("external_clicks")
    .select("title_id, titles(title, slug)")
    .eq("is_bot", false)
    .gte("clicked_at", thirtyDaysAgo)
    .limit(FETCH_CAP);

  const titleRows = (titleResult.data ?? []) as unknown as TitleClickRow[];
  const titleTruncated = titleRows.length >= FETCH_CAP;

  const titleMap = new Map<
    string,
    { title: string; slug: string; count: number }
  >();
  for (const r of titleRows) {
    const tid = r.title_id;
    const title = r.titles?.title ?? "(unknown)";
    const slug = r.titles?.slug ?? "";
    const entry = titleMap.get(tid) ?? { title, slug, count: 0 };
    entry.count += 1;
    titleMap.set(tid, entry);
  }
  const topTitles = Array.from(titleMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);

  // ---- Section 3: top creators by attributed human clicks last 30 days ----
  // Two sources of attribution:
  //   - external_clicks.creator_id (Flow B direct attribution)
  //   - external_clicks.affiliate_link_id -> affiliate_links.creator_id (Flow C)
  // Merge counts in JS.
  const directResult = await supabase
    .from("external_clicks")
    .select("creator_id, creators(moonbeem_handle)")
    .eq("is_bot", false)
    .gte("clicked_at", thirtyDaysAgo)
    .not("creator_id", "is", null)
    .limit(FETCH_CAP);

  const affiliateResult = await supabase
    .from("external_clicks")
    .select(
      "affiliate_link_id, affiliate_links(creator_id, creators(moonbeem_handle))",
    )
    .eq("is_bot", false)
    .gte("clicked_at", thirtyDaysAgo)
    .not("affiliate_link_id", "is", null)
    .limit(FETCH_CAP);

  const directRows = (directResult.data ?? []) as unknown as DirectCreatorClickRow[];
  const affiliateRows =
    (affiliateResult.data ?? []) as unknown as AffiliateClickRow[];
  const creatorTruncated =
    directRows.length >= FETCH_CAP || affiliateRows.length >= FETCH_CAP;

  const creatorMap = new Map<string, { handle: string; count: number }>();
  for (const r of directRows) {
    const cid = r.creator_id;
    if (!cid) continue;
    const handle = r.creators?.moonbeem_handle ?? "(unknown)";
    const entry = creatorMap.get(cid) ?? { handle, count: 0 };
    entry.count += 1;
    creatorMap.set(cid, entry);
  }
  for (const r of affiliateRows) {
    const cid = r.affiliate_links?.creator_id ?? null;
    if (!cid) continue;
    const handle =
      r.affiliate_links?.creators?.moonbeem_handle ?? "(unknown)";
    const entry = creatorMap.get(cid) ?? { handle, count: 0 };
    entry.count += 1;
    creatorMap.set(cid, entry);
  }
  const topCreators = Array.from(creatorMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);

  return (
    <div className="min-h-screen px-6 py-12 bg-moonbeem-black text-moonbeem-ink">
      <div className="max-w-4xl mx-auto flex flex-col gap-10">
        <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
          Clicks
        </h1>

        <section className="flex flex-col gap-3">
          <h2 className="text-body-lg font-semibold text-moonbeem-ink m-0">
            Last 7 days (humans vs bots)
          </h2>
          {last7Truncated && (
            <p className="text-body-sm text-moonbeem-magenta">
              Note: fetch capped at {FETCH_CAP.toLocaleString()} rows; counts
              are biased toward most recent. Move to SQL aggregation when
              this matters.
            </p>
          )}
          <table className="w-full border-collapse font-mono text-body-sm">
            <thead>
              <tr className="border-b border-moonbeem-border-strong text-left">
                <th className="py-2 pr-4">Day (UTC)</th>
                <th className="py-2 pr-4 text-right">Humans</th>
                <th className="py-2 pr-4 text-right">Bots</th>
              </tr>
            </thead>
            <tbody>
              {days7.map((d) => (
                <tr key={d.day} className="border-b border-moonbeem-border">
                  <td className="py-2 pr-4">{d.day}</td>
                  <td className="py-2 pr-4 text-right">{d.humans}</td>
                  <td className="py-2 pr-4 text-right text-moonbeem-ink-subtle">
                    {d.bots}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-body-lg font-semibold text-moonbeem-ink m-0">
            Top titles by human clicks (last 30 days)
          </h2>
          {titleTruncated && (
            <p className="text-body-sm text-moonbeem-magenta">
              Note: fetch capped at {FETCH_CAP.toLocaleString()} rows.
            </p>
          )}
          {topTitles.length === 0 ? (
            <p className="text-body-sm text-moonbeem-ink-muted">
              No human clicks in the last 30 days yet.
            </p>
          ) : (
            <table className="w-full border-collapse font-mono text-body-sm">
              <thead>
                <tr className="border-b border-moonbeem-border-strong text-left">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4 text-right">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {topTitles.map((t) => (
                  <tr
                    key={t.slug || t.title}
                    className="border-b border-moonbeem-border"
                  >
                    <td className="py-2 pr-4">
                      {t.slug ? (
                        <Link
                          href={`/t/${t.slug}`}
                          className="hover:text-moonbeem-pink transition-colors"
                        >
                          {t.title}
                        </Link>
                      ) : (
                        t.title
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right">{t.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-body-lg font-semibold text-moonbeem-ink m-0">
            Top creators by attributed human clicks (last 30 days)
          </h2>
          {creatorTruncated && (
            <p className="text-body-sm text-moonbeem-magenta">
              Note: fetch capped at {FETCH_CAP.toLocaleString()} rows
              per source.
            </p>
          )}
          {topCreators.length === 0 ? (
            <p className="text-body-sm text-moonbeem-ink-muted">
              No attributed human clicks in the last 30 days yet.
            </p>
          ) : (
            <table className="w-full border-collapse font-mono text-body-sm">
              <thead>
                <tr className="border-b border-moonbeem-border-strong text-left">
                  <th className="py-2 pr-4">Handle</th>
                  <th className="py-2 pr-4 text-right">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {topCreators.map((c) => (
                  <tr
                    key={c.handle}
                    className="border-b border-moonbeem-border"
                  >
                    <td className="py-2 pr-4">@{c.handle}</td>
                    <td className="py-2 pr-4 text-right">{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
