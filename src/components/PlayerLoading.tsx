// Loading placeholder for the Mux player — shown while a per-viewer playback/DRM
// token is being minted (and while the player chunk lazy-loads). Centered on the
// modal's dark media surface.
//
// PLACEHOLDER — swap for the animated Moonbeem brand logo later. Keep this
// component's props (none) and position (centered, fills the media area) stable
// so the swap touches ONLY this file.
export default function PlayerLoading() {
  return (
    <div
      className="flex min-h-[320px] w-full items-center justify-center"
      role="status"
      aria-label="Loading video"
    >
      <span className="h-3 w-3 animate-ping rounded-full bg-moonbeem-pink" />
    </div>
  );
}
