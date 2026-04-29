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
    <div className="w-full max-w-5xl">
      {/* Desktop: tab strip */}
      <div className="hidden md:block">
        <div
          role="tablist"
          aria-label="Title sections"
          className="flex items-center gap-8 border-b border-moonbeem-border"
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
                className={`pb-3 text-body font-semibold transition-colors border-b-2 -mb-px ${
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

      {/* Mobile: accordion */}
      <div className="md:hidden flex flex-col">
        {sections.map((s) => {
          const isOpen = s.id === active;
          return (
            <div key={s.id} className="border-b border-moonbeem-border">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`acc-panel-${s.id}`}
                id={`acc-header-${s.id}`}
                onClick={() => setActive(s.id)}
                className="w-full flex justify-between items-center py-4 text-moonbeem-ink font-semibold text-body"
              >
                <span>{s.label}</span>
                <span
                  aria-hidden="true"
                  className="text-moonbeem-ink-muted text-body-lg"
                >
                  {isOpen ? "▴" : "▾"}
                </span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    key="content"
                    id={`acc-panel-${s.id}`}
                    role="region"
                    aria-labelledby={`acc-header-${s.id}`}
                    variants={fadeIn}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    className="pb-6"
                  >
                    {s.content}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}
