import { cn } from "../../lib/utils";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { ThreadStateGlyph, threadStateTextClass, type ThreadState } from "../ui/thread-state-glyph";

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
  label,
}: {
  state: ThreadState;
  label?: string | null | undefined;
}) {
  return (
    <span
      role="img"
      aria-label={label ?? GLYPH_LABEL[state]}
      className={cn(
        "inline-grid size-3.5 shrink-0 place-items-center",
        threadStateTextClass(state),
      )}
    >
      <ThreadStateGlyph state={state} />
    </span>
  );
}

export function SidebarThreadStatusGlyph({
  status,
  label,
}: {
  status: ThreadStatusPill | null;
  label?: string | null | undefined;
}) {
  if (status === null) return null;
  return <SidebarStatusGlyph state={status.state} label={label} />;
}
