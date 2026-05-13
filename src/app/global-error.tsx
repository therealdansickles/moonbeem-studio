// Last-resort error boundary — only fires when the root layout
// itself errors. Must render its own <html> and <body> because it
// replaces the root layout entirely.

"use client";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <html lang="en">
      <body style={{
        backgroundColor: "#121212",
        color: "#F5C5E1",
        fontFamily: "system-ui, sans-serif",
        margin: 0,
        padding: 0,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        <div style={{ textAlign: "center", padding: "2rem", maxWidth: "32rem" }}>
          <h1 style={{ fontSize: "2rem", margin: "0 0 1rem 0", fontWeight: 700 }}>
            Something went wrong.
          </h1>
          <p style={{ color: "rgba(255,255,255,0.6)", margin: "0 0 1.5rem 0", lineHeight: 1.5 }}>
            Refresh to try again. If this keeps happening, the team is on it.
          </p>
          <a
            href="/"
            style={{
              display: "inline-block",
              backgroundColor: "#F5C5E1",
              color: "#011754",
              padding: "0.625rem 1.25rem",
              borderRadius: "0.375rem",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            Go home
          </a>
          {error.digest && (
            <p style={{
              marginTop: "1.5rem",
              fontFamily: "monospace",
              fontSize: "0.75rem",
              color: "rgba(255,255,255,0.3)",
              wordBreak: "break-all",
            }}>
              ref: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
