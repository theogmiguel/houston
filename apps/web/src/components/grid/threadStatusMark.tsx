import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { ROW_BACK_DISMISS_CLS } from "../ui/sidebar-rail-recipes";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
  type EnvironmentThreadShell,
} from "@houston-app/client-runtime/state/models";
import { threadWokeAt } from "@houston-app/client-runtime/state/thread-settled";

import { gridThreadStatusWord } from "../../grid/statusWord";
import type { GridThreadState } from "../../grid/sidebar";
import { useAcknowledgeThreadWoke } from "../../hooks/useThreadActions";
import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "../../lib/utils";
import { ThreadStateGlyph, threadStateTextClass } from "../ui/thread-state-glyph";
import {
  SIDEBAR_THREAD_STATUS_ATTENTION_CLASS,
  SIDEBAR_THREAD_STATUS_CLASS,
  SIDEBAR_THREAD_STATUS_QUIET_CLASS,
} from "../ui/thread-tag-recipes";

function RunningElapsed({ startedAt }: { startedAt: string }) {
  const nowMs = useNowSecond();
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;
  return <span>{formatWorkingDurationLabel(nowMs - startedMs)}</span>;
}

/**
 * The Back word is a button: pressing it marks the wake as seen. It sits on the row's meta line,
 * clear of the title line's right edge, where hovering swaps the status for the row's actions.
 */
export function BackWord({ thread, nowIso }: { thread: EnvironmentThreadShell; nowIso: string }) {
  const acknowledge = useAcknowledgeThreadWoke();
  const wokeAt = threadWokeAt(thread, { now: nowIso }) ?? thread.unsettledAt;
  if (wokeAt === null) return <span className={SIDEBAR_THREAD_STATUS_CLASS}>Back</span>;
  return (
    <button
      type="button"
      aria-label="Dismiss back notification"
      data-thread-back-dismiss=""
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        acknowledge(scopeThreadRef(thread.environmentId, thread.id), wokeAt);
      }}
      className={cn(SIDEBAR_THREAD_STATUS_CLASS, ROW_BACK_DISMISS_CLS)}
    >
      Back
    </button>
  );
}

/** Attention states name themselves at the row's edge; calm ones are a mark only. */
function threadStatusInk(state: Exclude<GridThreadState, "idle">): string[] {
  return state === "back" || state === "ready"
    ? [SIDEBAR_THREAD_STATUS_QUIET_CLASS]
    : [SIDEBAR_THREAD_STATUS_ATTENTION_CLASS, threadStateTextClass(state)];
}

/**
 * A row's status mark at the right edge: a small state glyph named for assistive tech, plus the
 * specific word where the state asks something of the user (Approval, Input, Request, Failed)
 * or is quietly running (Waiting, Goal, with the elapsed time). Idle has no mark; a plain
 * running, ready or back thread is the glyph alone.
 */
export function ThreadStateMark({
  thread,
  state,
}: {
  thread: EnvironmentThreadShell;
  state: GridThreadState;
}) {
  if (state === "idle") return null;
  const startedAt = resolveThreadWorkingStartedAt(thread);
  const word = gridThreadStatusWord(thread, state) ?? "Idle";
  const showsWord =
    state === "needs" || state === "failed" || (state === "running" && word !== "Running");
  const glyph = (
    <span
      role="img"
      aria-label={word}
      data-thread-status-glyph=""
      className={cn("inline-grid size-3.5 shrink-0 place-items-center", threadStateTextClass(state))}
    >
      <ThreadStateGlyph state={state} className="size-3" />
    </span>
  );
  return (
    <span data-thread-status="" className={cn(SIDEBAR_THREAD_STATUS_CLASS, threadStatusInk(state))}>
      {showsWord ? <span aria-hidden>{word}</span> : null}
      {showsWord && state === "running" && startedAt !== null ? (
        <RunningElapsed startedAt={startedAt} />
      ) : null}
      {glyph}
    </span>
  );
}
