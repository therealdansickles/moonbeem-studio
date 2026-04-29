import { cache } from "react";
import { redirect } from "next/navigation";
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
