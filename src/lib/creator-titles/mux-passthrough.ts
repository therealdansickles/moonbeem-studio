// The creator hosting lane's NAMESPACED Mux passthrough — the single seam the
// webhook uses to split lanes. Partner-rail passthroughs are bare job uuids
// (mux_ingest_jobs.id); creator-rail passthroughs are
// `creator:<creator_mux_ingest_jobs.id>`. ONE home for the format so the
// upload route (writer) and the webhook (reader) can never drift.

const CREATOR_PASSTHROUGH_PREFIX = "creator:";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildCreatorPassthrough(jobId: string): string {
  return `${CREATOR_PASSTHROUGH_PREFIX}${jobId}`;
}

// `creator:<uuid>` → the creator job id; anything else (a bare partner uuid,
// a foreign string, null) → null. Lane selection must be total and not
// spoofable by shape: only OUR namespace followed by a well-formed uuid
// parses, so a foreign passthrough can never route an event into the creator
// lane's uuid-typed id query.
export function parseCreatorPassthrough(
  passthrough: string | null,
): string | null {
  if (!passthrough || !passthrough.startsWith(CREATOR_PASSTHROUGH_PREFIX)) {
    return null;
  }
  const jobId = passthrough.slice(CREATOR_PASSTHROUGH_PREFIX.length);
  return UUID_RE.test(jobId) ? jobId : null;
}
