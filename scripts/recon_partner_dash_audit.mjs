// READ-ONLY audit for the 1-2 Special / Erupcja partner dashboard.
// Runs the exact predicates each dashboard metric uses and reports
// row counts + sums, so we can quantify rejected-edit contamination
// and the 2.6M-vs-2.2M gap before any fix is written.
//
// Does NOT update or insert anything. Safe to run against prod.

import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(SUPA_URL, SUPA_KEY);

const PARTNER_SLUG = "1-2-special";

function fmt(n) {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}
function hdr(s) {
  console.log("\n" + "=".repeat(70));
  console.log(s);
  console.log("=".repeat(70));
}

// 0. Identify partner + title set ------------------------------------
hdr(`Partner = ${PARTNER_SLUG}`);
const { data: partner } = await sb
  .from("partners")
  .select("id, slug, name")
  .eq("slug", PARTNER_SLUG)
  .maybeSingle();
if (!partner) { console.error("partner not found"); process.exit(1); }
console.log(`partner_id=${partner.id}  name=${partner.name}`);

const { data: titles } = await sb
  .from("titles")
  .select("id, slug, title, is_active")
  .eq("partner_id", partner.id)
  .is("deleted_at", null);
const titleRows = titles ?? [];
const titleIds = titleRows.map((t) => t.id);
const activeTitleIds = titleRows.filter((t) => t.is_active).map((t) => t.id);
console.log(`titles: ${titleRows.length} (active: ${activeTitleIds.length})`);

// 1. Status-column census of fan_edits for the partner's titles -----
hdr("fan_edits status census (.in(title_id, partnerTitles))");
const { data: allFE } = await sb
  .from("fan_edits")
  .select(
    "id, title_id, creator_id, view_count, verification_status, is_active, view_tracking_status, deleted_at, created_at, created_by_user_id, rejection_reason, embed_url, platform",
  )
  .in("title_id", titleIds);
const fe = allFE ?? [];
console.log(`total rows for partner titles: ${fe.length}`);

const groupBy = (arr, fn) => {
  const m = new Map();
  for (const r of arr) m.set(fn(r), (m.get(fn(r)) ?? 0) + 1);
  return [...m.entries()].sort();
};
console.log("\nby verification_status:");
for (const [k, v] of groupBy(fe, (r) => r.verification_status)) console.log(`  ${k.padEnd(20)} ${v}`);
console.log("\nby view_tracking_status:");
for (const [k, v] of groupBy(fe, (r) => r.view_tracking_status)) console.log(`  ${k.padEnd(20)} ${v}`);
console.log("\nby is_active:");
for (const [k, v] of groupBy(fe, (r) => String(r.is_active))) console.log(`  ${k.padEnd(20)} ${v}`);
console.log("\nby deleted_at IS NULL:");
for (const [k, v] of groupBy(fe, (r) => r.deleted_at === null ? "null" : "deleted")) console.log(`  ${k.padEnd(20)} ${v}`);

// 2. Cross-tab: verification_status × view_tracking_status × is_active × deleted_at
hdr("cross-tab: verification × view_tracking × is_active × deleted");
const cross = new Map();
for (const r of fe) {
  const k = `vs=${r.verification_status} | vts=${r.view_tracking_status} | active=${r.is_active} | del=${r.deleted_at === null ? "null" : "set"}`;
  if (!cross.has(k)) cross.set(k, { count: 0, sumViews: 0 });
  const cell = cross.get(k);
  cell.count++;
  cell.sumViews += r.view_count ?? 0;
}
for (const [k, v] of [...cross.entries()].sort()) {
  console.log(`  ${k}  →  rows=${v.count}  sum(view_count)=${fmt(v.sumViews)}`);
}

// 3. Replay each dashboard query's predicate ------------------------
const predicates = [
  {
    name: "Total platform views / Unique creators / All edits / Top edits / Top editors / Growth (population)",
    label: "view_tracking_status='active' AND deleted_at IS NULL",
    filter: (r) => r.view_tracking_status === "active" && r.deleted_at === null,
  },
  {
    name: "Growth chart edit_count series",
    label: "deleted_at IS NULL  (no other filter)",
    filter: (r) => r.deleted_at === null,
  },
  {
    name: "Window-scoped analytics (loadPartnerAnalytics)",
    label: "is_active=true AND verification_status='auto_verified' AND deleted_at IS NULL  (on active titles only)",
    filter: (r) => r.is_active === true && r.verification_status === "auto_verified" && r.deleted_at === null && activeTitleIds.includes(r.title_id),
  },
  {
    name: "earnings-calc (creator_earnings → fan_edits)",
    label: "view_tracking_status='active' AND deleted_at IS NULL AND creator_id IS NOT NULL",
    filter: (r) => r.view_tracking_status === "active" && r.deleted_at === null && r.creator_id !== null,
  },
  {
    name: "CANONICAL (implemented at A1/A2/A3/A4/A5/A6/A7 post-fix 2026-05-16)",
    label: "is_active=true AND verification_status IN ('auto_verified','approved') AND deleted_at IS NULL",
    filter: (r) => r.is_active === true && (r.verification_status === "auto_verified" || r.verification_status === "approved") && r.deleted_at === null,
  },
  {
    name: "CANONICAL scoped to active titles (mirrors A6's activeTitleIds filter)",
    label: "is_active=true AND vs IN ('auto_verified','approved') AND deleted_at IS NULL  (on active titles only)",
    filter: (r) => r.is_active === true && (r.verification_status === "auto_verified" || r.verification_status === "approved") && r.deleted_at === null && activeTitleIds.includes(r.title_id),
  },
];
hdr("predicate replay");
for (const p of predicates) {
  const rows = fe.filter(p.filter);
  const sumViews = rows.reduce((s, r) => s + (r.view_count ?? 0), 0);
  const uniqCreators = new Set(rows.map((r) => r.creator_id).filter((x) => x !== null)).size;
  console.log(`• ${p.name}`);
  console.log(`    ${p.label}`);
  console.log(`    rows=${rows.length}  sum(view_count)=${fmt(sumViews)}  uniqCreators=${uniqCreators}`);
}

// 4. Specifically list the rejected rows ----------------------------
hdr("rejected fan_edits (the contamination)");
const rejected = fe.filter((r) => r.verification_status === "rejected");
console.log(`count: ${rejected.length}`);
for (const r of rejected) {
  const t = titleRows.find((x) => x.id === r.title_id);
  console.log(`  ${r.id}  title="${t?.title}"  platform=${r.platform}  views=${fmt(r.view_count)}  is_active=${r.is_active}  vts=${r.view_tracking_status}  del=${r.deleted_at}  embed=${r.embed_url?.slice(0, 80)}`);
}

// 4b. Pending rows too (also contaminate today)
hdr("pending fan_edits");
const pending = fe.filter((r) => r.verification_status === "pending");
console.log(`count: ${pending.length}`);
for (const r of pending) {
  const t = titleRows.find((x) => x.id === r.title_id);
  console.log(`  ${r.id}  title="${t?.title}"  platform=${r.platform}  views=${fmt(r.view_count)}  is_active=${r.is_active}  vts=${r.view_tracking_status}  del=${r.deleted_at}`);
}

// 4c. Anything with view_tracking_status != 'active' but deleted_at IS NULL
hdr("fan_edits with view_tracking_status != 'active' (deleted_at IS NULL)");
const inactiveTracking = fe.filter((r) => r.view_tracking_status !== "active" && r.deleted_at === null);
console.log(`count: ${inactiveTracking.length}  (these account for growth-edit-count - all-edits-table gap)`);
for (const r of inactiveTracking) {
  console.log(`  ${r.id}  vts=${r.view_tracking_status}  is_active=${r.is_active}  vs=${r.verification_status}  views=${fmt(r.view_count)}`);
}

// 5. The 2.6M vs 2.2M gap — snapshot-derived sum vs view_count sum --
hdr("snapshot-derived vs live view_count sum");
// Use the same population that loadAllEdits feeds to loadDailyGrowth:
// view_tracking_status='active' AND deleted_at IS NULL.
const popRows = fe.filter((r) => r.view_tracking_status === "active" && r.deleted_at === null);
const popIds = popRows.map((r) => r.id);
const liveSum = popRows.reduce((s, r) => s + (r.view_count ?? 0), 0);
console.log(`population (vts=active, del IS NULL): ${popIds.length} fan_edits`);
console.log(`live sum of fan_edits.view_count: ${fmt(liveSum)}  (this is the hero "Total platform views")`);

// Fetch all snapshots for this population. May be large but bounded.
let allSnaps = [];
const CHUNK = 200;
for (let i = 0; i < popIds.length; i += CHUNK) {
  const chunk = popIds.slice(i, i + CHUNK);
  const { data, error } = await sb
    .from("view_tracking_snapshots")
    .select("fan_edit_id, view_count, captured_at")
    .in("fan_edit_id", chunk)
    .order("captured_at", { ascending: true });
  if (error) { console.error("snapshot fetch error:", error); break; }
  allSnaps.push(...(data ?? []));
}
console.log(`snapshot rows fetched: ${allSnaps.length}`);

// Replicate loadDailyGrowth's last-day cumulative (forward-fill across days, sum)
const perEditPerDay = new Map();
const allDays = new Set();
for (const s of allSnaps) {
  const day = s.captured_at.slice(0, 10);
  allDays.add(day);
  let editMap = perEditPerDay.get(s.fan_edit_id);
  if (!editMap) { editMap = new Map(); perEditPerDay.set(s.fan_edit_id, editMap); }
  const existing = editMap.get(day) ?? 0;
  if ((s.view_count ?? 0) > existing) editMap.set(day, s.view_count ?? 0);
}
const days = [...allDays].sort();
let lastDay = days[days.length - 1] ?? null;
console.log(`tracking window: ${days[0] ?? "—"} → ${lastDay ?? "—"}  (${days.length} day-buckets)`);

// Walk every day, forward-fill per edit
const editLatest = new Map();
let snapshotLatestSum = 0;
for (const d of days) {
  for (const [fid, dayMap] of perEditPerDay) {
    if (dayMap.has(d)) editLatest.set(fid, dayMap.get(d));
  }
}
for (const v of editLatest.values()) snapshotLatestSum += v;
console.log(`snapshot-derived "latest" sum: ${fmt(snapshotLatestSum)}  (this is what the growth chart's last point shows)`);
console.log(`difference (live - snapshot-latest): ${fmt(liveSum - snapshotLatestSum)}`);

// How many edits in the population have NO snapshots at all?
const haveSnap = new Set(allSnaps.map((s) => s.fan_edit_id));
const noSnap = popRows.filter((r) => !haveSnap.has(r.id));
const noSnapViews = noSnap.reduce((s, r) => s + (r.view_count ?? 0), 0);
console.log(`edits in population with zero snapshots: ${noSnap.length}  sum(view_count)=${fmt(noSnapViews)}`);

// Per-edit gap: live view_count - latest-snapshot view_count
const perEditGap = [];
for (const r of popRows) {
  const latest = editLatest.get(r.id) ?? 0;
  const gap = (r.view_count ?? 0) - latest;
  if (gap !== 0) perEditGap.push({ id: r.id, live: r.view_count ?? 0, snapshot: latest, gap });
}
perEditGap.sort((a, b) => b.gap - a.gap);
console.log(`edits where live > snapshot: ${perEditGap.filter((x) => x.gap > 0).length}`);
console.log(`top 10 gaps (live vs snapshot-latest):`);
for (const x of perEditGap.slice(0, 10)) console.log(`  ${x.id}  live=${fmt(x.live)}  snap=${fmt(x.snapshot)}  gap=${fmt(x.gap)}`);

// 6. fan_edit_events count for rejected/pending rows ---------------
hdr("Moonbeem plays attributable to rejected/pending edits");
const contaminatedIds = [...rejected.map((r) => r.id), ...pending.map((r) => r.id)];
if (contaminatedIds.length > 0) {
  const { count } = await sb
    .from("fan_edit_events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "modal_open")
    .in("fan_edit_id", contaminatedIds);
  console.log(`modal_open events on rejected+pending edits: ${count ?? 0}`);
} else {
  console.log("no rejected/pending — no events to check");
}

console.log("\nDONE");
