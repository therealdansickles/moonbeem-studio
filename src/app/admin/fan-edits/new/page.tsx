import { requireSuperAdmin } from "@/lib/dal";
import SingleUploadClient from "./SingleUploadClient";

export const metadata = {
  title: "Add fan edit — Moonbeem admin",
};

export default async function Page() {
  await requireSuperAdmin();
  return <SingleUploadClient />;
}
