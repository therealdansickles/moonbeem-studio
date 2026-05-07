// Client-side helper for posting fan-edit modal events to the
// analytics endpoint. Fire-and-forget — analytics never blocks the
// user-facing flow. keepalive=true so close events fire even when
// the page is unloading (modal close coinciding with navigation).

export type ModalEventType =
  | "modal_open"
  | "modal_close"
  | "view_on_platform_click";

type Args = {
  fan_edit_id: string;
  event_type: ModalEventType;
  session_id: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
};

export function trackModalEvent(args: Args): void {
  if (typeof fetch !== "function") return;
  try {
    fetch("/api/analytics/modal-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      keepalive: true,
    }).catch(() => {
      // Swallow — analytics failures are not user-facing concerns.
    });
  } catch {
    // Older browsers without keepalive support, etc.
  }
}
