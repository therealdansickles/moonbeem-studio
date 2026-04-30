import Image from "next/image";
import Link from "next/link";
import type { Title } from "@/lib/queries/titles";

type Props = {
  title: Pick<Title, "id" | "slug" | "title" | "poster_url">;
};

export default function TitleCard({ title }: Props) {
  const href = `/t/${title.slug}`;

  return (
    <Link
      href={href}
      className="group relative block aspect-[2/3] w-full overflow-hidden rounded-xl bg-moonbeem-navy/40 transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] hover:scale-[1.03] hover:shadow-[0_20px_40px_rgba(245,197,225,0.3)] focus:outline-none focus-visible:ring-2 focus-visible:ring-moonbeem-pink"
    >
      {title.poster_url ? (
        <Image
          src={title.poster_url}
          alt={`${title.title} poster`}
          fill
          sizes="(max-width: 768px) 50vw, 240px"
          className="object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-moonbeem-navy to-moonbeem-black p-4 text-center">
          <span className="font-wordmark text-heading-md text-moonbeem-ink">
            {title.title}
          </span>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-3 pt-10">
        <p className="text-body-sm font-semibold text-moonbeem-ink leading-tight line-clamp-2">
          {title.title}
        </p>
      </div>
    </Link>
  );
}
