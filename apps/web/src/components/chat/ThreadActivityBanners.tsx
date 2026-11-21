import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderGoal,
  OrchestrationV2ProviderSession,
  ThreadId,
} from "@houston-app/contracts";
import { RUNNING_INK_CLS } from "../ui/work-log-recipes";
import type {
  EnvironmentThreadShell,
  ThreadStructure,
} from "@houston-app/client-runtime/state/shell";
import {
  presentPendingBackgroundWork,
  presentProviderGoal,
  type RunStopPresentation,
} from "@houston-app/client-runtime/state/thread-execution";
import { childThreadInputsTitle } from "@houston-app/client-runtime/state/threads";
import { formatDuration } from "@houston-app/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import {
  CircleDashedIcon,
  CircleStopIcon,
  GitBranchIcon,
  TargetIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Fragment } from "react";
import { tickTextContent } from "~/lib/tickTextContent";
import { cn } from "~/lib/utils";
import { ThreadStateGlyph } from "../ui/thread-state-glyph";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ThreadNowItem } from "./ThreadNow";
import type { Translate } from "~/i18n/useT";
import { THREAD_NOW_DETAIL_ACTIVITY_CLS } from "../ui/thread-now-recipes";

export function extensionStatusBannerItem(
  statuses: NonNullable<OrchestrationV2ProviderSession["extensionStatuses"]>,
): ComposerBannerStackItem | null {
  if (statuses.length === 0) return null;
  return {
    id: "pi-extension-status",
    variant: "default",
    icon: <span>▸</span>,
    title: <output>{`Pi · ${statuses.map((status) => status.text).join(" · ")}`}</output>,
  };
}

/** Subagents and side chats waiting on the user, unless the parent is itself waiting on them. */
export function childInputNowItem(input: {
  readonly childThreadInputs: ReadonlyArray<EnvironmentThreadShell>;
  readonly parentAwaitingUser: boolean;
  // A task delegated to a linked environment lives there, not where the parent runs.
  readonly onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
  readonly translate?: Translate;
}): (ThreadNowItem & { readonly waitingLabel: string }) | null {
  const t = input.translate ?? ((source: string) => source);
  const { childThreadInputs, onOpenThread } = input;
  const first = childThreadInputs[0];
  if (!first || input.parentAwaitingUser) return null;
  return {
    id: `child-input:${first.id}`,
    // The only line at the end of the timeline that needs you gets the needs mark.
    icon: <ThreadStateGlyph state="needs" className="text-(--warn-ink)" />,
    title: childThreadInputsTitle(childThreadInputs),
    waitingLabel: childThreadInputs.every((child) => child.lineage.sideChat === true)
      ? t("Side chat waiting")
      : t("Subagent waiting"),
    description: childThreadInputs.map((child, index) => (
      <Fragment key={child.id}>
        {index > 0 ? " " : null}
        <span className="whitespace-nowrap">
          <InlineButton tone="muted" onClick={() => onOpenThread(child.id, child.environmentId)}>
            {child.title}
          </InlineButton>
          {index < childThreadInputs.length - 1 ? "," : null}
        </span>
      </Fragment>
    )),
    actions: (
      <InlineButton onClick={() => onOpenThread(first.id, first.environmentId)}>
        {first.hasPendingApprovals ? t("Open approval") : t("Open question")}
      </InlineButton>
    ),
  };
}

/** The thread's goal, for the end of the timeline. */
export function goalNowItem(input: {
  readonly threadId: ThreadId;
  readonly goal: OrchestrationV2ProviderGoal;
  readonly isWorking: boolean;
  readonly onSendCommand: (text: string, failureMessage: string) => Promise<void>;
  readonly translate?: Translate;
}): ThreadNowItem {
  const t = input.translate ?? ((source: string) => source);
  const { isWorking, onSendCommand } = input;
  const presentation = presentProviderGoal(input.goal, isWorking);
  return {
    id: `goal:${input.threadId}`,
    icon: <TargetIcon />,
    title:
      presentation.usage === null
        ? presentation.title
        : `${presentation.title} · ${presentation.usage}`,
    description: presentation.objective,
    // Clear stops goal work; Resume would stop unrelated work, so it waits.
    actions: (
      <>
        {presentation.canResume && !isWorking ? (
          <>
            <InlineButton
              onClick={() => void onSendCommand("/goal resume", "Failed to resume goal.")}
            >
              {t("Resume")}
            </InlineButton>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <InlineButton
          tone="muted"
          onClick={() => void onSendCommand("/goal clear", "Failed to clear goal.")}
        >
          {t("Clear")}
        </InlineButton>
      </>
    ),
  };
}

/** A Stop the provider has not finished; Force stop once it stops answering. */
export function runStopNowItem(input: {
  readonly threadId: ThreadId;
  readonly stop: RunStopPresentation;
  readonly canForceStop: boolean;
  readonly forceStopping: boolean;
  readonly onForceStop: () => void;
  readonly translate?: Translate;
}): ThreadNowItem {
  const t = input.translate ?? ((source: string) => source);
  const unresponsive = input.stop.state === "unresponsive";
  const requestedAtMs = Date.parse(input.stop.requestedAt);
  return {
    id: `run-stop:${input.threadId}`,
    icon: unresponsive ? (
      <TriangleAlertIcon className="text-warning-foreground" />
    ) : (
      <CircleStopIcon />
    ),
    title: unresponsive ? t("Agent not responding to Stop") : t("Stopping"),
    description: unresponsive
      ? t("It may be short on memory. Force stop kills its processes.")
      : undefined,
    actions: (
      <>
        <span
          ref={tickTextContent(
            (nowMs) => formatDuration(Math.max(1_000, nowMs - requestedAtMs)),
            true,
          )}
          className="tabular-nums"
        />
        {unresponsive && input.canForceStop ? (
          <InlineButton disabled={input.forceStopping} onClick={input.onForceStop}>
            {input.forceStopping ? t("Force stopping...") : t("Force stop")}
          </InlineButton>
        ) : null}
      </>
    ),
  };
}

const WHITESPACE_RUN = /\s+/gu;

/** Background commands and subagents, for the end of the timeline. */
export function backgroundWorkNowItem(input: {
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly stopDisabled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly translate?: Translate;
}): ThreadNowItem | null {
  const t = input.translate ?? ((source: string) => source);
  const { onOpenThread } = input;
  const presentation = presentPendingBackgroundWork(input.tasks);
  if (presentation === null) return null;
  const rows = presentation.items.map((task) => {
    // Same key derivePendingBackgroundWork gives turn-item tasks; subagent items carry progress.
    const item = input.turnItems.findLast(
      (candidate) => (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId,
    );
    const subagent = item?.type === "subagent" ? item : undefined;
    return {
      task,
      activity: subagent?.progress?.replace(WHITESPACE_RUN, " ").trim() || null,
      startedAtMs: item?.startedAt ? DateTime.toEpochMillis(item.startedAt) : null,
      childThreadId: task.childThreadId ?? subagent?.childThreadId ?? undefined,
    };
  });
  const [only] = rows.length === 1 ? rows : [];
  const isCommand = (row: (typeof rows)[number]) => row.task.kind !== "subagent";
  const verb = presentation.waiting ? t("Waiting on") : t("Running");
  const onlyThreadId = only?.childThreadId;
  const startedAtMs = only?.startedAtMs ?? null;
  return {
    id: `background-work:${input.threadId}`,
    icon: rows.every(isCommand) ? <TerminalIcon /> : <CircleDashedIcon />,
    title: only ? (
      <>
        <span className={RUNNING_INK_CLS}>{verb}</span>{" "}
        <span
          className={cn(
            isCommand(only) && "font-mono in-data-[slot=popover-popup]:whitespace-pre-wrap",
          )}
        >
          {only.task.label}
        </span>
      </>
    ) : (
      presentation.title
    ),
    description: only ? only.activity : undefined,
    ...(only
      ? {}
      : {
          details: rows.map((row) => (
            <span key={row.task.taskId} className={cn(isCommand(row) && "font-mono")}>
              {row.task.label}
              {row.activity ? (
                <span className={THREAD_NOW_DETAIL_ACTIVITY_CLS}> · {row.activity}</span>
              ) : null}
            </span>
          )),
          detailsLabel: t("Show details: {title}", { title: presentation.title }),
        }),
    spaced: true,
    actions: (
      <>
        {startedAtMs === null ? null : (
          <span
            ref={tickTextContent(
              (nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs)),
              true,
            )}
            className="tabular-nums"
          />
        )}
        {onlyThreadId === undefined ? null : (
          <InlineButton tone="muted" onClick={() => onOpenThread(onlyThreadId)}>
            {t("Open")}
          </InlineButton>
        )}
        <InlineButton disabled={input.stopDisabled} onClick={() => void input.onStop()}>
          {input.stopping ? t("Stopping...") : t("Stop")}
        </InlineButton>
      </>
    ),
  };
}

/** The local checkout moved off the branch this thread last ran on. */
export function branchMismatchBannerItem(input: {
  readonly mismatchKey: string;
  readonly mismatch: { readonly threadBranch: string; readonly currentBranch: string };
  readonly restoreDisabled: boolean;
  readonly restoring: boolean;
  readonly onRestore: () => void;
  readonly onDismiss: () => void;
  readonly translate?: Translate;
}): ComposerBannerStackItem {
  const t = input.translate ?? ((source: string) => source);
  const { mismatch } = input;
  return {
    id: `branch-mismatch:${input.mismatchKey}`,
    variant: "info",
    icon: <GitBranchIcon />,
    title: (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-normal text-muted-foreground">
          {t("Branch changed from")}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <code className="min-w-0 truncate font-medium text-foreground">
                {mismatch.threadBranch}
              </code>
            }
          />
          <TooltipPopup side="top">
            {t("This thread last ran on {branch}. Sending will continue on {current}.", {
              branch: mismatch.threadBranch,
              current: mismatch.currentBranch,
            })}
          </TooltipPopup>
        </Tooltip>
      </span>
    ),
    actions: (
      <Button size="xs" variant="ghost" disabled={input.restoreDisabled} onClick={input.onRestore}>
        {input.restoring ? t("Restoring...") : t("Restore branch")}
      </Button>
    ),
    dismissLabel: t("Dismiss branch change notice"),
    onDismiss: input.onDismiss,
  };
}
