"use client";

import Link from "next/link";
import { useState } from "react";
import EditPartnerModal from "./EditPartnerModal";

type Props = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  title_count: number;
  member_count: number;
};

export default function PartnerRow(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <li className="flex items-center gap-4 py-3">
        <Link
          href={`/p/${props.slug}`}
          className="min-w-0 flex-1 text-body font-medium text-moonbeem-ink hover:text-moonbeem-pink"
        >
          {props.name}
        </Link>
        <span className="text-caption text-moonbeem-ink-subtle">
          /p/{props.slug}
        </span>
        <span className="text-body-sm tabular-nums text-moonbeem-ink-muted">
          {props.title_count} {props.title_count === 1 ? "title" : "titles"}
        </span>
        <span className="text-body-sm tabular-nums text-moonbeem-ink-muted">
          {props.member_count} {props.member_count === 1 ? "member" : "members"}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-white/10 px-3 py-1 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
        >
          Edit
        </button>
      </li>
      {open && (
        <EditPartnerModal
          partner={{
            id: props.id,
            slug: props.slug,
            name: props.name,
            logo_url: props.logo_url,
            title_count: props.title_count,
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
