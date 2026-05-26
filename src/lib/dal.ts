import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

// Partner-team memberships attached to the per-request profile. Used
// by TopNav + AccountMenu to surface partner-dashboard links. Loaded
// once per profile cache hit; consumers re-render based on the array
// shape (length 0 / 1 / 2+).
export type PartnerMembership = {
  partner_id: string;
  partner_slug: string;
  partner_name: string;
  role: string;
};

export const verifySession = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { userId: user.id, email: user.email ?? "" };
});

export const getUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export const getCurrentProfile = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("users")
    .select("id, role, handle, display_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  // Partner-team memberships for the navbar. partner_users has RLS
  // enabled with no policies, so reads go through the service-role
  // client — same convention as /p/[slug]/dashboard's membership
  // check. Two bounded queries (memberships, then partners by id) —
  // NOT N+1 (the second query is one .in() lookup, not one per
  // partner). Most users have zero memberships → only the first
  // query runs.
  const service = createServiceRoleClient();
  const { data: memRows } = await service
    .from("partner_users")
    .select("partner_id, role")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  let partnerMemberships: PartnerMembership[] = [];
  if (memRows && memRows.length > 0) {
    const partnerIds = memRows.map((m) => m.partner_id as string);
    const { data: partners } = await service
      .from("partners")
      .select("id, slug, name")
      .in("id", partnerIds);
    const byId = new Map<string, { slug: string; name: string }>();
    for (const p of partners ?? []) {
      byId.set(p.id as string, {
        slug: p.slug as string,
        name: p.name as string,
      });
    }
    partnerMemberships = memRows
      .map((m) => {
        const p = byId.get(m.partner_id as string);
        if (!p) return null;
        return {
          partner_id: m.partner_id as string,
          partner_slug: p.slug,
          partner_name: p.name,
          role: m.role as string,
        };
      })
      .filter((x): x is PartnerMembership => x !== null);
  }

  return {
    userId: user.id,
    email: user.email ?? "",
    role: (data?.role ?? "user") as string,
    handle: (data?.handle ?? null) as string | null,
    displayName: (data?.display_name ?? null) as string | null,
    avatarUrl: (data?.avatar_url ?? null) as string | null,
    partnerMemberships,
  };
});

export const requireSuperAdmin = cache(async () => {
  const session = await verifySession();
  const supabase = await createClient();
  const { data } = await supabase
    .from("users")
    .select("role")
    .eq("id", session.userId)
    .maybeSingle();
  if (data?.role !== "super_admin") {
    redirect("/");
  }
  return session;
});

// Like requireSuperAdmin, but for routes that should not reveal their
// existence to non-admins. Anonymous + non-super-admin users both get
// a generic 404. Used for the /admin root, where the URL itself is a
// signal we don't want to leak.
export const requireSuperAdminOr404 = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();
  const { data } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (data?.role !== "super_admin") notFound();
  return { userId: user.id, email: user.email ?? "" };
});
