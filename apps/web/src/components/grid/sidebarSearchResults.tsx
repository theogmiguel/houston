import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
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
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- brings the highlighted result into view in the rail's scroll container
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return { highlighted, ref };
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
      <div className="px-2 py-1 text-xs font-medium text-secondary-label">In messages</div>
      {results.map((result) => (
        <ContentResultRow key={result.key} result={result} />
      ))}
    </div>
  );
}

function ContentResultRow({ result }: { result: ContentResult }) {
  const { highlighted, ref } = useSearchHighlight(result.key);
  return (
    <button
      ref={(element) => {
        ref.current = element;
      }}
      type="button"
      data-search-highlighted={highlighted || undefined}
      onClick={result.onOpen}
      className={cn(
        `flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left outline-none ${MOTION_FEEDBACK}`,
        highlighted ? "bg-(--sidebar-row-active)" : "hover:bg-(--sidebar-row-hover)",
      )}
    >
      <span className="truncate text-sm text-sidebar-foreground">{result.thread.title}</span>
      <span className="line-clamp-2 text-xs break-words text-secondary-label">
        {result.snippet}
      </span>
    </button>
  );
}

export function SidebarNoSearchResults({ query }: { query: string }) {
  return (
    <div role="status" className="px-2.5 py-3 text-sm text-secondary-label">
      No threads found for “{query}”
    </div>
  );
}
