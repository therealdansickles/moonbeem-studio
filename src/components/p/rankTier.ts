// Tier-based rank accent classes for partner-dashboard ranked lists
// (Top Performers, Top Creators). Cues are scan-ability hints, not
// awards-show graphics — kept subtle so the data stays primary.
//
// 1-3 gold (#fbbf24), 4-6 silver (#94a3b8), 7-12 bronze (#a16207),
// 13+ neutral. Mapped to brand-aligned Tailwind classes that already
// ship in the existing palette.

export function rankTierClass(rank1Based: number): string {
  if (rank1Based <= 3) return "text-amber-400";
  if (rank1Based <= 6) return "text-slate-300";
  if (rank1Based <= 12) return "text-amber-700";
  return "text-moonbeem-ink-subtle";
}
