import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { CircleIcon } from "lucide-react";
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
import { ThreadStateGlyph, threadStateTextClass, type ThreadState } from "../ui/thread-state-glyph";
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
 * The Back word is a button: pressing it marks the wake as seen.
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

/**
 * The row's leading status mark: a state glyph named for assistive tech. Idle is a faint ring, so
 * the column carries a mark on every row and the glyphs line up down the list.
 */
export function ThreadStatusGlyph({
  thread,
  state,
}: {
  thread: EnvironmentThreadShell;
  state: GridThreadState;
}) {
  const calm = state === "idle";
  return (
    <span
      role="img"
      aria-label={gridThreadStatusWord(thread, state) ?? "Idle"}
      data-thread-status-glyph=""
      className={cn(
        "inline-grid size-3.5 shrink-0 place-items-center",
        calm ? "text-(--houston)" : threadStateTextClass(state),
      )}
    >
      {calm ? (
        <CircleIcon aria-hidden className="size-3" />
      ) : (
        <ThreadStateGlyph state={state} className="size-3" />
      )}
    </span>
  );
}

/**
 * The status word on the row's second line. States that ask something of the user (Approval,
 * Input, Request, Needs you, Failed, Limited) or run quietly (Waiting, Goal, with the elapsed
 * time) always name themselves, and Back carries its dismiss control. A calm state (Ready, Idle,
 * Running) appears only when nothing else fills the line, so every row keeps the same height.
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
  const attention =
    state === "needs" || state === "failed" || (state === "running" && word !== "Running");
  return (
    <span
      data-thread-status=""
      className={cn(
        SIDEBAR_THREAD_STATUS_CLASS,
        attention
          ? [SIDEBAR_THREAD_STATUS_ATTENTION_CLASS, threadStateTextClass(state as ThreadState)]
          : [SIDEBAR_THREAD_STATUS_QUIET_CLASS, "hidden only:inline-flex"],
      )}
    >
      <span>{word}</span>
      {state === "running" && startedAt !== null ? <RunningElapsed startedAt={startedAt} /> : null}
    </span>
  );
}
