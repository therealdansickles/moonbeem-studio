import { verifySession } from "@/lib/dal";
import { SignOutButton } from "@/components/SignOutButton";

export default async function MePage() {
  const { email } = await verifySession();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-10 px-6 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <h1 className="font-wordmark font-bold text-display-md text-moonbeem-pink m-0">
        moonbeem.
      </h1>
      <p className="text-body-lg text-moonbeem-ink-muted text-center">
        Signed in as <span className="text-moonbeem-ink">{email}</span>
      </p>
      <SignOutButton />
    </div>
  );
}
