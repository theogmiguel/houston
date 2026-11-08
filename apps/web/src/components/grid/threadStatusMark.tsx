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

/** The duration the second line states for a running row: " for 7m". */
function RunningElapsed({ startedAt }: { startedAt: string }) {
  const duration = useRunningDuration(startedAt);
  return duration === null ? null : <> for {duration}</>;
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
 * The status word on the row's second line, first in the line. Attention states name themselves in
 * the hue of their glyph; Ready and Idle stay muted. A running row says how long it has been going
 * ("Running for 7m"); its age cell keeps the last-activity age, so the elapsed time is stated once.
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
  if (state === "back") return <BackWord thread={thread} nowIso={nowIso} />;
  const startedAt = resolveThreadWorkingStartedAt(thread);
  const word = gridThreadStatusWord(thread, state) ?? "Idle";
  const kind = gridThreadStatusKind(thread, state);
  return (
    <span
      data-thread-status=""
      className={cn(SIDEBAR_THREAD_STATUS_CLASS, threadStatusWordClass(kind))}
    >
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
