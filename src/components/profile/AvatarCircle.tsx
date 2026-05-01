type Props = {
  avatarUrl: string | null;
  displayName: string | null;
  handle: string;
  size?: number;
  className?: string;
};

const PALETTE = [
  "bg-moonbeem-pink/30 text-moonbeem-pink",
  "bg-moonbeem-violet/30 text-moonbeem-violet-soft",
  "bg-moonbeem-magenta/25 text-moonbeem-magenta",
  "bg-moonbeem-lime/20 text-moonbeem-lime",
];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PALETTE.length;
  return PALETTE[idx];
}

function initialsOf(displayName: string | null, handle: string): string {
  const source = (displayName ?? handle).trim();
  if (!source) return "?";
  const parts = source.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.charAt(0).toUpperCase();
}

export default function AvatarCircle({
  avatarUrl,
  displayName,
  handle,
  size = 96,
  className = "",
}: Props) {
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        className={`rounded-full object-cover border border-white/10 ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  const initials = initialsOf(displayName, handle);
  const color = colorFor(handle);
  const fontSize = Math.max(14, Math.round(size * 0.4));
  return (
    <div
      className={`flex items-center justify-center rounded-full font-semibold border border-white/10 ${color} ${className}`}
      style={{ width: size, height: size, fontSize }}
    >
      {initials}
    </div>
  );
}
