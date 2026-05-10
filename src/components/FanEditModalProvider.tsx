"use client";

// Shared fan-edit modal context, used by any public surface that
// renders fan-edit thumbnails: /t/[slug] FanEditsTab, the homepage
// Recent Remixes carousel, and the /p/[slug] partner dashboard
// (AllEditsTable + TopPerformersCard). Replaces the per-surface
// modal-open state that previously lived in FanEditsTab only.
//
// Consumers call `open(list, index, titleSlug, titleName)` from a
// click handler. The provider renders FanEditModal at the layout
// level so arrow-nav, ESC handling, and embed sizing behave the
// same regardless of which surface opened it.
//
// GA event firing (trackFanEditClick) intentionally stays at the
// call site — the provider has no opinion on whether to track,
// since /p/[slug] is admin and needs to skip while /t/[slug] +
// homepage need to fire. Each surface fires its own GA before
// calling open().

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import FanEditModal from "./FanEditModal";

// Minimal shape the modal needs from a fan_edit row. Both FanEdit
// (titles.ts) and FanEditWithTitle (homepage carousel) plus
// AllEditRow / TopPerformer (after the /p/[slug] loader additions)
// satisfy this structurally — no adapter needed at call sites.
export type FanEditForModal = {
  id: string;
  platform: "tiktok" | "instagram" | "youtube" | "twitter";
  embed_url: string;
  creator_handle_displayed: string | null;
  creator_moonbeem_handle: string | null;
};

type OpenArgs = {
  fanEdits: FanEditForModal[];
  index: number;
  // Used by the modal byline link (`<Link href="/t/${titleSlug}">`)
  // and the page-title tag in the modal header. Required because the
  // modal byline always wants a title-page jump-link.
  titleSlug: string;
  titleName: string;
  // When false, the modal suppresses ALL fan_edit_events writes
  // (modal_open, modal_close, view_on_platform_click). Set on admin
  // surfaces (/p/[slug] partner dashboard) so internal browsing
  // doesn't pollute the partner-visible "Moonbeem plays" count or
  // the outbound-CTA metric. Defaults to true on public surfaces.
  track?: boolean;
};

type ContextValue = {
  open: (args: OpenArgs) => void;
  close: () => void;
};

const FanEditModalContext = createContext<ContextValue | null>(null);

export function useFanEditModal(): ContextValue {
  const ctx = useContext(FanEditModalContext);
  if (!ctx) {
    throw new Error(
      "useFanEditModal must be called inside <FanEditModalProvider>",
    );
  }
  return ctx;
}

type State = {
  fanEdits: FanEditForModal[];
  openIndex: number;
  titleSlug: string;
  titleName: string;
  track: boolean;
};

const CLOSED: State = {
  fanEdits: [],
  openIndex: -1,
  titleSlug: "",
  titleName: "",
  track: true,
};

export default function FanEditModalProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [state, setState] = useState<State>(CLOSED);

  const open = useCallback((args: OpenArgs) => {
    if (
      args.index < 0 ||
      args.index >= args.fanEdits.length ||
      args.fanEdits.length === 0
    ) {
      return;
    }
    setState({
      fanEdits: args.fanEdits,
      openIndex: args.index,
      titleSlug: args.titleSlug,
      titleName: args.titleName,
      track: args.track !== false,
    });
  }, []);

  const close = useCallback(() => {
    setState(CLOSED);
  }, []);

  const onNavigate = useCallback((newIndex: number) => {
    setState((s) => {
      if (newIndex < 0 || newIndex >= s.fanEdits.length) return s;
      return { ...s, openIndex: newIndex };
    });
  }, []);

  const value = useMemo<ContextValue>(() => ({ open, close }), [open, close]);

  return (
    <FanEditModalContext.Provider value={value}>
      {children}
      <FanEditModal
        fanEdits={state.fanEdits}
        openIndex={state.openIndex}
        titleSlug={state.titleSlug}
        titleName={state.titleName}
        track={state.track}
        onClose={close}
        onNavigate={onNavigate}
      />
    </FanEditModalContext.Provider>
  );
}
