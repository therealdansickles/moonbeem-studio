import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/dal";
import { safeInternalRedirect } from "@/lib/auth/redirect";
import LoginForm from "./LoginForm";

// Server wrapper: bounce a signed-in user before the form ever renders. A
// signed-OUT user (including the /login?error=auth_failed path) falls through to
// the client form exactly as before. Destination: a validated same-origin
// redirect_to (safeInternalRedirect reuses runPostAuth's safeRedirect rule + the
// shared neutralizeAuthWrapper, and rejects protocol-relative open-redirects),
// else /me.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_to?: string | string[] }>;
}) {
  const user = await getUser();
  if (user) {
    const { redirect_to } = await searchParams;
    const rt = Array.isArray(redirect_to) ? redirect_to[0] : redirect_to;
    redirect(safeInternalRedirect(rt ?? null) ?? "/me");
  }

  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
