# Changelog

User-visible product changes. Behavior changes that a viewer, creator, or partner
could NOTICE go here — not refactors, not internal cleanups.

New at the top. Date = the day the change was built; a change is only real once it
is live on www.moonbeem.studio.

> **Created 2026-07-13.** This file did not exist before C1 — product changes had
> no recorded home, which is why this entry is the first one rather than a
> backfill. Earlier changes live in git history and the `docs/` plan files.

---

## 2026-07-13 — Playback tokens are shorter-lived, and a lapsed rental now stops

**Who notices:** anyone watching a hosted film.

**What changed.** A playback token now lasts **4 hours** instead of 12, and the
player **re-mints it once** if playback fails mid-watch (it resumes at the same
timestamp, so a refresh should be barely visible).

**The behavior change worth calling out — a rental that lapses mid-session now
stops at the next token refresh instead of playing out to a 12-hour token.**

Before: rights (entitlement, territory, rental window) were checked only when the
token was minted. A 12-hour token was, in effect, a 12-hour pass — a 48-hour
rental that expired at minute 30 of your film kept playing to the end, and beyond.

After: the refresh re-runs the **full** server-side gate stack. If your rental
window closed while you were watching, the refresh returns 402 and the player
shows "Rent or buy this film to watch."

**This is correct** — it is what a rental window means — **and it is a change.**
The old behavior was more generous than the product promised. Nobody is affected
retroactively: at build time prod carried **zero active entitlements** (4 total, 2
revoked, 2 expired), which is precisely why this landed now rather than after the
first real rental.

**Not affected:** the buffered tail. Already-decrypted segments can play out for a
few seconds past expiry — the token gates *new* fetches, not the CDM's existing
key. TTL is a window, not a frame-exact kill switch.

Built in `feat(playback)` — C1 of the rights-and-attribution pass
(`docs/rights-attribution-pass-plan.md`).
