import {
  resolveSidebarStatusGlyphState,
  type SidebarStatusGlyphState,
  type ThreadStatusPill,
} from "../Sidebar.logic";

const GLYPH_LABEL: Record<Exclude<SidebarStatusGlyphState, "idle">, string> = {
  working: "Running",
  needs: "Needs you",
  done: "Ready",
  error: "Failed",
};

/**
 * The rail's status mark, laid out beside the time so titles line up. The board
 * gives each state one shape: spinner, warn dot, check or error circle.
 */
export function SidebarStatusGlyph({
  state,
  label,
}: {
  state: SidebarStatusGlyphState;
  label?: string | null | undefined;
}) {
  if (state === "idle") return null;
  return (
    <span
      role="img"
      aria-label={label ?? GLYPH_LABEL[state]}
      className="inline-grid size-3.5 shrink-0 place-items-center"
    >
      {state === "working" ? (
        <span className="size-2.5 animate-spin rounded-full border border-ring border-r-transparent motion-reduce:animate-none" />
      ) : state === "needs" ? (
        <span className="size-2 rounded-full bg-warning ring-2 ring-warning/30" />
      ) : state === "done" ? (
        <span className="h-2 w-1 -translate-y-px rotate-45 border-r-2 border-b-2 border-ring" />
      ) : (
        <span className="grid size-[11px] place-items-center rounded-full bg-destructive text-4xs font-extrabold leading-none text-destructive-foreground">
          !
        </span>
      )}
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
  return <SidebarStatusGlyph state={resolveSidebarStatusGlyphState(status)} label={label} />;
}
