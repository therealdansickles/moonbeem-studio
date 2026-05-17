// Source of truth for fan_edits.verification_status values.
// Mirrors the CHECK constraint in
// supabase/migrations/20260516000001_fan_edits_user_submission_states.sql
export const FAN_EDIT_VERIFICATION_STATUSES = [
  "auto_verified",
  "needs_review",
  "pending",
  "approved",
  "rejected",
] as const;

export type FanEditVerificationStatus =
  (typeof FAN_EDIT_VERIFICATION_STATUSES)[number];

// Publicly readable subset — the statuses a public/partner-facing
// read should include. Mirrors the RLS SELECT policy in
// 20260516000001_fan_edits_user_submission_states.sql.
// Use as: .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
export const PUBLICLY_READABLE_FAN_EDIT_STATUSES = [
  "auto_verified",
  "approved",
] as const satisfies readonly FanEditVerificationStatus[];
