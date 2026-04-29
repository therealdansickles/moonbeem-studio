import type { Clip } from "@/lib/queries/titles";

type Props = {
  clips: Clip[];
};

function formatDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").pop() || "clip";
    return decodeURIComponent(last);
  } catch {
    return "clip";
  }
}

export default function VideosTab({ clips }: Props) {
  if (!clips || clips.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-body text-moonbeem-ink-muted">
          Coming soon. The clip library is uploading. 77 clips coming.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {clips.map((clip) => {
        if (!clip.file_url) return null;
        const duration = formatDuration(clip.duration_seconds);
        const displayLabel =
          clip.label?.trim() || fileNameFromUrl(clip.file_url);

        return (
          <div key={clip.id} className="flex flex-col gap-2">
            <div className="aspect-video bg-black rounded-md overflow-hidden">
              <video
                controls
                preload="metadata"
                src={clip.file_url}
                className="w-full h-full object-contain"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-body-sm text-moonbeem-ink truncate">
                  {displayLabel}
                </p>
                {duration && (
                  <span className="text-body-sm text-moonbeem-ink-subtle shrink-0">
                    · {duration}
                  </span>
                )}
              </div>
              <a
                href={clip.file_url}
                download={`${clip.label || "clip"}.mp4`}
                className="text-body-sm text-moonbeem-pink hover:opacity-80 transition-opacity shrink-0"
              >
                Download
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}
