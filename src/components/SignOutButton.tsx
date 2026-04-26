"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      onClick={onClick}
      disabled={pending}
      className="bg-transparent border border-moonbeem-border-strong text-moonbeem-ink rounded-md px-6 py-2 text-body-sm hover:border-moonbeem-pink disabled:opacity-50 transition-colors"
    >
      {pending ? "Signing out..." : "Sign out"}
    </button>
  );
}
