import { requireSuperAdmin } from "@/lib/dal";
import { getPendingFanEditQueue } from "@/lib/queries/titles";
import QueueClient from "./QueueClient";

export const metadata = {
  title: "Fan edit queue — Moonbeem admin",
};

export default async function Page() {
  await requireSuperAdmin();
  const rows = await getPendingFanEditQueue(50, 0);
  return <QueueClient initialRows={rows} />;
}
