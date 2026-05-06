import { createClient } from "@/lib/supabase/server";

export type ProfileLink = { label: string; url: string };

export type Profile = {
  creator_id: string;
  user_id: string | null;
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  links: ProfileLink[];
  is_stub: boolean;
};

export type TopTitle = {
  id: string;
  user_id: string;
  title_id: string;
  position: number;
  title: {
    id: string;
    slug: string;
    title: string;
    poster_url: string | null;
  };
};

type RawLink = { label?: unknown; url?: unknown };

function normalizeLinks(raw: unknown): ProfileLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): ProfileLink | null => {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as RawLink;
      const label = typeof e.label === "string" ? e.label.trim() : "";
      const url = typeof e.url === "string" ? e.url.trim() : "";
      if (!label || !url) return null;
      return { label, url };
    })
    .filter((v): v is ProfileLink => v !== null)
    .slice(0, 5);
}

export async function getProfileByHandle(
  handle: string,
): Promise<Profile | null> {
  const cleaned = handle.trim().toLowerCase();
  if (!cleaned) return null;
  const supabase = await createClient();

  const { data: creator, error: cErr } = await supabase
    .from("public_creators")
    .select("id, user_id, moonbeem_handle, is_stub")
    .eq("moonbeem_handle", cleaned)
    .maybeSingle();
  if (cErr || !creator) return null;

  const creatorId = creator.id as string;
  const userId = (creator.user_id as string | null) ?? null;
  const moonbeemHandle = creator.moonbeem_handle as string;
  const isStub = Boolean(creator.is_stub);

  if (!userId) {
    return {
      creator_id: creatorId,
      user_id: null,
      handle: moonbeemHandle,
      display_name: null,
      bio: null,
      avatar_url: null,
      links: [],
      is_stub: isStub,
    };
  }

  const { data: user } = await supabase
    .from("public_profiles")
    .select("display_name, bio, avatar_url, links")
    .eq("id", userId)
    .maybeSingle();

  return {
    creator_id: creatorId,
    user_id: userId,
    handle: moonbeemHandle,
    display_name: (user?.display_name ?? null) as string | null,
    bio: (user?.bio ?? null) as string | null,
    avatar_url: (user?.avatar_url ?? null) as string | null,
    links: normalizeLinks(user?.links),
    is_stub: isStub,
  };
}

type TopTitleJoinRow = {
  id: string;
  user_id: string;
  title_id: string;
  position: number;
  titles: {
    id: string;
    slug: string;
    title: string;
    poster_url: string | null;
  } | null;
};

export async function getTopTitlesForUser(
  userId: string,
): Promise<TopTitle[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_top_titles")
    .select(
      "id, user_id, title_id, position, titles:title_id(id, slug, title, poster_url)",
    )
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (error || !data) return [];
  return (data as unknown as TopTitleJoinRow[])
    .filter((r) => r.titles)
    .map((r) => ({
      id: r.id,
      user_id: r.user_id,
      title_id: r.title_id,
      position: r.position,
      title: r.titles!,
    }));
}
