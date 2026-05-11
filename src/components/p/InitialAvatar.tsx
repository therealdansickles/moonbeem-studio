// Per-handle gradient initial avatar — used on /p/[slug] Top
// Performers + Top Creators when a real creator avatar isn't
// available (most creators today are stubs without a claimed
// user account → no users.avatar_url). Stable hue derived from
// a hash of the handle so the same creator always looks the
// same across reloads.
//
// Followup memory: "Real avatars in /p/[slug] top creators" —
// when real avatars become a priority, query users.avatar_url
// via the creators.user_id join and render an <img> here when
// available; gradient initials stay as the fallback.

function avatarHueForHandle(handle: string): number {
  let hash = 0;
  for (let i = 0; i < handle.length; i++) {
    hash = (hash * 31 + handle.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

type Props = {
  handle: string;
  // 32px (size-8) matches the partner-dashboard spec; pass a
  // different Tailwind size class to override.
  className?: string;
};

export default function InitialAvatar({
  handle,
  className = "h-8 w-8 text-caption",
}: Props) {
  const initial = handle[0]?.toUpperCase() ?? "?";
  const hue = avatarHueForHandle(handle);
  return (
    <div
      style={{
        background:
          `linear-gradient(135deg, hsl(${hue} 70% 50%), hsl(${
            (hue + 40) % 360
          } 70% 35%))`,
      }}
      className={`flex shrink-0 items-center justify-center rounded-full font-wordmark font-semibold text-white ${className}`}
    >
      {initial}
    </div>
  );
}
