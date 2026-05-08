// Deprecated: fan-edits CSV import is now scoped to a specific title
// at /admin/titles/[slug]?tab=upload. Visitors landing here go back
// to /admin to pick a title.

import { redirect } from "next/navigation";

export default function DeprecatedFanEditsUploadRoute() {
  redirect("/admin");
}
