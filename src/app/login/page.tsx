"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Status = "idle" | "sending" | "sent" | "error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
      return;
    }

    setStatus("sent");
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-12 px-6 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <h1 className="font-wordmark font-bold text-display-xl text-moonbeem-pink m-0">
        moonbeem.
      </h1>

      {status === "sent" ? (
        <p className="text-body-lg text-moonbeem-ink-muted text-center max-w-md">
          Check your email for the sign-in link.
        </p>
      ) : (
        <form
          onSubmit={onSubmit}
          className="w-full max-w-sm flex flex-col gap-4"
        >
          <label
            htmlFor="email"
            className="text-body-sm text-moonbeem-ink-muted"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status === "sending"}
            placeholder="you@example.com"
            className="w-full bg-transparent border border-moonbeem-border-strong rounded-md px-4 py-3 text-body text-moonbeem-ink placeholder:text-moonbeem-ink-subtle focus:outline-none focus:border-moonbeem-pink transition-colors"
          />
          <button
            type="submit"
            disabled={status === "sending" || !email}
            className="w-full bg-moonbeem-pink text-moonbeem-navy rounded-md px-4 py-3 text-body font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {status === "sending" ? "Sending..." : "Send magic link"}
          </button>
          {status === "error" && (
            <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
          )}
        </form>
      )}
    </div>
  );
}
