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

/** The Back word is a button: pressing it marks the wake as seen. */
function BackWord({ thread, nowIso }: { thread: EnvironmentThreadShell; nowIso: string }) {
  const acknowledge = useAcknowledgeThreadWoke();
  const wokeAt = threadWokeAt(thread, { now: nowIso }) ?? thread.unsettledAt;
  if (wokeAt === null) return <span>Back</span>;
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
      className={ROW_BACK_DISMISS_CLS}
    >
      Back
    </button>
  );
}

/**
 * Running, needs you and failed colour the whole mark; ready, idle and back keep the word in the
 * muted meta ink (ready still colours its glyph through `ThreadStateGlyph`'s `colored`).
 */
function threadStatusInk(state: GridThreadState): string[] {
  return state === "idle" || state === "back" || state === "ready"
    ? [SIDEBAR_THREAD_STATUS_QUIET_CLASS]
    : [SIDEBAR_THREAD_STATUS_ATTENTION_CLASS, threadStateTextClass(state)];
}

/**
 * A row's status mark: the glyph and the specific word, with the elapsed time
 * for every running state, waiting included.
 */
export function ThreadStateMark({
  thread,
  state,
  nowIso,
}: {
  thread: EnvironmentThreadShell;
  state: GridThreadState;
  nowIso: string;
}) {
  const startedAt = resolveThreadWorkingStartedAt(thread);
  const word = gridThreadStatusWord(thread, state) ?? "Idle";
  return (
    <span data-thread-status="" className={cn(SIDEBAR_THREAD_STATUS_CLASS, threadStatusInk(state))}>
      {state === "idle" ? (
        <CircleIcon aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <ThreadStateGlyph state={state} className="size-3.5" colored={state === "ready"} />
      )}
      {state === "back" ? <BackWord thread={thread} nowIso={nowIso} /> : <span>{word}</span>}
      {state === "running" && startedAt !== null ? <RunningElapsed startedAt={startedAt} /> : null}
    </span>
  );
}
