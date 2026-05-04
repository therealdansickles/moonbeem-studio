"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { fadeIn } from "@/lib/motion";

type SectionId = "about" | "fan-edits" | "videos" | "stills";

type Section = { id: SectionId; label: string; content: ReactNode };

type Props = {
  aboutContent: ReactNode;
  fanEditsContent: ReactNode;
  videosContent: ReactNode;
  stillsContent: ReactNode;
};

export default function TitleTabs({
  aboutContent,
  fanEditsContent,
  videosContent,
  stillsContent,
}: Props) {
  const [active, setActive] = useState<SectionId>("about");

  const sections: Section[] = [
    { id: "about", label: "About", content: aboutContent },
    { id: "fan-edits", label: "Fan Edits", content: fanEditsContent },
    { id: "videos", label: "Videos", content: videosContent },
    { id: "stills", label: "Stills", content: stillsContent },
  ];

  const activeSection = sections.find((s) => s.id === active) ?? sections[0];

  return (
    <div className="w-full">
      <div
        role="tablist"
        aria-label="Title sections"
        className="flex items-center gap-6 md:gap-8 border-b border-moonbeem-border overflow-x-auto scrollbar-hide -mx-6 px-6 md:mx-0 md:px-0"
      >
        {sections.map((s) => {
          const isActive = s.id === active;
          return (
            <button
              key={s.id}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-controls={`panel-${s.id}`}
              id={`tab-${s.id}`}
              onClick={() => setActive(s.id)}
              className={`pb-3 text-body font-semibold transition-colors border-b-2 -mb-px shrink-0 whitespace-nowrap ${
                isActive
                  ? "text-moonbeem-pink border-moonbeem-pink"
                  : "text-moonbeem-ink-muted border-transparent hover:text-moonbeem-ink"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`panel-${activeSection.id}`}
        aria-labelledby={`tab-${activeSection.id}`}
        className="pt-8"
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={activeSection.id}
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            exit="hidden"
          >
            {activeSection.content}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
