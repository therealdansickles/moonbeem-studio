import Link from "next/link";
import { requireSuperAdmin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

type StatRow = {
  title_id: string;
  request_type: string;
  slug: string;
  title: string;
  request_count: number;
  latest_request_at: string;
};

type RequesterRow = {
  title_id: string;
  request_type: string;
  user_id: string | null;
  requested_at: string;
};

type UserRow = {
  id: string;
  handle: string | null;
  email: string | null;
};

const TYPE_LABEL: Record<string, string> = {
  fan_edits: "Fan edits",
  clips_and_stills: "Clips & stills",
};

export default async function AdminRequestsPage() {
  await requireSuperAdmin();
  const supabase = await createClient();

  const { data: stats } = await supabase
    .from("admin_title_request_stats")
    .select("*")
    .order("request_count", { ascending: false })
    .limit(200);

  const rows = (stats ?? []) as StatRow[];

  const titleIds = rows.map((r) => r.title_id);
  const recentByKey = new Map<string, RequesterRow[]>();
  const userById = new Map<string, UserRow>();

  if (titleIds.length > 0) {
    const { data: requesters } = await supabase
      .from("title_requests")
      .select("title_id, request_type, user_id, requested_at")
      .in("title_id", titleIds)
      .order("requested_at", { ascending: false });

    for (const r of (requesters ?? []) as RequesterRow[]) {
      const key = `${r.title_id}:${r.request_type}`;
      const arr = recentByKey.get(key) ?? [];
      if (arr.length < 10) {
        arr.push(r);
        recentByKey.set(key, arr);
      }
    }

    const userIds = Array.from(
      new Set(
        Array.from(recentByKey.values())
          .flat()
          .map((r) => r.user_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, handle, email")
        .in("id", userIds);
      for (const u of (users ?? []) as UserRow[]) {
        userById.set(u.id, u);
      }
    }
  }

  return (
    <div className="min-h-screen px-6 py-12 bg-moonbeem-black text-moonbeem-ink">
      <div className="max-w-4xl mx-auto flex flex-col gap-8">
        <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
          Title requests
        </h1>
        {rows.length === 0 ? (
          <p className="text-body text-moonbeem-ink-muted">
            No requests yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-6">
            {rows.map((row) => {
              const key = `${row.title_id}:${row.request_type}`;
              const recent = recentByKey.get(key) ?? [];
              const typeLabel = TYPE_LABEL[row.request_type] ?? row.request_type;
              return (
                <li
                  key={key}
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
                      Most recent:{" "}
                      {new Date(row.latest_request_at).toLocaleString()}
                    </span>
                  </div>
                  {recent.length > 0 && (
                    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-body-sm text-moonbeem-ink-muted">
                      {recent.map((r, idx) => {
                        const u = r.user_id ? userById.get(r.user_id) : null;
                        const label = u?.handle
                          ? `@${u.handle}`
                          : (u?.email ?? "anonymous");
                        return <li key={`${key}-${idx}`}>{label}</li>;
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
