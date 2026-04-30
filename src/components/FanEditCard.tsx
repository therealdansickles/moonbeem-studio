import Image from "next/image";
import Link from "next/link";
import type { FanEditWithTitle } from "@/lib/queries/titles";
import PlatformIcon from "./PlatformIcon";

type Props = {
  fanEdit: FanEditWithTitle;
};

export default function FanEditCard({ fanEdit }: Props) {
  return (
    <Link
      href={`/t/${fanEdit.title_slug}`}
      className="group relative block aspect-[3/4] w-full overflow-hidden rounded-xl bg-moonbeem-navy/40 transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] hover:scale-[1.03] hover:shadow-[0_20px_40px_rgba(245,197,225,0.3)] focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
    >
      <Image
        src={fanEdit.title_poster_url}
        alt={`${fanEdit.title_name} poster`}
        fill
        sizes="(max-width: 768px) 75vw, 280px"
        className="object-cover"
      />

      <div className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-moonbeem-ink backdrop-blur-sm">
        <PlatformIcon platform={fanEdit.platform} className="h-4 w-4" />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 pt-12">
        <p className="text-body-sm font-medium text-moonbeem-ink leading-tight line-clamp-2">
          {fanEdit.title_name}
        </p>
        <p className="mt-0.5 text-caption text-moonbeem-ink-subtle">
          by @{fanEdit.creator_handle}
        </p>
      </div>
    </Link>
  );
}
