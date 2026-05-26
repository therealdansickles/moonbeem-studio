"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { PartnerMembership } from "@/lib/dal";

type Props = {
  email: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  // Optional so existing callers don't break. Empty/undefined → no
  // partner section is rendered.
  partnerMemberships?: PartnerMembership[];
};

function initial(text: string): string {
  return text.trim().charAt(0).toUpperCase() || "?";
}

export default function AccountMenu({
  email,
  handle,
  displayName,
  avatarUrl,
  partnerMemberships,
}: Props) {
  const memberships = partnerMemberships ?? [];
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function signOut() {
    setPending(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    setOpen(false);
    router.replace("/");
    router.refresh();
  }

  const buttonInitial = initial(displayName ?? handle ?? email);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-moonbeem-pink/20 text-moonbeem-pink text-body-sm font-semibold border border-white/10 hover:border-moonbeem-pink transition-colors"
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            className="h-full w-full rounded-full object-cover"
          />
        ) : (
          buttonInitial
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 rounded-xl bg-moonbeem-black/95 backdrop-blur-md border border-white/10 shadow-2xl shadow-black/50 py-2 z-30">
          <div className="px-4 pb-2 border-b border-white/5">
            <p className="text-body-sm text-moonbeem-ink truncate">
              {handle ? `@${handle}` : (displayName ?? email)}
            </p>
            <p className="text-caption text-moonbeem-ink-subtle truncate">
              {email}
            </p>
          </div>
          {handle && (
            <Link
              href={`/c/${handle}`}
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-body-sm text-moonbeem-ink hover:bg-white/5 transition-colors"
            >
              View profile
            </Link>
          )}
          <Link
            href="/me/edit"
            onClick={() => setOpen(false)}
            className="block px-4 py-2 text-body-sm text-moonbeem-ink hover:bg-white/5 transition-colors"
          >
            Edit profile
          </Link>
          <Link
            href="/me"
            onClick={() => setOpen(false)}
            className="block px-4 py-2 text-body-sm text-moonbeem-ink hover:bg-white/5 transition-colors"
          >
            Account
          </Link>
          {memberships.length > 0 && (
            <>
              <div className="my-1 border-t border-white/5" />
              <p className="px-4 pt-2 pb-1 text-caption text-moonbeem-ink-subtle">
                Your partners
              </p>
              {memberships.map((m) => (
                <Link
                  key={m.partner_id}
                  href={`/p/${m.partner_slug}/dashboard`}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between gap-3 px-4 py-2 text-body-sm text-moonbeem-ink hover:bg-white/5 transition-colors"
                >
                  <span className="truncate">{m.partner_name}</span>
                  <span className="shrink-0 text-caption text-moonbeem-ink-subtle">
                    {m.role}
                  </span>
                </Link>
              ))}
              <div className="my-1 border-t border-white/5" />
            </>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={signOut}
            className="block w-full text-left px-4 py-2 text-body-sm text-moonbeem-ink hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            {pending ? "Signing out..." : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
