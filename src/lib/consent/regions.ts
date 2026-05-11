// EU/EEA + UK + Switzerland — opt-in jurisdictions for cookie
// consent under GDPR/UK-GDPR/Swiss FADP.
//
// Update path: if a new GDPR-equivalent jurisdiction onboards (e.g.,
// post-Brexit Scottish-specific framework, or an EEA accession), add
// the ISO-3166-1 alpha-2 country code here. Reading both Vercel and
// Cloudflare `x-vercel-ip-country` / `cf-ipcountry` headers returns
// the same codes.
//
// Source list verified 2026-05-11 against:
//   - EU 27 member states
//   - EEA additions: Iceland, Liechtenstein, Norway
//   - UK (Brexit retained EU-equivalent data law)
//   - Switzerland (FADP — substantially aligned with GDPR)

export const EU_OPT_IN_COUNTRY_CODES = new Set<string>([
  // EU 27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE",
  "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT",
  "RO", "SK", "SI", "ES", "SE",
  // EEA additions
  "IS", "LI", "NO",
  // UK + Switzerland
  "GB", "CH",
]);

// Returns true when the visitor's country requires opt-in consent.
// Undefined / unknown country → treat as opt-in (over-prompting is
// the safer compliance default).
export function isOptInRegion(country: string | null | undefined): boolean {
  if (!country) return true;
  return EU_OPT_IN_COUNTRY_CODES.has(country.toUpperCase());
}
