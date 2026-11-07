import { cn } from "../../lib/utils";
import type { ThreadStatusPill } from "../Sidebar.logic";
import {
  ThreadStatusKindGlyph,
  threadStatusKindGlyphClass,
  type ThreadState,
  type ThreadStatusKind,
} from "../ui/thread-state-glyph";

const GLYPH_LABEL: Record<ThreadState, string> = {
  running: "Running",
  needs: "Needs you",
  ready: "Ready",
  failed: "Failed",
  back: "Back",
};

/** The rail's status mark, laid out beside the time so titles line up. */
export function SidebarStatusGlyph({
  state,
  kind = state,
  label,
}: {
  state: ThreadState;
  /** The exact kind when the caller knows it; a pill's coarse state is the family default. */
  kind?: ThreadStatusKind;
  label?: string | null | undefined;
}) {
  return (
    <span
      role="img"
      aria-label={label ?? GLYPH_LABEL[state]}
      className={cn(
        "inline-grid size-3.5 shrink-0 place-items-center",
        threadStatusKindGlyphClass(kind),
      )}
    >
      <ThreadStatusKindGlyph kind={kind} />
    </span>
  );
}

export function SidebarThreadStatusGlyph({
  status,
  kind,
  label,
}: {
  status: ThreadStatusPill | null;
  kind?: ThreadStatusKind | undefined;
  label?: string | null | undefined;
}) {
  if (status === null) return null;
  return <SidebarStatusGlyph state={status.state} {...(kind ? { kind } : {})} label={label} />;
}
