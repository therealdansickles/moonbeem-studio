import { requireSuperAdmin } from "@/lib/dal";
import BulkUploadClient from "./BulkUploadClient";

export const metadata = {
  title: "Bulk fan-edit upload — Moonbeem admin",
};

export default async function Page() {
  await requireSuperAdmin();
  return <BulkUploadClient />;
}
