export type OembedResult = {
  thumbnail_url: string | null;
  creator_handle: string | null;
  creator_url: string | null;
};

const EMPTY: OembedResult = {
  thumbnail_url: null,
  creator_handle: null,
  creator_url: null,
};

function handleFromAuthorUrl(authorUrl: string | null | undefined): string | null {
  if (!authorUrl) return null;
  try {
    const u = new URL(authorUrl);
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (!seg) return null;
    const stripped = seg.replace(/^@/, "");
    return stripped ? `@${stripped}` : null;
  } catch {
    return null;
  }
}

type TikTokOembed = {
  thumbnail_url?: string;
  author_name?: string;
  author_url?: string;
};

export async function fetchTikTokOembed(url: string): Promise<OembedResult> {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`TikTok oembed ${res.status} for ${url}`);
  }
  const data = (await res.json()) as TikTokOembed;
  return {
    thumbnail_url: data.thumbnail_url ?? null,
    creator_handle: handleFromAuthorUrl(data.author_url),
    creator_url: data.author_url ?? null,
  };
}

type XOembed = {
  html?: string;
  author_name?: string;
  author_url?: string;
};

export async function fetchXOembed(url: string): Promise<OembedResult> {
  const endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(
    url,
  )}&omit_script=1`;
  const res = await fetch(endpoint, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`X oembed ${res.status} for ${url}`);
  }
  const data = (await res.json()) as XOembed;
  // X/Twitter oembed doesn't return a thumbnail_url field. Best-effort:
  // pull the first <img src="..."> out of the embedded html if present.
  let thumb: string | null = null;
  if (data.html) {
    const m = data.html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) thumb = m[1];
  }
  return {
    thumbnail_url: thumb,
    creator_handle: handleFromAuthorUrl(data.author_url),
    creator_url: data.author_url ?? null,
  };
}

export async function fetchOembedForFanEdit(
  platform: string,
  url: string,
): Promise<OembedResult> {
  if (platform === "tiktok") return fetchTikTokOembed(url);
  if (platform === "x") return fetchXOembed(url);
  // Instagram and YouTube intentionally not implemented this round.
  return EMPTY;
}
