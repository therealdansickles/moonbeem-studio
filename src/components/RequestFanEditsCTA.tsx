"use client";

import { useState } from "react";

type Props = {
  titleId: string;
  titleName: string;
  titleSlug: string;
};

type Status = "idle" | "submitting" | "done" | "error";

export default function RequestFanEditsCTA({
  titleId,
  titleName,
  titleSlug,
}: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function onClick() {
    if (status === "submitting" || status === "done") return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/titles/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title_id: titleId,
          redirect_to: `/t/${titleSlug}`,
          title_name: titleName,
          request_type: "fan_edits",
        }),
      });

      if (res.status === 401) {
        const data = (await res.json().catch(() => ({}))) as {
          requires_auth?: boolean;
          redirect_to?: string;
        };
        if (data.requires_auth && data.redirect_to) {
          window.location.href = data.redirect_to;
          return;
        }
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 200) || `request ${res.status}`);
      }
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const label =
    status === "done"
      ? "Requested ✓"
      : status === "submitting"
        ? "Requesting..."
        : `Request fan edits for ${titleName}`;

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={status === "submitting" || status === "done"}
        className="bg-moonbeem-pink text-moonbeem-navy rounded-md px-6 py-3 text-body font-semibold hover:opacity-90 disabled:opacity-60 disabled:cursor-default transition-opacity"
      >
        {label}
      </button>
      {status === "error" && (
        <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
      )}
    </div>
  );
}
