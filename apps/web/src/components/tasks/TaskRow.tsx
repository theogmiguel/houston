import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";

import { RelativeTime } from "~/components/RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { ThreadDetailsRowInteractive } from "../ui/thread-details-row";
import { ThreadStateGlyph, type ThreadState } from "../ui/thread-state-glyph";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  taskNextAction,
  taskPlanBlocker,
  taskProgressLabel,
  taskStatusLine,
  type TaskNextActionKind,
} from "./tasks.logic";

function rowState(summary: HoustonTaskSummary): ThreadState {
  switch (summary.queue) {
    case "your_turn":
      return summary.openRun?.state === "waiting_for_input" ? "needs" : "ready";
    case "working":
      return "running";
    case "stopped":
      return "back";
    default:
      return "back";
  }
}

export function TaskRow({
  summary,
  progressLabel,
  onOpen,
  onAction,
}: {
  summary: HoustonTaskSummary;
  progressLabel?: string | null;
  onOpen: (summary: HoustonTaskSummary) => void;
  onAction: (kind: TaskNextActionKind, summary: HoustonTaskSummary) => void;
}) {
  const state = rowState(summary);
  const action = taskNextAction(summary);
  const planBlocker = action?.kind === "plan" ? taskPlanBlocker(summary) : null;
  const line = taskStatusLine(summary);
  const progress = progressLabel === undefined ? taskProgressLabel(summary) : progressLabel;
  const actionButton =
    action === null ? null : (
      <Button
        size="xs"
        variant={action.kind === "answer" ? "default" : "outline"}
        aria-disabled={planBlocker !== null}
        onClick={(event) => {
          event.stopPropagation();
          if (planBlocker === null) onAction(action.kind, summary);
        }}
      >
        {action.label}
      </Button>
    );
  return (
    <ThreadDetailsRowInteractive
      role="button"
      tabIndex={0}
      data-task-row={summary.key}
      aria-label={`${summary.key} ${summary.title}`}
      onClick={() => onOpen(summary)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(summary);
        }
      }}
      className="flex items-start"
    >
      <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
        <ThreadStateGlyph state={state} colored />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <Text as="span" variant="caption" mono tone="muted">
            {summary.key}
          </Text>
          <Text as="span" variant="callout" weight="medium" truncate className="flex-1">
            {summary.title}
          </Text>
          <Text as="span" variant="caption" tone="muted">
            <RelativeTime timestamp={summary.updatedAt} />
          </Text>
          {actionButton === null ? null : planBlocker === null ? (
            actionButton
          ) : (
            <Tooltip>
              <TooltipTrigger render={actionButton} />
              <TooltipPopup>{planBlocker}</TooltipPopup>
            </Tooltip>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 overflow-hidden">
          {summary.priority === "high" || summary.priority === "urgent" ? (
            <Badge variant="warning" size="sm">
              {summary.priority === "urgent" ? "Urgent" : "High"}
            </Badge>
          ) : null}
          <Text
            as="span"
            variant="caption"
            truncate
            tone={line.tone === "default" ? "secondary" : line.tone}
          >
            {line.text}
          </Text>
          {progress === null ? null : (
            <Text as="span" variant="caption" tone="muted" className="shrink-0">
              {progress}
            </Text>
          )}
        </span>
      </span>
    </ThreadDetailsRowInteractive>
  );
}
