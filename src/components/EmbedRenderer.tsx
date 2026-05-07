"use client";

import Link from "next/link";
import { InstagramEmbed, TikTokEmbed, XEmbed } from "react-social-media-embed";
import type { FanEdit } from "@/lib/queries/titles";

const platformLabel: Record<FanEdit["platform"], string> = {
  instagram: "via Instagram",
  tiktok: "via TikTok",
  twitter: "via X",
  youtube: "via YouTube",
};

export default function EmbedRenderer({ edit }: { edit: FanEdit }) {
  // Prefer the moonbeem_handle for both display and link target —
  // it's the canonical creator address. Fall back to the platform
  // handle when the row has no linked creator (legacy @anon rows).
  const moonbeemHandle = edit.creator_moonbeem_handle;
  const displayHandle =
    moonbeemHandle ?? edit.creator_handle_displayed ?? null;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-body-sm text-moonbeem-ink-subtle px-1">
        {platformLabel[edit.platform]}
        {displayHandle && (
          <>
            {" · by "}
            {moonbeemHandle ? (
              <Link
                href={`/c/${moonbeemHandle}`}
                prefetch={false}
                className="text-moonbeem-ink-muted hover:text-moonbeem-pink hover:underline"
              >
                @{displayHandle}
              </Link>
            ) : (
              <span>@{displayHandle}</span>
            )}
          </>
        )}
      </div>
      {renderPlatformEmbed(edit)}
    </div>
  );
}

function FramedEmbed({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3 flex justify-center overflow-hidden">
      {children}
    </div>
  );
}

function renderPlatformEmbed(edit: FanEdit) {
  switch (edit.platform) {
    case "instagram":
      return (
        <div className="relative w-full min-h-[600px] flex items-start justify-center">
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-body-sm text-moonbeem-ink-subtle">
              Loading from Instagram…
            </div>
          </div>
          <div className="relative w-full">
            <InstagramEmbed
              url={edit.embed_url}
              width="100%"
              retryDelay={1000}
              placeholderDisabled
            />
          </div>
        </div>
      );
    case "tiktok":
      return (
        <FramedEmbed>
          <TikTokEmbed url={edit.embed_url} width="100%" />
        </FramedEmbed>
      );
    case "twitter":
      return (
        <FramedEmbed>
          <XEmbed url={edit.embed_url} width="100%" />
        </FramedEmbed>
      );
    default:
      return null;
  }
}
