-- Widen the api_tokens content-scope allowlist to include `clip:list` — the
-- panel clip-browser's list scope (PANEL_ENDPOINT_SPEC §3), separate from
-- `clip:download` so least-privilege is preserved.
--
-- CHECK-constraint change, NOT a function return-type change → a plain drop/
-- re-add is safe (no 42P13 concern). Every existing row already satisfies the
-- widened allowlist: prod holds 5 token rows whose scopes ⊆ {clip:download,
-- fan_edit:submit} (live-confirmed 2026-07-07), so the ADD validates with zero
-- violations. Still content-only — the money-exclusion posture is UNCHANGED (a
-- token remains structurally incapable of authorizing a money/payout action).
alter table public.api_tokens
  drop constraint api_tokens_scopes_content_only;

alter table public.api_tokens
  add constraint api_tokens_scopes_content_only check (
    cardinality(scopes) > 0
    and scopes <@ array['clip:download', 'clip:list', 'fan_edit:submit']::text[]
  );
