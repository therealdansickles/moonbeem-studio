# Rights & Attribution Pass — Implementation Plan (v2, post-adversarial-review)

Status: PLAN ONLY. Nothing here is implemented. Drafted 2026-07-13 from same-day
recon; v2 incorporates a three-lens adversarial review (code-reality,
money-safety, platform-facts). Code cites were file-opened and DB claims were
live-queried this session.

Scope: C1 playback-token binding, C2 checkout territory gate, C3 click-id
attribution thread, C4 Mux Data player metadata. C2 and C3 are money-adjacent;
C1 touches the playback gate; C4 is telemetry with one consent decision.

Standing constraints that bind this pass:
- **Webhook-reader-first deploy order** (C3): Vercel previews share the prod DB
  and the prod Stripe webhook target. Any metadata-contract change ships the
  webhook READER first (tolerating the key's absence), fully deployed, before
  any surface writes the new key.
- **No money-math changes anywhere.** C3 adds a traceability column; the split
  arithmetic (settle cron :250-256) is untouched byte-for-byte.
- Any prod data UPDATE used for testing gets a before/after confirmation SELECT
  and an explicit revert, stated inline below.

---

## C1. Playback-token binding + TTL reduction

> **STATUS: BUILT 2026-07-13, then AMENDED 2026-07-14 after the edge probe
> falsified its central premise.** See the struck paragraph below — the TTL does
> NOT stop a lapsed rental. What shipped, and why:
> - TTL 12h→**4h** on both sites. **KEPT**, on a CORRECTED rationale: it cuts 3x
>   the window in which a **leaked DRM token can acquire a decryption key**.
>   Exposure from a leak is **one session**, not unbounded (both proven).
> - Refresh path **KEPT, relabelled**: network-error recovery + 403'd-manifest
>   recovery, and the hook C1b will need. It does NOT terminate lapsed rentals.
> - Territory → pure predicate + 10 unit tests. Unaffected, a clean win.
> - `stampFirstPlay` load-bearing comment. Unaffected.
> - **The CHANGELOG entry was DELETED** — it claimed "a rental that lapses
>   mid-session now stops," which is false. It never shipped.
>
> Viewer claim **INCLUDED, on `signPlaybackId` only**; the DRM-license leg stays
> plain. **Acceptance criterion 1 amended:** the Mux SDK mints **no `iat` claim**
> (payload is `kid`/`sub`/`aud`/`exp`), so TTL is verified as **`exp - now ≈ 4h`**.
> Acceptance runs 2 and 3 are **VOID** — they tested a refresh-on-expiry that the
> edge makes impossible. Run 1 (decoded JWT) passed.
>
> **PROBE RESULT (2026-07-13) — the gate the viewer claim rode on.** Signed three
> playback tokens for a real published DRM asset and fetched the HLS manifest for
> each: control (no extra claims) **200**, `viewer_user_id` claim **200**, pure
> **gibberish** claim **200**. Mux ignores unrecognized claims wholesale. So the
> claim cannot break playback — and it enforces NOTHING. It is forensic only: it
> names the account that minted a leaked token. Enforcement = TTL + the re-mint
> gate stack.
>
> ~~**THE ASYMMETRY THAT MAKES THE REFRESH A PREREQUISITE:** HeroPlayer mints on
> the play click; EpisodeModal mints on modal open, so an idle modal viewer holds
> a stale token and a 4h TTL would strand them without a refresh.~~
> **AMENDED 2026-07-14.** The mount-timing difference is REAL, but the conclusion
> drawn from it was not: per the probe, an expired token does not strand an
> in-flight session at all (segments are ungated), so the refresh is not a
> prerequisite for the TTL cut. The two still ship in one commit — but because
> they are one coherent change, not because one rescues the other.

### Current state (recon, exhaustive)

Every Mux token mint in the repo — exactly three sites:

| Site | File | Kind | TTL | Pre-mint gates |
|---|---|---|---|---|
| A. Viewer playback | `src/app/api/episodes/[id]/playback-token/route.ts:128-132` | video playback + DRM license | 12h | rate-limit → visibility (`canViewTitle`) → territory 451 (`isTerritoryAllowed`) → live-derived entitlement gate 401/402 → `stampFirstPlay` |
| B. Creator self-preview | `src/app/api/me/hosting/titles/[id]/episodes/[episodeId]/playback-token/route.ts:95-98` | video playback + DRM license | 12h | auth → rate-limit → ownership (`authorizeCreatorTitleMutation`) → episode↔title rebind |
| C. Panel thumbnails | `src/lib/panel/thumbnail.ts:30-35` | still-image token (`type: "thumbnail"`) | 1h | none per-viewer (panel Bearer token gates the route) |

The JWTs carry playbackId + expiration only — no viewer claim (Sites A/B). A
minted token is a shareable bearer pass for its full TTL; entitlement/
territory/window are checked at mint time only. An expired rental keeps
playing until the token dies (≤12h overhang today).

Site C is kind-distinct (image, already 1h) — out of scope for binding.

~~What "the token dies" actually means (DRM nuance, reviewed): the playback JWT
gates NEW manifest/segment fetches and the drm token gates NEW license
requests. An already-granted CDM content key and already-buffered segments
keep decrypting locally for a short tail past expiry. TTL bounds the window
for new requests; it is NOT a frame-exact kill switch, and no Mux-side knob
ties CDM key persistence to the JWT exp.~~

**⚠️ STRUCK 2026-07-14 — THIS PARAGRAPH WAS FALSE. It was an unprobed assumption
about Mux's edge, presented as reviewed fact, and it very nearly shipped a false
user-facing claim.** The probe (real published DRM asset,
`scripts/_one_shot_expiry_probe.mjs`):

| request, on an EXPIRED playback token | result |
|---|---|
| master `.m3u8` | **403** |
| variant `.m3u8` | **403** |
| segment #0 (re-fetch) | **200** |
| segment #1 (**never fetched before**) | **200** |
| segment URL carries its own `?token=` | **NO** |

**Segment URLs are unauthenticated.** The playback token gates the MANIFEST and
nothing else. An on-demand player fetches the manifest once, then holds all ~1,096
segment URLs — so it never needs the token again. It is not "a short tail past
expiry": **it is the entire film.** A rental that lapses mid-watch does not stop,
and no TTL value can make it stop.

**What the TTL is actually worth** (corrected rationale, Dan 2026-07-14): those
freely-fetchable segments are **ciphertext**. The real credential is the
**DRM-license token** — and the license endpoint DOES authenticate it (probed:
valid drm token → `400 Invalid Parameters`, i.e. past auth; **expired drm token →
`403 Not Authorized`**). So an expired token cannot acquire a decryption key.
Cutting 12h → 4h therefore cuts **3x the window in which a LEAKED token can
acquire a key and start a session** — and exposure from a leak is **ONE SESSION**,
not unbounded (a new session 403s on both the manifest and the license). That is a
real, narrow rights gain. It is **not** session termination.

**The lever that CAN terminate a session** is license duration — the
`licenseExpiration` / `playDuration` claims on the drm token, i.e. our two-clock
rule expressed in the license instead of Postgres. Designed in **C1b** below;
whether those claims work on a NON-persistent streaming license is UNKNOWN and
must be probed, not assumed.

### Proposed change

1. **TTL 12h → 4h on Site A; 12h → 1h on Site B** (one constant per route;
   playback and DRM-license tokens are minted together :129-132 — change both
   or neither, always TTL-synced).
   Defense of 4h against long-watch UX: the longest CURRENTLY-PLAYABLE title
   (has a published Mux episode) runs 91 minutes (live prod query,
   2026-07-13: `max(titles.runtime_min)` over titles with a published
   episode). 4h is >2.5x that plus pause slack. Today there is NO mid-stream
   token refresh (the player fetches once on mount/play-click:
   `MuxEpisodePlayer.tsx:51`, `me/CreatorEpisodePreview.tsx:39-42`), so TTL is
   the session ceiling for new segment fetches — 4h is the floor settable
   *without* the refresh path below; 12h→4h cuts the shareable-bearer and
   expired-rental overhang windows by 3x. Re-check this runtime premise when
   longer features are hosted; the refresh path below is what makes further
   TTL cuts safe.
2. **Refresh path with full re-check — a NEW mechanism, not an extension.**
   Reviewed finding: `MuxEpisodePlayer.tsx:59-63` is the status mapping inside
   the ONE-SHOT mint fetch (runs before the player mounts); the rendered
   `<MuxPlayer>` (:88-99) wires no `onError` today, and no code path reacts to
   a mid-stream playback/DRM error anywhere in the repo. The work is: add an
   `onError` handler (supported prop — `@mux/mux-player-react`
   `dist/types/types.d.ts:130`), classify the error event to distinguish
   token-expiry from network blips, re-POST the token route, swap tokens on
   the mounted player, cap at ONE retry. A re-mint re-runs ALL of Site A's
   gates (entitlement, territory, rental window) because they run on every
   POST — no new gate code server-side.
3. **Viewer claim**: embed the viewer's user id (or `anon`) in the token.
   Mechanics verified in the vendored SDK: `signPlaybackId(playbackId,
   { expiration, params })` passes `params` straight into the JWT payload as
   top-level claims (`@mux/mux-node` lib/jwt.js) — the same mechanism the
   panel already uses for thumbnail `width`. Remaining open question is only
   whether Mux's video edge tolerates arbitrary EXTRA claims on playback
   tokens — one throwaway curl test at implementation start.
   HONESTY NOTE for review: Mux does not enforce per-viewer binding on
   playback JWTs — the claim is forensic (which account minted a leaked
   token), NOT an access control. The enforcement lever is TTL + re-mint
   re-checks.

### Files touched
- `src/app/api/episodes/[id]/playback-token/route.ts` (TTL const, claim)
- `src/app/api/me/hosting/titles/[id]/episodes/[episodeId]/playback-token/route.ts` (TTL)
- `src/components/MuxEpisodePlayer.tsx` (new onError + token-swap + retry state)
- `src/components/me/CreatorEpisodePreview.tsx` (optional same)

### Schema changes
None.

### Failure modes
- Legit >4h session (long pause) hits expiry mid-stream → refresh re-mints; if
  the rental window lapsed during the pause, refresh returns 402 and NEW
  fetches stop (buffered tail may play out briefly — see DRM nuance above).
  Correct new behavior, but user-visible: release-note it.
- Refresh loop on a genuinely-expired entitlement: capped at one retry.
- Misclassifying a transient network error as token expiry → one wasted
  re-mint POST (rate-limited, harmless).

### Rollback
Revert the TTL constants (one line each); the client refresh path is inert
when tokens outlive sessions.

### Test evidence for Dan to screenshot
1. Decoded playback JWT (jwt.io) showing `exp - iat = 4h` and the viewer claim.
2. Dev build with TTL forced to 2min: video visibly continues across a token
   refresh (network tab showing the second POST mid-session).
3. Same forced-TTL build, rental window artificially lapsed: refresh POST
   returns 402 and the player shows the not-entitled state.

---

## C2. Checkout territory gate (money-adjacent)

### Current state
Playback enforces territory fail-closed and returns 451 before any DRM token
mints (`playback-token/route.ts:77-80`, `src/lib/playback/territory.ts`
fail-closed, unset = deny). The rent/buy route has NO geo gate — an
out-of-territory viewer can PAY for a title they will never be able to play.

Prod data (live query 2026-07-13, CORRECTED from the v1 draft): 24 of 26 live
public titles are `territory_worldwide=true`; TWO are not — "Going Dry"
(4c23083f…) and "Georgia O'Keeffe: The Brightness of Light" (16d1c226…), both
`territory_worldwide=false` with `allowed_territories=null`, i.e. default-deny
EVERYWHERE under territory.ts's own logic, today. The gate-never-fires-at-
launch property holds only by COINCIDENCE: both titles are unsellable
(`transact_enabled=false`, `purchase_enabled=false`, zero published episodes)
so the existing offer/published gates 400 first. Re-verify both titles'
territory state before enabling either for sale.

### Proposed change
In `src/app/api/titles/[id]/rent/route.ts`, AFTER the kind-aware double-pay
guard (:132-157) and BEFORE the Stripe session create (:225):

- read `x-vercel-ip-country`, call the SAME `isTerritoryAllowed(country, { id })`
  from `src/lib/playback/territory.ts` (single source — never reimplement), and
  return `451 { error: "territory_restricted" }` — mirroring the playback
  semantics including fail-closed on missing country for restricted titles.

Placement AFTER the double-pay guard (reviewed finding, changed from v1): an
already-entitled viewer who re-clicks Rent/Buy from a restricted location must
get `{already_entitled:true}` (the friendly "you already have this" path), not
a security-sounding 451 — they owe nothing and hold full rights; territory is
re-checked at playback anyway. Still strictly BEFORE
`stripe.checkout.sessions.create` so no session/idempotency-key state ever
exists for a blocked buyer. Note this placement means the rent→buy upgrade for
an existing renter now traveling out-of-territory is ALSO blocked at the gate
(they hold a rental, not a purchase, so `alreadyHas` is false for
kind=purchase) — acceptable: we won't sell someone a permanent copy they
can't play from where they are; revisit only if a partner asks.

Client: both button components need a 451 → human message case — there are TWO
independent components with duplicated error mapping, no shared hook:
`src/components/RentButton.tsx:40-64` and `src/components/BuyButton.tsx:41-69`
(today a 451 would render the generic "Couldn't start checkout
(territory_restricted)." fallback).

### Files touched
- `src/app/api/titles/[id]/rent/route.ts` (one gate block)
- `src/components/RentButton.tsx` (451 message)
- `src/components/BuyButton.tsx` (451 message)

### Schema changes
None.

### Failure modes
- **Unknown-country traffic is denied on restricted titles** (Apple Private
  Relay / some VPNs / any request where Vercel can't resolve geo omits the
  header; local dev always). This is the playback gate's existing posture
  extended to purchase — an ACCEPTED-RISK line item: worldwide titles (24/26
  today) are unaffected; for restricted titles we prefer a lost sale over an
  unplayable one. If it ever bites, the split is "soft-allow unknown at
  purchase, hard-deny at playback" — a deliberate future ruling, not this
  pass.
- **Enabled-but-unset-territory title**: if a partner flips
  `transact_enabled=true` on a `territory_worldwide=false` +
  `allowed_territories=null` title (two exist today), the gate blocks 100% of
  purchases worldwide — loudly visible, and correct under fail-closed
  doctrine, but worth a partner-facing validation (publish already 409s
  without declared territories; the two legacy titles predate that gate).
- Ordering: the gate must not move earlier than the double-pay guard (see
  placement rationale) nor later than session-create.

### Rollback
Delete the gate block + the two client message cases (self-contained; no state
written).

### Test evidence for Dan to screenshot
Prep (prod, reversible data-only UPDATE on a hidden/test title):
- confirmation SELECT before: `select id, territory_worldwide,
  allowed_territories, transact_enabled from titles where id = '<test title>';`
- `update titles set territory_worldwide=false, allowed_territories='{CA}'
  where id='<test title>';` then the same SELECT after; revert to worldwide
  after the test with a third SELECT.

1. Rent POST against the CA-only test title from a US IP → HTTP 451 in the
   network tab (no Stripe redirect), RentButton showing the human message.
2. Playback-token POST for the same title → 451 (parity screenshot).
3. Title reverted to worldwide → rent POST returns a checkout_url again.

---

## C3. Click-id attribution thread (money-adjacent: metadata contract)

### Current state (Break 1)
`/go/title` inserts an `external_clicks` row WITHOUT capturing its id
(`src/lib/click-logger.ts:94-96` — no `.select()`, `Promise<void>`) and sets
the `mb_aff` cookie `{creator_id, title_id, ts}`
(`src/app/go/title/route.ts:64-78`). The insert is already `await`ed before
the redirect returns, raced against a 100ms timeout (click-logger.ts:111-116)
— the ≤100ms bound is already paid on every /go/title hit today. The rent
route threads only `moonbeem_creator_id` into Stripe metadata (:219-221); the
webhook passes it to `grant_entitlement` (:665-677). Result: NO
external_clicks row can ever be joined to the purchase it produced.

### Proposed change (chain, upstream→downstream)
1. `click-logger.ts`: `logClick` returns the inserted row id. NOT a one-line
   tweak (reviewed finding): the current race is a fire-and-forget IIFE with a
   boolean `completed` flag whose raced value is discarded — restructure the
   `Promise.race` to resolve a discriminated value (`{id} | {timedOut} |
   {error}`), return `string | null`. Timeout/error → null → the chain
   degrades exactly as today.
2. `/go/title`: build the cookie AFTER logClick resolves and include
   `click_id` when present: `{creator_id, title_id, ts, click_id?}`. NO new
   latency (reviewed finding, corrected from v1): logClick is already awaited
   before `return dest`; this only reorders the cookie-set relative to an
   existing await.
3. Rent route: parse `click_id`, UUID-validate, and thread
   `metadata.moonbeem_click_id` whenever the COOKIE validates —
   INDEPENDENT of whether creator attribution resolves (reviewed finding:
   self-attribution deliberately nulls `creatorId` (:197-200) while a real
   click occurred; click-linkage and credit are orthogonal facts, and coupling
   them would reintroduce Break 1 for exactly those purchases). Attribution
   semantics for CREDIT (creator-level, deliberately NOT title-scoped, 7-day
   last-click) are UNCHANGED.
4. Webhook: read `md.moonbeem_click_id ?? null`, UUID-validate, pass as a NEW
   TRAILING DEFAULTED param `p_external_click_id` to `grant_entitlement` —
   the precedent of `p_creator_id` (migration 20260630000001).
5. RPC + schema: `entitlements.external_click_id uuid null references
   external_clicks(id) on delete set null`. **The RPC resolves the id
   defensively — decided NOW, not at implementation** (reviewed finding):
   `v_click_id := (select id from external_clicks where id =
   p_external_click_id);` and insert `v_click_id` (NULL when absent). This
   makes the INSERT structurally incapable of FK-failing on the traceability
   field. Why it matters: Stripe replays IDENTICAL metadata on every retry, so
   a non-resolving click id would otherwise be a PERMANENT poison pill — the
   webhook 500s (route.ts:678-686), Stripe retries forever, a PAID grant never
   lands. And stale ids arise in ordinary operations, not just tampering:
   `external_clicks.title_id` cascades on title hard-delete (initial
   schema :152), so a click row can vanish between click and webhook retry.
6. Settlements need NO change — the settle cron already copies `creator_id`
   and the click joins through `entitlement_id`.

### Schema changes (MIGRATION — flagged, none executed in this pass)
- `alter table entitlements add column external_click_id uuid null references
  external_clicks(id) on delete set null;` (additive, nullable, no backfill —
  the linkage datum never existed for historical rows).
- `grant_entitlement` → 8-arg form via DROP FIRST then CREATE. Reason
  (corrected from v1, which misattributed this to 42P13 — the changed-RETURNS
  error, inapplicable here since the return type is unchanged): Postgres
  function identity includes argument types, so CREATE-without-DROP leaves the
  7-arg overload alive alongside the 8-arg one and 7-arg callers then match
  BOTH → `function grant_entitlement(...) is not unique` → the live grant path
  500s. This exact incident is documented in migration 20260630000001's own
  header (the 6→7 transition).

### Deploy order (BINDING — preview shares prod DB + prod webhook target)
1. Migration (column + DROP-and-recreate 8-arg RPC with trailing default) —
   the deployed 7-arg-calling webhook keeps working (named-param `supabase.rpc`
   invocation + trailing default, verified against the 20260630000001
   precedent).
2. Webhook reader (tolerates absent key) — merged and DEPLOYED to prod.
3. Only then the writers: click-logger/go-title cookie, rent-route metadata.

### Failure modes
- Old cookies (no click_id): `parsed.click_id` undefined → key omitted;
  back-compatible.
- logClick timeout: cookie carries attribution without click_id — creator
  credit UNAFFECTED (click_id is additive traceability, never a crediting
  condition).
- Stale/tampered click_id: resolved to NULL inside the RPC (step 5); the grant
  can never fail on it.
- RPC overload ambiguity if DROP-and-recreate is botched (see Schema changes)
  — the migration must drop the 7-arg signature in the same transaction.
- Stripe metadata limits: 50 keys / 500 chars per value; this route sends 4-6
  keys — nowhere near limits.

### Rollback
Writers revert cleanly (stop sending the key); column and 8-arg RPC are
additive and inert when unwritten. No settle-path involvement to unwind.

### Test evidence for Dan to screenshot
1. Stripe dashboard: test purchase's session metadata showing
   `moonbeem_click_id` alongside `moonbeem_creator_id`.
2. Confirmation SELECT joining the chain:
   `select e.id, e.creator_id, e.external_click_id, c.clicked_at, c.platform
    from entitlements e join external_clicks c on c.id = e.external_click_id
    where e.id = '<test entitlement>';` — one row, ids matching.
3. A control purchase WITHOUT the cookie: same SELECT returns
   `external_click_id IS NULL` and the grant still succeeded.
4. A purchase with a DOCTORED cookie click_id (random UUID): grant succeeds,
   `external_click_id IS NULL` (proves the poison-pill defense).

---

## C4. Mux Data player metadata (telemetry + one consent decision)

### Current state
Both player mounts pass NO metadata — `MuxEpisodePlayer.tsx:90-98` and
`me/CreatorEpisodePreview.tsx:73-78` render `<MuxPlayer playbackId tokens
streamType>` only. Mux Data receives default anonymous beacons; views are not
attributable to viewer, title, or creator in the Mux dashboard. (The only
existing product-side hosted-playback datum is `entitlements.first_played_at`
via `stampFirstPlay` — a one-bit clock stamp; this pass adds the first RICH
per-view telemetry.)

### Proposed change
Add to both mounts:
```tsx
metadata={{
  video_id: episode.id,
  video_title: <title name — must be THREADED IN, see Files touched>,
  viewer_user_id: <session user id if present AND consent granted>,
  custom_1: <creator_id>,   // attribution curator when known
  custom_2: <title_id>,
}}
```
plus `envKey={process.env.NEXT_PUBLIC_MUX_ENV_KEY}` if beacons don't already
carry the env (verify in the Mux dashboard first; DRM playback usually infers
it — do not double-configure).

Prop threading (reviewed finding — this is NOT in scope today):
`MuxEpisodePlayer` receives only `{ episode: TitleEpisode }` and `TitleEpisode`
(src/lib/queries/titles.ts:290-304) has no title-name/creator/viewer fields;
`EpisodeModal` receives `{ episode, onClose }`; `EpisodeList` receives
`{ episodes }`. Only `HeroPlayer` has a `title` prop and doesn't forward it.
The title/creator/viewer context must be threaded 2-3 levels down both mount
paths (or added to the episode query shape).

Consent (CORRECTED from v1, which named the wrong precedent): Vercel Analytics
is deliberately UNGATED in this repo (cookie-less; rendered OUTSIDE
`<ConsentProvider>`, layout.tsx:60-68) — do NOT copy it. The correct pattern
is `useConsent().state.analytics` as used by
`src/components/analytics/GoogleAnalytics.tsx:83-88` /`MicrosoftClarity.tsx`
inside `<ConsentProvider>`. Gate `viewer_user_id` (pseudonymous internal UUID,
still a processor-bound identifier) on that flag; send video/creator/title
fields unconditionally (content metadata, not personal data).

### Files touched
- `src/components/MuxEpisodePlayer.tsx` (metadata prop + widened props type)
- `src/components/me/CreatorEpisodePreview.tsx` (same)
- `src/components/HeroPlayer.tsx`, `src/components/EpisodeModal.tsx`,
  `src/components/EpisodeList.tsx` (prop threading)
- `.env.example` + Vercel env (`NEXT_PUBLIC_MUX_ENV_KEY`) if needed

### Schema changes
None. (Any DB-side ingestion of Mux Data — the affiliate watch-time Break 2
story — is a separate pass.)

### Failure modes
- Wrong/missing env key → beacons drop silently: verify in the dashboard, not
  by absence of errors.
- Consent mis-wiring ships viewer ids ungated — the review demoted C4 from
  "zero risk" for exactly this; the consent screenshot below is the gate.
- PII posture: emails/names never; UUID only, consent-gated.

### Rollback
Remove the props; zero persistence.

### Test evidence for Dan to screenshot
1. Mux Data dashboard view row showing video_title, viewer_user_id, and both
   custom fields on a self-played view.
2. Same view played with consent declined (EU VPN or forced flag):
   viewer_user_id absent, content fields present.

---

## C1b. License-duration termination — PROBE DESIGN (not built)

**The problem C1 could not solve.** The playback token gates only the manifest;
segments are unauthenticated. So a lapsed rental plays to the end of the film and
no TTL can stop it (see the struck paragraph under C1). The only lever that can
terminate a session is **license duration** — the `licenseExpiration` /
`playDuration` claims on the DRM token (`aud: "d"`), i.e. our two-clock rule
expressed in the license instead of in Postgres.

Mux documents these claims under **offline playback**. Whether they are honored on
a **non-persistent streaming license is UNKNOWN** and must not be assumed.

### LEG A — headless falsification. **RUN 2026-07-14. SURVIVES.**

`scripts/_one_shot_license_claims_probe.mjs` (gitignored). POST a deliberately
malformed challenge to `license.mux.com/license/widevine/<id>` with each token
variant. A token rejected on AUTH returns 403; one that passes auth and fails on
the challenge returns 400. Results:

| # | drm-token claims | HTTP | body |
|---|---|---|---|
| 1 | control, none | **400** | `Invalid Parameters` |
| 2 | `playDuration: 60` | **400** | `Invalid Parameters` |
| 3 | `licenseExpiration: +60s` | **400** | `Invalid Parameters` |
| 4 | `playDuration: 60, offline: true` | **400** | **`licenseExpiration is required for offline playback`** |
| 5 | `offline + licenseExpiration + playDuration` | **400** | `Invalid Parameters` |
| 6 | `offline: false, playDuration: 60` | **400** | `Invalid Parameters` |

**Nothing is rejected — the line survives.** And variant 4 is the real find: the
endpoint **read `offline: true` and demanded `licenseExpiration`**. That is
claim-aware validation — these fields are **parsed**, not discarded.

⚠️ **Scope note (the week's lesson, again):** "Mux ignores unknown claims" was
proven on the **video edge** (`aud: "v"`). It does **NOT** hold on the **license
endpoint** (`aud: "d"`), which demonstrably inspects them. Do not generalize the
one to the other.

**What Leg A does NOT prove:** that the claims are HONORED. A 400 means the token
passed auth — nothing more. Acceptance and silent-discard are indistinguishable at
this layer. Only Leg B can confirm.

### LEG B — real CDM. **The only confirming test. NOT YET BUILT.**

A license handshake needs a real CDM, so this runs in a browser. Standalone, **no
app-code changes**: `scripts/_one_shot_license_duration_probe/` serves a bare page
on `localhost:8787` (EME requires a secure context; localhost qualifies) mounting
`mux-player` with a normal playback token and a DRM token carrying
**`playDuration: 60`**, logging `currentTime` / `paused` / `readyState` and every
`error` / `waiting` / `encrypted` event each second.

Then **watch, in both engines** — FairPlay's rental semantics differ from
Widevine's, so a Chrome pass is **not** evidence about Safari:

- **Chrome / Widevine** — does playback stop at ~60s?
- **Safari / FairPlay** — same, independently.
- Repeat with `licenseExpiration` (absolute) instead of `playDuration` (relative):
  different clocks, possibly honored independently.

**The three outcomes:**
1. **Stops with an error** → the lever works AND surfaces where `MuxEpisodePlayer`'s
   `onError` already catches it. C1b is buildable.
2. **Stops silently** (freeze/stall, no error event) → the lever works but the UX is
   a hang; we'd need a client watchdog, not just `onError`.
3. **Doesn't stop** → the claims are ignored on streaming licenses; session
   termination is **not available via Mux DRM**, and we say so plainly rather than
   inventing a third theory.

### LEG C — the design consequence, only if B passes

**The license clock restarts on every new session.** A fixed `playDuration: 48h`
would let a viewer re-acquire a fresh 48h license forever — precisely the bug the
entitlement window exists to prevent. So the server must mint the license from the
entitlement's **REMAINING** window at mint time:

```
started rental   : remaining = (first_played_at + 48h) − now
unstarted rental : remaining = 48h   (this mint is what stamps first_played_at)
purchase         : no cap (fall back to TOKEN_TTL)
```
clamped `> 0` (a non-positive remaining must never mint — that is a 402), and
capped by `TOKEN_TTL` so a license can never outlive its own token.

**🔴 HARD PREREQUISITE — `first_played_at` IS CURRENTLY WRONG.** Leg C computes
durations from `first_played_at`, and that clock is started by *opening a modal*,
not by playing: `EpisodeList.tsx:27` (row click) → `EpisodeModal.tsx:41,81-83`
(mounts the player immediately, no play gate) → `MuxEpisodePlayer.tsx:45-51`
(POSTs on mount) → `playback-token/route.ts:150` (`stampFirstPlay` runs
unconditionally on every gated POST). The player does **not** autoplay, so a viewer
can open an episode, see a PAUSED player, close it, and have burned the start of
their 48-hour window without playing a frame. `HeroPlayer` is correct (mounts on
the play click); the series-modal path is not. **This is a live bug, independent of
C1, and it must be fixed BEFORE C1b — otherwise C1b hands out license durations
computed from a clock a peek started.**

**User-visible consequence of C1b, to be release-noted only AFTER Leg B proves it
happens:** a viewer with 10 minutes left on a rental gets a 10-minute license and
is cut off mid-film. That is correct — it is what a 48-hour window means — but it
is a real behavior change, and this time the CHANGELOG entry waits for evidence.

---

## Sequencing across the four items

C4 (telemetry; low risk once the consent gate is wired correctly) → C1
(playback binding) → C2 (checkout gate) → C3 (schema + contract,
webhook-reader-first). C2 and C3 are independent; C3's migration window must
not overlap the Adobe submission-day dry-runs (panel surface stays quiet).
