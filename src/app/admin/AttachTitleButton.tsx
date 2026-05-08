"use client";

import { useState } from "react";
import AttachTitleModal from "./AttachTitleModal";

export default function AttachTitleButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90"
      >
        + Activate new title
      </button>
      {open && <AttachTitleModal onClose={() => setOpen(false)} />}
    </>
  );
}
