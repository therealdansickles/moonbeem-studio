import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/dal";
import HandlePicker from "./HandlePicker";

export default async function OnboardingHandlePage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.handle) redirect("/me");

  return <HandlePicker />;
}
