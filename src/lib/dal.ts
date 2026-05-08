import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
  return {
    userId: user.id,
    email: user.email ?? "",
    role: (data?.role ?? "user") as string,
    handle: (data?.handle ?? null) as string | null,
    displayName: (data?.display_name ?? null) as string | null,
    avatarUrl: (data?.avatar_url ?? null) as string | null,
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
