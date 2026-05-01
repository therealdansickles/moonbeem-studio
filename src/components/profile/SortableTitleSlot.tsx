"use client";

import Image from "next/image";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TopTitle } from "@/lib/queries/profiles";

type Props = {
  item: TopTitle;
};

export default function SortableTitleSlot({ item }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`relative aspect-[2/3] w-full cursor-grab overflow-hidden rounded-xl bg-moonbeem-navy/40 select-none ${
        isDragging
          ? "scale-[1.04] shadow-[0_24px_48px_rgba(245,197,225,0.35)] ring-2 ring-moonbeem-pink"
          : "ring-1 ring-white/10"
      }`}
    >
      {item.title.poster_url ? (
        <Image
          src={item.title.poster_url}
          alt={`${item.title.title} poster`}
          fill
          sizes="(max-width: 768px) 50vw, 240px"
          draggable={false}
          className="select-none object-cover pointer-events-none"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-moonbeem-navy to-moonbeem-black p-4 text-center">
          <span className="font-wordmark text-heading-md text-moonbeem-ink">
            {item.title.title}
          </span>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-3 pt-10">
        <p className="text-body-sm font-semibold text-moonbeem-ink leading-tight line-clamp-2">
          {item.title.title}
        </p>
      </div>
      <div className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-caption font-semibold text-moonbeem-lime backdrop-blur-sm">
        {item.position}
      </div>
    </div>
  );
}
