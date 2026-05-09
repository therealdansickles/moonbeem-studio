"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Member = {
  id: string;
  user_id: string;
  email: string;
  role: "admin" | "viewer";
  created_at: string;
};

type Props = {
  partnerId: string;
  partnerName: string;
  onClose: () => void;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ManageMembersModal({
  partnerId,
  partnerName,
  onClose,
}: Props) {
  const router = useRouter();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "viewer">("viewer");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Initial load. Refetched after mutations via setMembers directly
  // (server returns the updated row) rather than re-hitting GET.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/partners/${partnerId}/members`);
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          members?: Member[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !json.ok) {
          setListError(json.error ?? `request failed (${res.status})`);
          setMembers([]);
          return;
        }
        setMembers(json.members ?? []);
      } catch (err) {
        if (cancelled) return;
        setListError(err instanceof Error ? err.message : String(err));
        setMembers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [partnerId]);

  function close() {
    // Refresh server data so the partner row's member_count reflects
    // any add/remove that happened in this session.
    router.refresh();
    onClose();
  }

  async function invite() {
    setInviteError(null);
    setInviteSuccess(null);
    const email = inviteEmail.trim();
    if (!EMAIL_RE.test(email)) {
      setInviteError("Enter a valid email address.");
      return;
    }
    setInviting(true);
    try {
      const res = await fetch(`/api/admin/partners/${partnerId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        member?: Member | null;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setInviteError(humanizeInviteError(json.error, res.status));
        return;
      }
      setInviteSuccess(`Added ${email} as ${inviteRole}.`);
      setInviteEmail("");
      setInviteRole("viewer");
      if (json.member) {
        // Replace existing soft-removed row if present, else append.
        setMembers((prev) => {
          const filtered = (prev ?? []).filter(
            (m) => m.id !== json.member!.id,
          );
          return [...filtered, json.member!].sort((a, b) =>
            a.created_at.localeCompare(b.created_at),
          );
        });
      }
    } finally {
      setInviting(false);
    }
  }

  async function setRole(member: Member, nextRole: "admin" | "viewer") {
    if (member.role === nextRole) return;
    setPendingMemberId(member.id);
    try {
      const res = await fetch(
        `/api/admin/partners/${partnerId}/members/${member.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: nextRole }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setListError(json.error ?? `request failed (${res.status})`);
        return;
      }
      setMembers((prev) =>
        (prev ?? []).map((m) =>
          m.id === member.id ? { ...m, role: nextRole } : m,
        ),
      );
      setListError(null);
    } finally {
      setPendingMemberId(null);
    }
  }

  async function remove(member: Member) {
    const ok = window.confirm(
      `Remove ${member.email} from ${partnerName}?\n\nThey lose access to /p/[slug] for this partner immediately. Re-add by inviting again.`,
    );
    if (!ok) return;
    setPendingMemberId(member.id);
    try {
      const res = await fetch(
        `/api/admin/partners/${partnerId}/members/${member.id}`,
        { method: "DELETE" },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setListError(json.error ?? `request failed (${res.status})`);
        return;
      }
      setMembers((prev) => (prev ?? []).filter((m) => m.id !== member.id));
      setListError(null);
    } finally {
      setPendingMemberId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4 pt-12"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-moonbeem-black p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 font-wordmark text-heading-md text-moonbeem-pink">
              Members
            </h2>
            <p className="mt-1 text-caption text-moonbeem-ink-subtle">
              {partnerName}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-md border border-white/10 px-2 py-1 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            ✕
          </button>
        </div>

        <div className="mt-6">
          {members === null ? (
            <p className="text-body-sm text-moonbeem-ink-subtle">Loading…</p>
          ) : members.length === 0 ? (
            <p className="text-body-sm text-moonbeem-ink-subtle">
              No members yet — invite one below.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-white/5">
              {members.map((m) => {
                const busy = pendingMemberId === m.id;
                const otherRole = m.role === "admin" ? "viewer" : "admin";
                return (
                  <li
                    key={m.id}
                    className="flex flex-wrap items-center gap-3 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body-sm text-moonbeem-ink">
                        {m.email}
                      </div>
                      <div className="text-caption text-moonbeem-ink-subtle">
                        joined {new Date(m.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-caption font-medium ${
                        m.role === "admin"
                          ? "bg-moonbeem-pink/15 text-moonbeem-pink"
                          : "bg-white/10 text-moonbeem-ink-muted"
                      }`}
                    >
                      {m.role}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRole(m, otherRole)}
                      disabled={busy}
                      className="rounded-md border border-white/10 px-2.5 py-1 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink disabled:opacity-40"
                    >
                      Make {otherRole}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(m)}
                      disabled={busy}
                      className="rounded-md border border-moonbeem-magenta/40 px-2.5 py-1 text-caption text-moonbeem-magenta hover:bg-moonbeem-magenta/10 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {listError && (
            <p className="mt-3 text-caption text-moonbeem-magenta">
              {listError}
            </p>
          )}
        </div>

        <div className="mt-8 border-t border-white/5 pt-6">
          <h3 className="m-0 text-body font-medium text-moonbeem-ink">
            Invite member
          </h3>
          <p className="mt-1 text-caption text-moonbeem-ink-subtle">
            Members must already have a Moonbeem account (signed in via Google
            once). Real invite-with-email is on the roadmap.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-caption text-moonbeem-ink-subtle">
              Email
              <input
                ref={emailRef}
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@partner.com"
                className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-caption text-moonbeem-ink-subtle">
              Role
              <select
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(e.target.value as "admin" | "viewer")
                }
                className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-body-sm text-moonbeem-ink focus:border-moonbeem-pink focus:outline-none"
              >
                <option value="viewer">viewer</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button
              type="button"
              onClick={invite}
              disabled={inviting || inviteEmail.trim().length === 0}
              className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {inviting ? "Adding…" : "Invite"}
            </button>
          </div>
          {inviteError && (
            <p className="mt-3 text-caption text-moonbeem-magenta">
              {inviteError}
            </p>
          )}
          {inviteSuccess && (
            <p className="mt-3 text-caption text-emerald-300">
              {inviteSuccess}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function humanizeInviteError(code: string | undefined, status: number): string {
  if (!code) return `Request failed (${status}).`;
  if (code === "user_not_found") {
    return "No Moonbeem account for that email. Have them sign in to Moonbeem first via Google OAuth, then try again.";
  }
  if (code === "already_member") {
    return "This user is already an active member of this partner.";
  }
  if (code === "invalid_email") return "Enter a valid email address.";
  if (code === "invalid_role") return "Pick a valid role.";
  if (code === "partner_not_found") {
    return "Partner no longer exists — refresh the page.";
  }
  return code;
}
