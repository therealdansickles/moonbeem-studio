"use client";

import Link from "next/link";
import { useState } from "react";
import EditPartnerModal from "./EditPartnerModal";
import ManageMembersModal from "./ManageMembersModal";

type Props = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  title_count: number;
  member_count: number;
};

export default function PartnerRow(props: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
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
        <button
          type="button"
          onClick={() => setMembersOpen(true)}
          className="rounded-md border border-white/10 px-3 py-1 text-caption tabular-nums text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
        >
          {props.member_count}{" "}
          {props.member_count === 1 ? "member" : "members"}
        </button>
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="rounded-md border border-white/10 px-3 py-1 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-pink"
        >
          Edit
        </button>
      </li>
      {editOpen && (
        <EditPartnerModal
          partner={{
            id: props.id,
            slug: props.slug,
            name: props.name,
            logo_url: props.logo_url,
            title_count: props.title_count,
          }}
          onClose={() => setEditOpen(false)}
        />
      )}
      {membersOpen && (
        <ManageMembersModal
          partnerId={props.id}
          partnerName={props.name}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </>
  );
}
