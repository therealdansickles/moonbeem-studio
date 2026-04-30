"use client";

import type { Title } from "@/lib/queries/titles";
import TitleCard from "./TitleCard";

type Props = {
  title: string;
  titles: Pick<Title, "id" | "slug" | "title" | "poster_url">[];
};

export default function TitleCarousel({ title, titles }: Props) {
  if (titles.length === 0) return null;

  return (
    <section className="w-full max-w-7xl px-6">
      <h2 className="mb-4 text-caption font-medium uppercase tracking-wider text-moonbeem-lime">
        {title}
      </h2>

      <div
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="list"
      >
        {titles.map((t) => (
          <div
            key={t.id}
            role="listitem"
            className="w-[160px] shrink-0 snap-start md:w-[220px] lg:w-[240px]"
          >
            <TitleCard title={t} />
          </div>
        ))}
      </div>
    </section>
  );
}
