import Link from "next/link";
import { requireSuperAdmin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

type RawRequest = {
  title_id: string;
  request_type: string;
  user_id: string | null;
  requested_at: string;
  fulfilled_at: string | null;
};

type TitleRow = {
  id: string;
  slug: string;
  title: string;
};

type UserRow = {
  id: string;
  handle: string | null;
  email: string | null;
};

type AggregatedRow = {
  key: string;
  title_id: string;
  request_type: string;
  slug: string;
  title: string;
  request_count: number;
  latest_at: string;
  recent: RawRequest[];
};

const TYPE_LABEL: Record<string, string> = {
  fan_edits: "Fan edits",
  clips_and_stills: "Clips & stills",
};

const RECENTLY_FULFILLED_DAYS = 30;
const RECENTLY_FULFILLED_MAX_CARDS = 20;

function aggregate(
  rows: RawRequest[],
  titleById: Map<string, TitleRow>,
  sortBy: "request_count" | "latest_fulfilled",
): AggregatedRow[] {
  const byKey = new Map<string, AggregatedRow>();
  for (const r of rows) {
    const t = titleById.get(r.title_id);
    if (!t) continue;
    const key = `${r.title_id}:${r.request_type}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        key,
        title_id: r.title_id,
        request_type: r.request_type,
        slug: t.slug,
        title: t.title,
        request_count: 0,
        latest_at: "",
        recent: [],
      };
      byKey.set(key, agg);
    }
    agg.request_count += 1;
    const ts =
      sortBy === "latest_fulfilled" && r.fulfilled_at
        ? r.fulfilled_at
        : r.requested_at;
    if (!agg.latest_at || ts > agg.latest_at) agg.latest_at = ts;
    if (agg.recent.length < 10) agg.recent.push(r);
  }
  const out = Array.from(byKey.values());
  if (sortBy === "request_count") {
    out.sort((a, b) => {
      if (b.request_count !== a.request_count) {
        return b.request_count - a.request_count;
      }
      return a.title.localeCompare(b.title);
    });
  } else {
    out.sort((a, b) => (b.latest_at > a.latest_at ? 1 : -1));
  }
  return out;
}

export default async function AdminRequestsPage() {
  await requireSuperAdmin();
  const supabase = await createClient();

  const cutoff = new Date(
    Date.now() - RECENTLY_FULFILLED_DAYS * 86400_000,
  ).toISOString();

  const { data: openRows } = await supabase
    .from("title_requests")
    .select("title_id, request_type, user_id, requested_at, fulfilled_at")
    .is("fulfilled_at", null)
    .order("requested_at", { ascending: false })
    .limit(2000);

  const { data: fulfilledRows } = await supabase
    .from("title_requests")
    .select("title_id, request_type, user_id, requested_at, fulfilled_at")
    .not("fulfilled_at", "is", null)
    .gte("fulfilled_at", cutoff)
    .order("fulfilled_at", { ascending: false })
    .limit(2000);

  const allRows = [
    ...((openRows ?? []) as RawRequest[]),
    ...((fulfilledRows ?? []) as RawRequest[]),
  ];

  const titleIds = Array.from(new Set(allRows.map((r) => r.title_id)));
  const userIds = Array.from(
    new Set(
      allRows
        .map((r) => r.user_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const titleById = new Map<string, TitleRow>();
  if (titleIds.length > 0) {
    const { data: titles } = await supabase
      .from("titles")
      .select("id, slug, title")
      .in("id", titleIds);
    for (const t of (titles ?? []) as TitleRow[]) titleById.set(t.id, t);
  }

  const userById = new Map<string, UserRow>();
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("id, handle, email")
      .in("id", userIds);
    for (const u of (users ?? []) as UserRow[]) userById.set(u.id, u);
  }

  const openAgg = aggregate(
    (openRows ?? []) as RawRequest[],
    titleById,
    "request_count",
  );
  const fulfilledAgg = aggregate(
    (fulfilledRows ?? []) as RawRequest[],
    titleById,
    "latest_fulfilled",
  ).slice(0, RECENTLY_FULFILLED_MAX_CARDS);

  return (
    <div className="min-h-screen px-6 py-12 bg-moonbeem-black text-moonbeem-ink">
      <div className="max-w-4xl mx-auto flex flex-col gap-10">
        <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
          Title requests
        </h1>

        <Section
          heading="Open requests"
          rows={openAgg}
          userById={userById}
          emptyMessage="No open requests."
          dateLabel="Most recent"
        />

        {fulfilledAgg.length > 0 && (
          <Section
            heading="Recently fulfilled"
            rows={fulfilledAgg}
            userById={userById}
            emptyMessage=""
            dateLabel="Fulfilled"
          />
        )}
      </div>
    </div>
  );
}

function Section({
  heading,
  rows,
  userById,
  emptyMessage,
  dateLabel,
}: {
  heading: string;
  rows: AggregatedRow[];
  userById: Map<string, UserRow>;
  emptyMessage: string;
  dateLabel: string;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-display-sm text-moonbeem-ink m-0">{heading}</h2>
      {rows.length === 0 ? (
        <p className="text-body text-moonbeem-ink-muted">{emptyMessage}</p>
      ) : (
        <ul className="flex flex-col gap-6">
          {rows.map((row) => {
            const typeLabel = TYPE_LABEL[row.request_type] ?? row.request_type;
            return (
              <li
                key={row.key}
                className="border border-moonbeem-border-strong rounded-md p-4 flex flex-col gap-2"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <Link
                    href={`/t/${row.slug}`}
                    className="text-body-lg font-semibold text-moonbeem-ink hover:text-moonbeem-pink transition-colors"
                  >
                    {row.title}
                  </Link>
                  <span className="text-body-sm text-moonbeem-ink-muted whitespace-nowrap">
                    {row.request_count} request
                    {row.request_count === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="text-body-sm text-moonbeem-ink-subtle flex gap-3">
                  <span className="text-moonbeem-pink">{typeLabel}</span>
                  <span>
                    {dateLabel}: {new Date(row.latest_at).toLocaleString()}
                  </span>
                </div>
                {row.recent.length > 0 && (
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 text-body-sm text-moonbeem-ink-muted">
                    {row.recent.map((r, idx) => {
                      const u = r.user_id ? userById.get(r.user_id) : null;
                      const label = u?.handle
                        ? `@${u.handle}`
                        : (u?.email ?? "anonymous");
                      return <li key={`${row.key}-${idx}`}>{label}</li>;
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
