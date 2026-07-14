# Changelog

User-visible product changes. Behavior changes that a viewer, creator, or partner
could NOTICE go here — not refactors, not internal cleanups.

New at the top. Date = the day the change was built; a change is only real once it
is live on www.moonbeem.studio.

---

## 2026-07-14 — Opening an episode no longer starts your rental clock

**Who notices:** anyone who rents a series and browses its episodes.

**What changed.** Clicking an episode used to open a player immediately — and that
act alone **started the 48-hour rental countdown**, before a single frame played.
You could open an episode, look at it, close it, and come back the next day to a
rental that had been quietly burning the whole time.

Now an episode opens to a still image with a play button. **Nothing starts until
you press play** — and when you do, the film starts playing straight away instead
of handing you a paused player to click a second time.

**The rule, plainly:** the clock starts when playback starts. Not when you look.

Feature films were already close to this (they open behind a play button), but they
too showed a paused player after the click; that's fixed as well — one click, it
plays.

**No existing rental was affected.** Every rental clock ever started in production
went through the feature-film path, which required a real play click. Nothing to
repair, and nothing was.

## No entries before this.

This file was created on 2026-07-13 for a C1 entry that was **retracted before it
ever shipped**, and the retraction is worth more than the entry would have been.

The draft entry announced: *"a rental that lapses mid-session now stops at the next
token refresh."* An edge probe the next day proved that **false** — Mux serves
video segments on an expired token (segment URLs carry no token at all), so an
in-flight session always runs to the end of the film and no TTL change can stop it.
The claim was deleted rather than shipped. See the struck paragraph in
`docs/rights-attribution-pass-plan.md`.

C1 as it actually shipped (shorter token TTL, a network-error retry in the player,
an internal territory refactor) has **no user-visible behavior change** — which is
exactly why it gets no entry. The first real entry goes above this line.
