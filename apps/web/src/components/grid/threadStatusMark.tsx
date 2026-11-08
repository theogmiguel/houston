import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { ROW_BACK_DISMISS_CLS } from "../ui/sidebar-rail-recipes";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
  type EnvironmentThreadShell,
} from "@houston-app/client-runtime/state/models";
import { threadWokeAt } from "@houston-app/client-runtime/state/thread-settled";

import { gridThreadStatusKind, gridThreadStatusWord } from "../../grid/statusWord";
import type { GridThreadState } from "../../grid/sidebar";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { useAcknowledgeThreadWoke } from "../../hooks/useThreadActions";
import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "../../lib/utils";
import type { ThreadStatusKind } from "../ui/thread-state-glyph";
import {
  ThreadStatusKindGlyph,
  threadStatusKindGlyphClass,
  threadStatusWordClass,
} from "../ui/thread-state-glyph";
import { SIDEBAR_THREAD_STATUS_CLASS } from "../ui/thread-tag-recipes";
import { SidebarThreadStatusGlyph } from "../sidebar/SidebarStatusGlyph";

const BACK_WORD_CLASS = threadStatusWordClass("back");

/**
 * The Back word is a button: pressing it marks the wake as seen.
 */
export function BackWord({ thread, nowIso }: { thread: EnvironmentThreadShell; nowIso: string }) {
  const acknowledge = useAcknowledgeThreadWoke();
  const wokeAt = threadWokeAt(thread, { now: nowIso }) ?? thread.unsettledAt;
  if (wokeAt === null) {
    return (
      <span data-thread-status="" className={cn(SIDEBAR_THREAD_STATUS_CLASS, BACK_WORD_CLASS)}>
        Back
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label="Dismiss back notification"
      data-thread-status=""
      data-thread-back-dismiss=""
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        acknowledge(scopeThreadRef(thread.environmentId, thread.id), wokeAt);
      }}
      className={cn(SIDEBAR_THREAD_STATUS_CLASS, BACK_WORD_CLASS, ROW_BACK_DISMISS_CLS)}
    >
      Back
    </button>
  );
}

/** The start-based duration of a running row, ticking each second; null for an unreadable start. */
function useRunningDuration(startedAt: string): string | null {
  const nowMs = useNowSecond();
  const startedMs = Date.parse(startedAt);
  return Number.isNaN(startedMs) ? null : formatWorkingDurationLabel(nowMs - startedMs);
}

/** How long a running row has been going, after its word: " 7m". */
function RunningElapsed({ startedAt }: { startedAt: string }) {
  const duration = useRunningDuration(startedAt);
  return duration === null ? null : <> {duration}</>;
}

/**
 * The row's leading status mark: one 14px shape per status kind, named for assistive tech. Idle
 * is a faint ring, so the column carries a mark on every row and the glyphs line up down the list.
 */
export function ThreadStatusGlyph({
  thread,
  state,
  kind = gridThreadStatusKind(thread, state),
}: {
  thread: EnvironmentThreadShell;
  state: GridThreadState;
  /** Overrides the kind the thread's state implies, as a Closed shelf row does. */
  kind?: ThreadStatusKind;
}) {
  return (
    <span
      role="img"
      aria-label={kind === "closed" ? "Closed" : (gridThreadStatusWord(thread, state) ?? "Idle")}
      data-thread-status-glyph=""
      data-status-kind={kind}
      className={cn(
        "inline-grid size-3.5 shrink-0 place-items-center",
        threadStatusKindGlyphClass(kind),
      )}
    >
      <ThreadStatusKindGlyph kind={kind} />
    </span>
  );
}

/**
 * Whether the title line states a status in the age's slot. An idle row shows its age; a Back row
 * also keeps its age, because its dismissible word sits on the second line, clear of the hover
 * actions that share the title line's slot.
 */
export function threadHasStatus(thread: EnvironmentThreadShell, state: GridThreadState): boolean {
  return state !== "back" && gridThreadStatusWord(thread, state) !== null;
}

/**
 * The status at the title line's end, in the age's place: glyph, word and, for a running row, how
 * long it has been going ("Running 7m"). Attention states take the hue of their glyph.
 */
export function ThreadStatusWord({
  thread,
  state,
  nowIso,
}: {
  thread: EnvironmentThreadShell;
  state: GridThreadState;
  nowIso: string;
}) {
  const kind = gridThreadStatusKind(thread, state);
  const glyph = <ThreadStatusGlyph thread={thread} state={state} kind={kind} />;
  if (state === "back") {
    return (
      <span className={SIDEBAR_THREAD_STATUS_CLASS}>
        {glyph}
        <BackWord thread={thread} nowIso={nowIso} />
      </span>
    );
  }
  const startedAt = resolveThreadWorkingStartedAt(thread);
  const word = gridThreadStatusWord(thread, state) ?? "Idle";
  return (
    <span
      data-thread-status=""
      className={cn(SIDEBAR_THREAD_STATUS_CLASS, threadStatusWordClass(kind))}
    >
      {glyph}
      <span>
        {word}
        {state === "running" && startedAt !== null ? (
          <RunningElapsed startedAt={startedAt} />
        ) : null}
      </span>
    </span>
  );
}

/**
 * The grid pane label's status mark. It draws the same kind as the thread's rail
 * row, so a state looks the same beside the pane title as it does down the list.
 */
export function PaneThreadStatusMark({
  thread,
  status,
}: {
  thread: EnvironmentThreadShell;
  status: ThreadStatusPill | null;
}) {
  if (status === null) return null;
  return (
    <SidebarThreadStatusGlyph
      status={status}
      kind={gridThreadStatusKind(thread, status.state)}
      label={status.label}
    />
  );
}
