// /admin/marquee — super-admin curation of the homepage partner logo
// strip. Mirrors /admin/featured:
//   1. Drag-and-drop reorder of currently-visible partners
//   2. X button to hide a partner from the marquee (PATCH visibility
//      false; partner stays a partner, drops from strip)
//   3. "Add to Marquee" list of currently-hidden partners + Add button
//      (PATCH visibility true; appended to end via nextMarqueeOrder)
//
// Homepage strip filters logo_url IS NOT NULL in addition to
// is_marquee_visible. Partners without a logo can be marquee-visible
// without rendering — they hold their slot and show up once they
// upload one.

import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import MarqueeCurator, { type MarqueePartner } from "./MarqueeCurator";

export const metadata: Metadata = {
  title: "Marquee curation · Moonbeem admin",
  robots: { index: false, follow: false },
};

export default async function AdminMarqueePage() {
  await requireSuperAdminOr404();
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("partners")
    .select("id, slug, name, logo_url, is_marquee_visible, marquee_order")
    .order("is_marquee_visible", { ascending: false })
    .order("marquee_order", { ascending: true })
    .order("name", { ascending: true });

  const rows = (data ?? []) as MarqueePartner[];
  const visible = rows.filter((r) => r.is_marquee_visible);
  const hidden = rows.filter((r) => !r.is_marquee_visible);

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Marquee curation
          </h1>
          <Link
            href="/admin"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Back to admin
          </Link>
        </div>
        <p className="text-body text-moonbeem-ink-muted m-0">
          Curate the homepage partner logo strip. Drag to reorder; ×
          to hide. Add a hidden partner using the list at the bottom.
          Partners without a logo hold their slot but don&apos;t render
          on the homepage until they upload one.
        </p>
        {error && (
          <p className="text-body-sm text-moonbeem-magenta">
            Failed to load partners: {error.message}
          </p>
        )}
        <MarqueeCurator initialVisible={visible} initialHidden={hidden} />
      </div>
    </div>
  );
}
