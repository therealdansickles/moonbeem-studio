import EmbedRenderer from "@/components/EmbedRenderer";
import type { FanEdit } from "@/lib/queries/titles";

const platformOrder = ["tiktok", "instagram", "x", "youtube"] as const;

const platformLabel: Record<(typeof platformOrder)[number], string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  x: "X",
  youtube: "YouTube",
};

export default function FanEditsTab({ fanEdits }: { fanEdits: FanEdit[] }) {
  if (fanEdits.length === 0) {
    return (
      <div className="py-12 text-center text-moonbeem-ink-muted text-body">
        No fan edits yet. Check back soon.
      </div>
    );
  }

  const grouped: Record<(typeof platformOrder)[number], FanEdit[]> = {
    tiktok: [],
    instagram: [],
    x: [],
    youtube: [],
  };
  for (const edit of fanEdits) {
    grouped[edit.platform].push(edit);
  }
  for (const key of platformOrder) {
    grouped[key].sort((a, b) => a.display_order - b.display_order);
  }

  return (
    <div className="flex flex-col gap-12">
      <p className="text-body-sm text-moonbeem-ink-muted">
        Authorized fan edits across TikTok, Instagram, and X.
      </p>

      {platformOrder.map((platform) => {
        const edits = grouped[platform];
        if (edits.length === 0) return null;
        return (
          <section key={platform}>
            <h3 className="text-body text-moonbeem-ink-muted font-medium">
              {platformLabel[platform]}
            </h3>
            <div className="border-t border-white/10 mt-2 mb-6" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {edits.map((edit) => (
                <div key={edit.id} className="rounded-md">
                  <EmbedRenderer edit={edit} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
