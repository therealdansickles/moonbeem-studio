"use client";

import { InstagramEmbed, TikTokEmbed, XEmbed } from "react-social-media-embed";
import type { FanEdit } from "@/lib/queries/titles";

const platformLabel: Record<FanEdit["platform"], string> = {
  instagram: "via Instagram",
  tiktok: "via TikTok",
  x: "via X",
  youtube: "via YouTube",
};

export default function EmbedRenderer({ edit }: { edit: FanEdit }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-body-sm text-moonbeem-ink-subtle px-1">
        {platformLabel[edit.platform]}
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
    case "x":
      return (
        <FramedEmbed>
          <XEmbed url={edit.embed_url} width="100%" />
        </FramedEmbed>
      );
    default:
      return null;
  }
}
