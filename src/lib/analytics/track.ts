// Typed wrappers around window.gtag for the seven custom events
// instrumented in the app. Call sites import the per-event helper
// instead of touching window.gtag directly so:
//   - the params shape stays consistent (renames hit one file, not
//     dozens)
//   - undefined-gtag is a no-op rather than a crash (handles dev,
//     /admin/* routes where the GA script isn't loaded, and
//     gtag-blocked-by-extension cases)
//   - the helper module collects every event name in one place for
//     review against the GA explorer schema
//
// Event names use snake_case per GA4 convention.

function fire(eventName: string, params: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  if (typeof window.gtag !== "function") return;
  window.gtag("event", eventName, params);
}

export function trackFanEditClick(params: {
  title_id: string;
  fan_edit_id: string;
  platform: string;
  creator_handle: string | null;
}): void {
  fire("fan_edit_click", params);
}

// Side B (transactional storefront) hasn't shipped — no button to
// instrument yet. Helper is exported so the call site is one import
// + one line when the button lands.
export function trackTransactButtonClick(params: {
  title_id: string;
  source: "title_page" | "creator_page";
}): void {
  fire("transact_button_click", params);
}

export function trackExternalClick(params: {
  title_id: string;
  offer_type: string | null;
  destination_url: string;
}): void {
  fire("external_click", params);
}

export function trackSigninStart(params: {
  method: "google" | "email_otp";
}): void {
  fire("signin_start", params);
}

// signin_complete is fired by GoogleAnalytics on detection of
// ?signin=1 in the URL (appended by /auth/callback). Not exported
// here since no React call site needs to fire it — kept implicit in
// the GA component to avoid being called from elsewhere by mistake.

export function trackCreatorSearch(params: {
  query: string;
  source: "topnav" | "browse" | "me";
}): void {
  fire("creator_search", params);
}

export function trackBrowseFilter(params: {
  filter_key: string;
  filter_value: string;
}): void {
  fire("browse_filter", params);
}
