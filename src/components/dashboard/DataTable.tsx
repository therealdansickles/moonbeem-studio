// Editorial table primitive for dashboard top-N panels. Matches the
// /admin/clicks aesthetic: rounded card frame, soft divider lines,
// tabular-nums for counts, hover lift on rows.
//
// Generic column definition lets each call site pass render() for
// custom cell formatting (linked title names, country flags, etc.)
// without forking the component.

import { type ReactNode } from "react";

export type Column<T> = {
  /** Column key used as React key on header + cell. */
  key: string;
  /** Header label. */
  label: string;
  /** Cell renderer. */
  render: (row: T) => ReactNode;
  /** Cell alignment. Default left. */
  align?: "left" | "right";
  /** Optional className for column width hint. */
  widthClass?: string;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
};

export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = "No data in this window.",
}: Props<T>) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <p className="text-body-sm text-moonbeem-ink-muted m-0">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/5">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-4 py-3 text-caption uppercase tracking-wide text-moonbeem-ink-subtle font-medium ${
                  col.align === "right" ? "text-right" : "text-left"
                } ${col.widthClass ?? ""}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="hover:bg-white/[0.02] transition-colors"
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-4 py-3 text-body-sm text-moonbeem-ink ${
                    col.align === "right" ? "text-right tabular-nums" : ""
                  }`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
