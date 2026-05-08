// Build the canonical platform-profile URL for a (platform, handle)
// pair. Used to make verified-social badges on /c/[handle] linkable
// to the actual platform.
//
// Conventions per platform:
//   tiktok    → https://www.tiktok.com/@<handle>
//   instagram → https://www.instagram.com/<handle>/
//   twitter   → https://x.com/<handle>           (canonical post 2023)
//   youtube   → https://www.youtube.com/@<handle>
//
// Handle is expected pre-normalized (lowercase, no leading @). The
// builder defends against accidental @ prefixes anyway.

import type { SocialPlatform } from "./handle";

export function buildSocialProfileUrl(
  platform: SocialPlatform,
  handle: string,
): string {
  const h = handle.replace(/^@+/, "").trim();
  switch (platform) {
    case "tiktok":
      return `https://www.tiktok.com/@${h}`;
    case "instagram":
      return `https://www.instagram.com/${h}/`;
    case "twitter":
      return `https://x.com/${h}`;
    case "youtube":
      return `https://www.youtube.com/@${h}`;
  }
}

export const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

// Where the user pastes the verification code. Surfaces in the
// "Paste this code anywhere in your TikTok bio" instructions on
// the verify card.
export const PLATFORM_BIO_LABEL: Record<SocialPlatform, string> = {
  tiktok: "TikTok bio",
  instagram: "Instagram bio",
  twitter: "X bio",
  youtube: "YouTube channel description",
};
