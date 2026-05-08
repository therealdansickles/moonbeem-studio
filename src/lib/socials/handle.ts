// Shared handle/platform validation for the social verification flow.

export const ALLOWED_SOCIAL_PLATFORMS = [
  "tiktok",
  "instagram",
  "twitter",
  "youtube",
] as const;
export type SocialPlatform = (typeof ALLOWED_SOCIAL_PLATFORMS)[number];

export function isSocialPlatform(v: unknown): v is SocialPlatform {
  return typeof v === "string" &&
    (ALLOWED_SOCIAL_PLATFORMS as readonly string[]).includes(v);
}

// Strip leading @, lowercase, trim. Returns null on shape failure.
// Permissive enough to cover TikTok (./_), Instagram (./_), Twitter (_).
export function normalizeHandle(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const stripped = input.trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9_.]{1,30}$/.test(stripped)) return null;
  return stripped;
}

// Unambiguous alphabet (no 0/O, 1/I/L) so codes are typeable from a
// phone keyboard. 33^6 = ~1.3B combos ⇒ collisions effectively zero.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// MB-prefixed 8-character code: "MB" + 6 random alphanumerics. The
// prefix makes it identifiable as a Moonbeem code in a bio at a glance.
export function generateVerificationCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = "MB";
  for (const b of bytes) {
    code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return code;
}
