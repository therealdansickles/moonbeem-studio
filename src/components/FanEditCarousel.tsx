"use client";

import type { FanEditWithTitle } from "@/lib/queries/titles";
import FanEditCard from "./FanEditCard";

type Props = {
  title: string;
  fanEdits: FanEditWithTitle[];
};

export default function FanEditCarousel({ title, fanEdits }: Props) {
  if (fanEdits.length === 0) return null;

  return (
    <section className="w-full max-w-7xl px-6">
      <h2 className="mb-4 text-caption font-medium uppercase tracking-wider text-moonbeem-lime">
        {title}
      </h2>

      <div
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="list"
      >
        {fanEdits.map((fe) => (
          <div
            key={fe.id}
            role="listitem"
            className="w-[200px] shrink-0 snap-start md:w-[260px] lg:w-[280px]"
          >
            <FanEditCard fanEdit={fe} />
          </div>
        ))}
      </div>
    </section>
  );
}
