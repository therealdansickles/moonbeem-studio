"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { trackSigninStart } from "@/lib/analytics/track";

type Status = "idle" | "sending" | "sent" | "error";

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  function buildCallbackUrl(): string {
    const callbackParams = new URLSearchParams();
    const passthrough = [
      "redirect_to",
      "action",
      "title_id",
      "title",
      "request_type",
    ];
    for (const key of passthrough) {
      const value = searchParams.get(key);
      if (value) callbackParams.set(key, value);
    }
    return (
      `${window.location.origin}/auth/callback` +
      (callbackParams.size > 0 ? `?${callbackParams.toString()}` : "")
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg("");
    trackSigninStart({ method: "email_otp" });

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: buildCallbackUrl(),
      },
    });

    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
      return;
    }

    setStatus("sent");
  }

  async function onGoogleSignIn() {
    setStatus("sending");
    setErrorMsg("");
    trackSigninStart({ method: "google" });

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: buildCallbackUrl(),
      },
    });

    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
    }
    // On success the browser navigates to Google for consent; no
    // further state to set here.
  }

  const titleParam = searchParams.get("title");
  const action = searchParams.get("action");
  const headline =
    action === "request_fan_edits" && titleParam
      ? `Sign in to request fan edits for ${titleParam}.`
      : null;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-12 px-6">
      <h1 className="font-wordmark font-bold text-[clamp(2.5rem,12vw,6rem)] leading-[0.95] text-moonbeem-pink m-0">
        moonbeem.
      </h1>

      {status === "sent" ? (
        <p className="text-body-lg text-moonbeem-ink-muted text-center max-w-md">
          Check your email for the sign-in link.
        </p>
      ) : (
        <div className="w-full max-w-sm flex flex-col gap-4">
          {headline && (
            <p className="text-body text-moonbeem-ink text-center">
              {headline}
            </p>
          )}

          <button
            type="button"
            onClick={onGoogleSignIn}
            disabled={status === "sending"}
            className="w-full flex items-center justify-center gap-3 bg-white text-moonbeem-navy rounded-md px-4 py-3 text-body font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
              />
            </svg>
            Continue with Google
          </button>

          <div className="flex items-center gap-3 text-caption text-moonbeem-ink-subtle">
            <div className="flex-1 border-t border-white/10" />
            <span>or</span>
            <div className="flex-1 border-t border-white/10" />
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
          </form>

          {status === "error" && (
            <p className="text-body-sm text-moonbeem-magenta">{errorMsg}</p>
          )}
        </div>
      )}
    </div>
  );
}
