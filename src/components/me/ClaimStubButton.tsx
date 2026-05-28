"use client";

// Claim button for the /me "Edits to claim" section. POSTs to the
// merge_stub_creator API route, which runs the security gate inside
// the SECURITY DEFINER RPC. On success router.refresh() re-renders
// the server component; the stub disappears from the section because
// its creators.deleted_at is now set and
// getUnclaimedStubEditsForUser filters it out.
//
// Replaces the previous "Verify to claim →" Link for stubs surfaced
// by the verified_social heuristic AND for user_handle-surfaced
// stubs where the caller has already verified that platform (the
// case where the verify-then-merge flow silently dead-ends because
// VerifySocialsCard skips already-verified platforms).

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchJson,
  FetchJsonError,
  RateLimitedError,
} from "@/lib/fetch-json";

type Props = {
  stubCreatorId: string;
};

export default function ClaimStubButton({ stubCreatorId }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setErrorMsg(null);
    try {
      await fetchJson(`/api/me/stubs/${stubCreatorId}/claim`, {
        method: "POST",
      });
      router.refresh();
    } catch (err) {
      setErrorMsg(
        err instanceof RateLimitedError || err instanceof FetchJsonError
          ? err.userMessage
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setPending(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="text-body-sm text-moonbeem-pink hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Claiming…" : "Claim these edits"}
      </button>
      {errorMsg && (
        <p className="m-0 text-caption text-moonbeem-magenta">{errorMsg}</p>
      )}
    </div>
  );
}
