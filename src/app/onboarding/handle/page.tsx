import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/dal";
import HandlePicker from "./HandlePicker";

type Props = {
  searchParams: Promise<{
    next?: string;
    request_submitted?: string;
    title?: string;
  }>;
};

export default async function OnboardingHandlePage({ searchParams }: Props) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const params = await searchParams;
  const next =
    params.next && params.next.startsWith("/") ? params.next : null;

  if (profile.handle) {
    const tail = (() => {
      const p = new URLSearchParams();
      if (params.request_submitted === "1") {
        p.set("request_submitted", "1");
        if (params.title) p.set("title", params.title);
      }
      const s = p.toString();
      return s ? `?${s}` : "";
    })();
    redirect(`${next ?? "/me"}${tail}`);
  }

  return (
    <HandlePicker
      next={next}
      requestSubmittedTitle={
        params.request_submitted === "1" ? params.title ?? null : null
      }
    />
  );
}
