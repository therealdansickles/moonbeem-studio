import Image from "next/image";
import Link from "next/link";
import type { FanEditWithTitle } from "@/lib/queries/titles";
import PlatformIcon from "@/components/PlatformIcon";

// Profile-surface fan-edit card. Standalone variant of
// FanEditThumbnail: links to the title page instead of opening the
// modal player (the profile context spans many titles, no shared
// modal carousel makes sense). Visual chrome mirrors FanEditThumbnail
// — same platform pill, byline gradient, aspect-by-platform.

type Props = {
  fanEdit: FanEditWithTitle;
  eager?: boolean;
};

const platformLabel: Record<FanEditWithTitle["platform"], string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

function aspectFor(fe: FanEditWithTitle): string {
  switch (fe.platform) {
    case "tiktok":
    case "instagram":
      return "9 / 16";
    case "twitter":
    case "youtube":
      return "16 / 9";
  }
}

export default function ProfileFanEditCard({ fanEdit, eager }: Props) {
  const handle =
    fanEdit.creator_moonbeem_handle ??
    fanEdit.creator_handle_displayed ??
    "anon";
  const renderSrc = fanEdit.thumbnail_url ?? fanEdit.title_poster_url ?? null;
  const hasImage = !!renderSrc;

  return (
    <div
      style={{ aspectRatio: aspectFor(fanEdit) }}
      className="relative w-full"
    >
      <Link
        href={`/t/${fanEdit.title_slug}`}
        className="group absolute inset-0 block overflow-hidden rounded-xl bg-moonbeem-navy/40 transition-[transform,box-shadow] duration-200 ease-out hover:scale-[1.02] hover:shadow-[0_20px_40px_rgba(245,197,225,0.25)] active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
        aria-label={`Fan edit by @${handle} on ${platformLabel[fanEdit.platform]} for ${fanEdit.title_name}`}
      >
        {hasImage ? (
          <Image
            src={renderSrc!}
            alt=""
            fill
            sizes="(max-width: 768px) 50vw, 33vw"
            loading={eager ? "eager" : "lazy"}
            unoptimized={!!fanEdit.thumbnail_url}
            draggable={false}
            className="select-none object-cover"
          />
        ) : (
          <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-moonbeem-navy via-moonbeem-black to-moonbeem-navy" />
        )}

        {/* Top gradient + title name (profile context — viewer needs
            to know which title each edit attaches to). */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start bg-gradient-to-b from-black/70 via-black/30 to-transparent p-3 pb-10">
          <span className="line-clamp-2 text-body-sm font-medium text-white">
            {fanEdit.title_name}
          </span>
        </div>

        {/* Bottom gradient + byline + platform pill. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 via-black/40 to-transparent p-3 pt-12">
          <span className="min-w-0 flex-1 truncate text-body-sm font-medium text-white">
            @{handle}
          </span>
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-white/50 bg-transparent px-2 py-0.5 text-caption text-white">
            <PlatformIcon platform={fanEdit.platform} className="h-3 w-3" />
            {platformLabel[fanEdit.platform]}
          </span>
        </div>
      </Link>
    </div>
  );
}
