# Changelog

User-visible product changes. Behavior changes that a viewer, creator, or partner
could NOTICE go here — not refactors, not internal cleanups.

New at the top. Date = the day the change was built; a change is only real once it
is live on www.moonbeem.studio.

---

## No entries yet.

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
