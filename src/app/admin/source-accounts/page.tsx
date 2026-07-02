// /admin/source-accounts — Source Accounts review surface.
//
// Super-admin only. Lists each source account with a scrape trigger and its
// pending review queue, grouped by post (caption + link rendered once, candidate
// titles beneath). All reads via the service-role client (these tables are RLS-
// enabled with no policies). Density over polish — this is an ops surface.

import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import SourceAccountsClient, {
  type AccountView,
  type PostGroup,
  type MatchView,
} from "./SourceAccountsClient";

export const metadata: Metadata = {
  title: "Source accounts — Moonbeem admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

async function fetchByIds<T>(
  supabase: ServiceClient,
  table: string,
  cols: string,
  ids: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase
      .from(table)
      .select(cols)
      .in("id", ids.slice(i, i + 100));
    if (data) out.push(...(data as T[]));
  }
  return out;
}

async function loadAccounts(): Promise<AccountView[]> {
  const supabase = createServiceRoleClient();

  const { data: accountsData } = await supabase
    .from("source_accounts")
    .select(
      "id, handle, platform, external_user_id, last_scraped_at, cursor_max_taken_at, active",
    )
    .order("created_at");
  const accounts = (accountsData ?? []) as Array<{
    id: string;
    handle: string;
    platform: string;
    external_user_id: string | null;
    last_scraped_at: string | null;
    cursor_max_taken_at: number | null;
    active: boolean;
  }>;
  if (accounts.length === 0) return [];

  const { data: pendData } = await supabase
    .from("source_account_post_matches")
    .select("id, match_confidence, source_account_post_id, matched_title_id")
    .eq("status", "pending");
  const pending = (pendData ?? []) as Array<{
    id: string;
    match_confidence: number | string;
    source_account_post_id: string;
    matched_title_id: string;
  }>;

  const postIds = Array.from(new Set(pending.map((m) => m.source_account_post_id)));
  const titleIds = Array.from(new Set(pending.map((m) => m.matched_title_id)));

  const posts = await fetchByIds<{
    id: string;
    shortcode: string;
    post_url: string;
    caption: string | null;
    taken_at: number | null;
    is_pinned: boolean;
    media_type: string | null;
    video_view_count: number | null;
    like_count: number | null;
    source_account_id: string;
  }>(
    supabase,
    "source_account_posts",
    "id, shortcode, post_url, caption, taken_at, is_pinned, media_type, video_view_count, like_count, source_account_id",
    postIds,
  );
  const titles = await fetchByIds<{
    id: string;
    slug: string;
    title: string;
    year: number | null;
    is_public: boolean;
  }>(supabase, "titles", "id, slug, title, year, is_public", titleIds);

  const postById = new Map(posts.map((p) => [p.id, p]));
  const titleById = new Map(titles.map((t) => [t.id, t]));

  // Total scraped posts per account (cheap head:exact count).
  const totalByAccount = new Map<string, number>();
  await Promise.all(
    accounts.map(async (a) => {
      const { count } = await supabase
        .from("source_account_posts")
        .select("id", { count: "exact", head: true })
        .eq("source_account_id", a.id);
      totalByAccount.set(a.id, count ?? 0);
    }),
  );

  // Group pending matches -> post -> account.
  const groupsByAccount = new Map<string, Map<string, PostGroup>>();
  for (const m of pending) {
    const post = postById.get(m.source_account_post_id);
    if (!post) continue;
    const title = titleById.get(m.matched_title_id);
    if (!title) continue;
    let byPost = groupsByAccount.get(post.source_account_id);
    if (!byPost) {
      byPost = new Map();
      groupsByAccount.set(post.source_account_id, byPost);
    }
    let grp = byPost.get(post.id);
    if (!grp) {
      grp = {
        id: post.id,
        shortcode: post.shortcode,
        post_url: post.post_url,
        caption: post.caption,
        taken_at: post.taken_at,
        is_pinned: post.is_pinned,
        media_type: post.media_type,
        video_view_count: post.video_view_count,
        like_count: post.like_count,
        matches: [],
      };
      byPost.set(post.id, grp);
    }
    const match: MatchView = {
      id: m.id,
      confidence: Number(m.match_confidence),
      title,
    };
    grp.matches.push(match);
  }

  return accounts.map((a) => {
    const byPost = groupsByAccount.get(a.id) ?? new Map<string, PostGroup>();
    const groups = Array.from(byPost.values())
      .map((g) => ({
        ...g,
        matches: g.matches.sort((x, y) => y.confidence - x.confidence),
      }))
      .sort((x, y) => (y.taken_at ?? 0) - (x.taken_at ?? 0));
    const pendingMatches = groups.reduce((s, g) => s + g.matches.length, 0);
    return {
      id: a.id,
      handle: a.handle,
      platform: a.platform,
      external_user_id: a.external_user_id,
      last_scraped_at: a.last_scraped_at,
      cursor_max_taken_at: a.cursor_max_taken_at,
      active: a.active,
      total_posts: totalByAccount.get(a.id) ?? 0,
      pending_posts: groups.length,
      pending_matches: pendingMatches,
      groups,
    };
  });
}

export default async function Page() {
  await requireSuperAdmin();
  const accounts = await loadAccounts();
  return <SourceAccountsClient accounts={accounts} />;
}
