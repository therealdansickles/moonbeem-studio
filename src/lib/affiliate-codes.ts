// Affiliate-link short-code generator + creation helper.
//
// Code shape: 5 characters from [a-z0-9] minus visually ambiguous
// glyphs (0, 1, i, l, o). The remaining alphabet is 31 chars
// (a-z = 26, minus i/l/o = 23; plus 0-9 = 10, minus 0/1 = 8;
// 23 + 8 = 31). 31^5 ≈ 28.6M combinations — collision probability is
// negligible at our expected volume; the unique-constraint retry below
// covers the rest.
//
// Randomness: crypto.getRandomValues (Web Crypto API, available in
// both Node 18+ and Edge runtimes — keeps this helper portable).
// Uses a simple modulo bias accepted as fine for non-cryptographic
// short codes.

import { createServiceRoleClient } from "@/lib/supabase/service";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 5;
const MAX_INSERT_RETRIES = 3;

export function generateAffiliateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export type CreateAffiliateLinkArgs = {
  creator_id: string;
  title_id: string;
  title_offer_id: string | null;
  destination_url: string;
  // Audit trail: which user minted this link (admin curating a
  // campaign, the creator themselves via a future dashboard, or a
  // seed script). Null = unknown / pre-instrumentation.
  created_by?: string | null;
};

export type CreateAffiliateLinkResult = {
  code: string;
  destination_url: string;
};

export async function createAffiliateLink(
  args: CreateAffiliateLinkArgs,
): Promise<CreateAffiliateLinkResult> {
  const supabase = createServiceRoleClient();

  let lastError: string | null = null;
  for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
    const code = generateAffiliateCode();
    const { error } = await supabase.from("affiliate_links").insert({
      creator_id: args.creator_id,
      title_id: args.title_id,
      title_offer_id: args.title_offer_id,
      slug: code,
      destination_url: args.destination_url,
      created_by: args.created_by ?? null,
    });

    if (!error) {
      return { code, destination_url: args.destination_url };
    }

    // 23505 = unique_violation — slug collision. Mint a new code and retry.
    if (error.code === "23505") {
      lastError = `slug collision on attempt ${attempt + 1} (code=${code})`;
      continue;
    }

    // Any other DB error is not a transient collision — surface it.
    throw new Error(
      `createAffiliateLink: insert failed (${error.code}): ${error.message}`,
    );
  }

  throw new Error(
    `createAffiliateLink: ${MAX_INSERT_RETRIES} consecutive slug collisions — ` +
      `unexpected at our volume. Last: ${lastError}`,
  );
}

// ---------------------------------------------------------------------
// Inline reference (no test runner — manual smoke check)
// ---------------------------------------------------------------------
//
// generateAffiliateCode() -> 'x7k2m'   // 5 chars from the safe alphabet
// generateAffiliateCode() -> 'qj4n8'
//
// 'x7k2m'.split('').every(c => 'abcdefghjkmnpqrstuvwxyz23456789'.includes(c))
//   -> true
//
// await createAffiliateLink({
//   creator_id: '<dpop-uuid>',
//   title_id: '<erupcja-uuid>',
//   title_offer_id: '<fandango-offer-uuid>',
//   destination_url: 'https://www.fandango.com/erupcja',
//   created_by: '<admin-uuid>',
// })
//   -> { code: 'x7k2m', destination_url: 'https://www.fandango.com/erupcja' }
//
// // created_by is optional; omitting it persists null (unknown source).
// await createAffiliateLink({
//   creator_id: '<dpop-uuid>',
//   title_id: '<erupcja-uuid>',
//   title_offer_id: null,
//   destination_url: 'https://moonbeem.studio/t/erupcja',
// })
//   -> { code: 'qj4n8', destination_url: 'https://moonbeem.studio/t/erupcja' }
