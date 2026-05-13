-- Drop the temporary _inspect_indexes RPC deployed in 20260513000002.
--
-- The function was created to verify real index coverage on production
-- after the security audit's grep-only approach surfaced ~7-8 false
-- positives. We have the answer now (index coverage is comprehensive)
-- and don't need ongoing introspection access.
--
-- Notably, _inspect_indexes was `security definer` without an explicit
-- role-gating block (anyone authenticated could call it), which is
-- exactly the kind of finding a future audit would flag. Drop is
-- cheaper than retrofitting role checks for a one-shot tool.
--
-- Lesson captured in memory/feedback_audit_static_vs_introspection.md.

drop function if exists public._inspect_indexes(text[]);
