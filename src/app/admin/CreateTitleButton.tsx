"use client";

import { useState } from "react";
import CreateTitleModal from "./CreateTitleModal";

export default function CreateTitleButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-moonbeem-pink/40 px-4 py-2 text-body-sm font-semibold text-moonbeem-pink hover:border-moonbeem-pink hover:bg-moonbeem-pink/10"
      >
        + Create title
      </button>
      {open && <CreateTitleModal onClose={() => setOpen(false)} />}
    </>
  );
}
