"use client";

import { useState } from "react";
import { RowsPhotoAlbum, type Photo } from "react-photo-album";
import "react-photo-album/rows.css";
import Lightbox from "yet-another-react-lightbox";
import Download from "yet-another-react-lightbox/plugins/download";
import "yet-another-react-lightbox/styles.css";
import type { Still } from "@/lib/queries/titles";

type Props = {
  stills: Still[];
};

const FALLBACK_W = 1600;
const FALLBACK_H = 1067;

export default function StillsTab({ stills }: Props) {
  const [index, setIndex] = useState(-1);

  if (!stills || stills.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-body text-moonbeem-ink-muted">
          Coming soon. The stills library is uploading. 15 stills coming.
        </p>
      </div>
    );
  }

  const photos: Photo[] = stills
    .filter((s) => !!s.file_url)
    .map((s) => ({
      src: s.file_url!,
      alt: s.alt_text ?? "",
      width: s.width ?? FALLBACK_W,
      height: s.height ?? FALLBACK_H,
    }));

  const slides = photos.map((p) => ({
    src: p.src,
    alt: p.alt,
    width: p.width,
    height: p.height,
    download: p.src,
  }));

  return (
    <>
      <RowsPhotoAlbum
        photos={photos}
        targetRowHeight={220}
        spacing={8}
        onClick={({ index }) => setIndex(index)}
      />
      <Lightbox
        open={index >= 0}
        index={index}
        close={() => setIndex(-1)}
        slides={slides}
        plugins={[Download]}
      />
    </>
  );
}
