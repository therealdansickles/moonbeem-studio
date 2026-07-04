"use client";

// Shared "download all" runner for the clips + stills tabs. The zip-vs-sequential
// decision is SIZE-BASED and identical for both media types (one threshold in
// bundle.ts), so it lives here once — the tabs differ only in `type`, the
// resulting zip name (`<slug>-<type>.zip`), and where a 403 routes its gate.
//
// Flow: POST the authorize route (gate + per-item logging happen server-side) →
// it returns the public R2 URLs + sizes → decide from the total: under the cap,
// fetch each object (CORS-permitted on prod) and fflate-zip into one archive;
// over the cap, fire staggered direct-from-R2 downloads (the objects'
// Content-Disposition forces an attachment save; the browser prompts once).

import { useState } from "react";
import { zipSync } from "fflate";
import { dedupeName, shouldZipInMemory } from "./bundle";
import { triggerAnchorDownload, triggerBlobDownload } from "./trigger";

type BundleType = "clips" | "stills";
type GateReason = "auth_required" | "verification_required" | "limit_reached";
type BundleItem = { url: string; filename: string; size: number | null };

export function useBundleDownload(opts: {
  titleId: string;
  titleSlug: string;
  type: BundleType;
  onGate: (reason: GateReason) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(false);
    setLabel("Preparing…");
    try {
      const res = await fetch(`/api/titles/${opts.titleId}/download-all`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: opts.type }),
      });
      if (res.status === 403) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: GateReason;
        };
        opts.onGate(json.error ?? "auth_required");
        return;
      }
      if (!res.ok) {
        setError(true);
        return;
      }
      const { items } = (await res.json()) as { items: BundleItem[] };
      if (!items || items.length === 0) {
        setError(true);
        return;
      }

      const totalBytes = items.reduce((sum, it) => sum + (it.size ?? 0), 0);
      if (shouldZipInMemory(totalBytes)) {
        // Zip path — fetch each object (needs R2 GET CORS, prod-only today),
        // dedupe entry names, store (level 0 — mp4/jpeg/png are already
        // compressed, so deflate burns CPU for ~0 gain).
        const files: Record<string, Uint8Array> = {};
        const used = new Set<string>();
        for (let i = 0; i < items.length; i++) {
          setLabel(`Fetching ${i + 1} of ${items.length}…`);
          const r = await fetch(items[i].url);
          if (!r.ok) throw new Error("fetch_failed");
          files[dedupeName(items[i].filename, used)] = new Uint8Array(
            await r.arrayBuffer(),
          );
        }
        // Let React paint the "Zipping…" label before the synchronous zip
        // blocks the main thread (a near-cap set is a multi-second freeze).
        setLabel("Zipping…");
        await new Promise((r) => setTimeout(r, 0));
        const zipped = zipSync(files, { level: 0 });
        // Release the fetched input buffers before the Blob copies `zipped`, so
        // the set's bytes are GC-eligible instead of stacking with the archive
        // + the Blob copy (transient peak up to ~3× the set otherwise).
        for (const k of Object.keys(files)) delete files[k];
        triggerBlobDownload(
          new Blob([zipped], { type: "application/zip" }),
          `${opts.titleSlug}-${opts.type}.zip`,
        );
        return;
      }

      // Sequential path — large set. Direct-from-R2 (bytes never touch our
      // server); staggered so the browser's multi-download prompt shows once.
      for (let i = 0; i < items.length; i++) {
        setLabel(`Downloading ${i + 1} of ${items.length}…`);
        triggerAnchorDownload(items[i].url, items[i].filename);
        if (i < items.length - 1) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setLabel("");
    }
  }

  return { busy, label, error, run };
}
