// Shared visibility check for partner titles.
//
// is_public=true → anyone can see the title page + click out. is_public
// =false → the title is in soft-launch / preview state, only visible
// to:
//   - super_admins (Moonbeem internal)
//   - partner_users members of the title's partner (creators on the
//     1-2 Special team, viewer or admin role, soft-delete null)
//
// Used by /t/[slug] page rendering, /go/offer + /go/[code] redirects,
// and the title-page generateMetadata so we don't leak title names
// via OpenGraph for unlisted titles.
//
// Both clients are accepted: the cookie-aware client already exists
// at the call site for /t/[slug], the service-role client for the
// /go/* redirects (no cookies needed; the redirect itself is anon).

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

type TitleVisibilityRow = {
  is_public: boolean;
  partner_id: string | null;
};

// Returns true when the caller (identified by the cookie-aware
// client's auth.getUser()) is allowed to see the title. Anonymous
// callers see only is_public=true titles.
export async function canViewTitle(
  title: TitleVisibilityRow,
): Promise<boolean> {
  if (title.is_public) return true;

  // Hidden (non-public catalog) title — visible to any authenticated
  // caller; anonymous callers see only public titles.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  // Any authenticated user may view non-public catalog titles. This
  // subsumes the former super_admin- and partner-team-only branches
  // (both are signed-in callers, so both still pass) and opens the full
  // catalog to signed-in users while keeping anonymous to public-only
  // via the !user guard above.
  return true;
}

// Server-side variant for /go/* redirects, which don't have a
// session-bound client up-front. Reads the auth cookie via the same
// cookie-aware client; signed-out callers fall through the
// is_public=false branch and 404.
//
// The fetched title row also returns title_id so the caller can use
// it for click-logging / further queries.
export async function loadVisibleTitleById(
  serviceClient: SupabaseClient,
  titleId: string,
): Promise<{ id: string; is_public: boolean; partner_id: string | null } | null> {
  const { data, error } = await serviceClient
    .from("titles")
    .select("id, is_public, partner_id")
    .eq("id", titleId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; is_public: boolean; partner_id: string | null };
  const ok = await canViewTitle(row);
  return ok ? row : null;
}

// Helper for click routes that work via slug (none today, kept for
// symmetry with the by-id variant).
export async function loadVisibleTitleBySlug(
  slug: string,
): Promise<{ id: string; is_public: boolean; partner_id: string | null } | null> {
  const service = createServiceRoleClient();
  const { data } = await service
    .from("titles")
    .select("id, is_public, partner_id")
    .eq("slug", slug)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const row = data as { id: string; is_public: boolean; partner_id: string | null };
  const ok = await canViewTitle(row);
  return ok ? row : null;
}
