// Partner dashboard — public-but-obscure URL at /p/[slug].
//
// v1 has one partner (1-2 Special, slug '1-2-special') and no auth
// gate; partners bookmark the URL. Multi-tenant ready: data already
// scoped by titles.partner_id, just add RLS / membership when a
// second partner onboards.
//
// All reads via service-role client on the server. RLS on the
// underlying tables (fan_edits, fan_edit_events, external_clicks,
// view_tracking_snapshots) doesn't have public SELECT policies, so
// service role is required.

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/supabase/service";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const supabase = createServiceRoleClient();
  const { data: partner } = await supabase
    .from("partners")
    .select("name")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) return { title: "Partner dashboard" };
  return {
    title: `${partner.name} · Moonbeem partner dashboard`,
    robots: { index: false, follow: false },
  };
}

type HeroMetrics = {
  total_views: number;
  unique_creators: number;
  modal_opens: number;
  ticket_clicks: number;
};

async function loadHeroMetrics(
  supabase: ReturnType<typeof createServiceRoleClient>,
  titleIds: string[],
): Promise<HeroMetrics> {
  if (titleIds.length === 0) {
    return {
      total_views: 0,
      unique_creators: 0,
      modal_opens: 0,
      ticket_clicks: 0,
    };
  }

  const { data: fanEdits } = await supabase
    .from("fan_edits")
    .select("id, view_count, creator_id")
    .in("title_id", titleIds)
    .eq("view_tracking_status", "active");

  const fanEditRows = fanEdits ?? [];
  const totalViews = fanEditRows.reduce(
    (sum, fe) => sum + ((fe.view_count as number | null) ?? 0),
    0,
  );
  const uniqueCreators = new Set(
    fanEditRows
      .map((fe) => fe.creator_id as string | null)
      .filter((id): id is string => !!id),
  ).size;
  const fanEditIds = fanEditRows.map((fe) => fe.id as string);

  const [modalOpensRes, ticketClicksRes] = await Promise.all([
    fanEditIds.length > 0
      ? supabase
        .from("fan_edit_events")
        .select("id", { count: "exact", head: true })
        .eq("event_type", "modal_open")
        .in("fan_edit_id", fanEditIds)
      : Promise.resolve({ count: 0 } as { count: number | null }),
    supabase
      .from("external_clicks")
      .select("id", { count: "exact", head: true })
      .in("title_id", titleIds)
      .not("title_offer_id", "is", null),
  ]);

  return {
    total_views: totalViews,
    unique_creators: uniqueCreators,
    modal_opens: modalOpensRes.count ?? 0,
    ticket_clicks: ticketClicksRes.count ?? 0,
  };
}

// Compact-format a metric: 1234 → "1.2K", 1200000 → "1.2M".
function formatMetric(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  const m = n / 1_000_000;
  return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
}

function HeroTile({
  value,
  label,
  sub,
}: {
  value: string;
  label: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="font-wordmark text-display-md text-moonbeem-pink leading-none">
        {value}
      </div>
      <div className="mt-2 text-body font-medium text-moonbeem-ink">
        {label}
      </div>
      {sub && (
        <div className="mt-1 text-caption text-moonbeem-ink-subtle">{sub}</div>
      )}
    </div>
  );
}

export default async function PartnerDashboardPage({ params }: PageProps) {
  const { slug } = await params;
  const supabase = createServiceRoleClient();

  const { data: partner, error: partnerErr } = await supabase
    .from("partners")
    .select("id, slug, name, logo_url")
    .eq("slug", slug)
    .maybeSingle();
  if (partnerErr || !partner) notFound();

  const { data: titles } = await supabase
    .from("titles")
    .select("id, slug, title")
    .eq("partner_id", partner.id);
  const titleRows = titles ?? [];
  const titleIds = titleRows.map((t) => t.id as string);

  const metrics = await loadHeroMetrics(supabase, titleIds);

  const titleSummary = titleRows.length === 1
    ? titleRows[0].title
    : `${titleRows.length} titles`;

  return (
    <div className="min-h-screen px-6 py-12 bg-[radial-gradient(ellipse_at_top,_#1a0f3a_0%,_#0a0a14_60%)]">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between">
          <span className="font-wordmark text-heading-md text-moonbeem-pink">
            moonbeem.
          </span>
          {partner.logo_url
            ? (
              <img
                src={partner.logo_url as string}
                alt={partner.name as string}
                className="h-8 w-auto opacity-80"
              />
            )
            : (
              <span className="text-body-sm text-moonbeem-ink-subtle">
                Partner dashboard
              </span>
            )}
        </div>

        <div className="mt-10 flex flex-col gap-2">
          <h1 className="font-wordmark text-display-lg text-moonbeem-ink m-0">
            {partner.name}
          </h1>
          <p className="text-body text-moonbeem-ink-muted m-0">
            {titleSummary} · partnership dashboard
          </p>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <HeroTile
            value={formatMetric(metrics.total_views)}
            label="Total platform views"
            sub={`across ${titleRows.length === 1 ? "the title's" : "all"} fan edits`}
          />
          <HeroTile
            value={metrics.unique_creators.toLocaleString()}
            label="Unique fan creators"
          />
          <HeroTile
            value={formatMetric(metrics.modal_opens)}
            label="Moonbeem modal opens"
            sub="on-platform engagement"
          />
          <HeroTile
            value={metrics.ticket_clicks.toLocaleString()}
            label="Ticket click-throughs"
            sub="outbound to listings"
          />
        </div>

        <div className="mt-12 rounded-2xl border border-dashed border-white/10 p-10 text-center text-body-sm text-moonbeem-ink-subtle">
          Top performers, top creators, growth chart, and full fan-edit
          table — coming next.
        </div>
      </div>
    </div>
  );
}
