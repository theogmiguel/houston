import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import {
  RAIL_NOTICE_CLS,
  RAIL_RESULT_ROW_CLS,
  RAIL_RESULT_SNIPPET_CLS,
  RAIL_RESULT_TITLE_CLS,
  RAIL_SECTION_LABEL_CLS,
} from "../ui/sidebar-rail-recipes";
import { createContext, useContext, useEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { MOTION_FEEDBACK } from "../ui/motion-recipes";

/** The scoped key of the search result Enter would open, or null when no search is running. */
export const SidebarSearchHighlightContext = createContext<string | null>(null);

/**
 * Whether the row for `key` is the highlighted search result; the row scrolls into view when it
 * becomes the highlighted one.
 */
export function useSearchHighlight(key: string) {
  const highlighted = useContext(SidebarSearchHighlightContext) === key;
  const ref = useRef<HTMLElement | null>(null);
  const attach = (element: HTMLElement | null) => {
    ref.current = element;
  };
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- brings the highlighted result into view in the rail's scroll container
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return { highlighted, attach };
}

export interface ContentResult {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly snippet: string;
  readonly onOpen: () => void;
}

/** Threads found by what their messages say, under the rail's title matches. */
export function SidebarContentResults({ results }: { results: ReadonlyArray<ContentResult> }) {
  if (results.length === 0) return null;
  return (
    <div className="flex flex-col gap-px pt-1" data-testid="sidebar-content-results">
      <div className={`px-2 py-1 ${RAIL_SECTION_LABEL_CLS}`}>In messages</div>
      {results.map((result) => (
        <ContentResultRow key={result.key} result={result} />
      ))}
    </div>
  );
}

function ContentResultRow({ result }: { result: ContentResult }) {
  const { highlighted, attach } = useSearchHighlight(result.key);
  return (
    <button
      ref={attach}
      type="button"
      data-search-highlighted={highlighted || undefined}
      onClick={result.onOpen}
      className={cn(
        `flex w-full flex-col gap-0.5 px-2.5 py-1.5 ${RAIL_RESULT_ROW_CLS} ${MOTION_FEEDBACK}`,
        highlighted ? "bg-(--sidebar-row-active)" : "hover:bg-(--sidebar-row-hover)",
      )}
    >
      <span className={`truncate ${RAIL_RESULT_TITLE_CLS}`}>{result.thread.title}</span>
      <span className={RAIL_RESULT_SNIPPET_CLS}>{result.snippet}</span>
    </button>
  );
}

export function SidebarNoSearchResults({ query }: { query: string }) {
  return (
    <div role="status" className={`px-2.5 py-3 ${RAIL_NOTICE_CLS}`}>
      No threads found for “{query}”
    </div>
  );
}
