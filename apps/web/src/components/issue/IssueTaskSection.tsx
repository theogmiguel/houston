import type { EnvironmentId, IssueDetail, IssueRef, ProjectId } from "@houston-app/contracts";
import type { HoustonTask } from "@houston-app/contracts/houston/tasks";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { ListChecksIcon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentQuery } from "~/state/query";
import { loadTaskSettings, tasksEnvironment } from "~/state/tasks";
import { useOpenThread } from "~/threads/useOpenThread";

import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Card } from "../ui/card";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { TASK_STATUS_LABELS } from "../tasks/tasks.logic";
import { useTaskCommands } from "../tasks/useTaskCommands";

/** The one row a linked task takes in the issue panel. */
function LinkedTaskRow({ task }: { task: Pick<HoustonTask, "key" | "title" | "status"> }) {
  const navigate = useNavigate();
  return (
    <Card className="flex min-w-0 items-center gap-2 p-2">
      <ListChecksIcon aria-hidden className="size-3.5 shrink-0" />
      <InlineButton
        tone="muted"
        className="min-w-0 flex-1"
        aria-label={`Open ${task.key}`}
        onClick={() =>
          void navigate({ to: "/tasks", search: { task: task.key } as never, replace: false })
        }
      >
        <Text as="span" variant="callout" weight="medium" truncate>
          {task.key}
        </Text>
        <Text as="span" variant="callout" tone="muted" truncate>
          {task.title}
        </Text>
      </InlineButton>
      <Badge size="sm">{TASK_STATUS_LABELS[task.status]}</Badge>
    </Card>
  );
}

/**
 * What an issue means for the backlog: the one task backed by it, or the ways to make one. The
 * actions create the task from the issue and then run the Tasks page's own flow.
 */
export function IssueTaskSection({
  environmentId,
  detail,
}: {
  environmentId: EnvironmentId;
  detail: IssueDetail;
}) {
  const reference: IssueRef & { readonly host: string } = {
    projectId: detail.projectId,
    tracker: detail.tracker,
    host: detail.host,
    scope: detail.scope,
    key: detail.key,
  };
  // The hook orders stay stable: the query and every command are read on every render.
  const query = useEnvironmentQuery(tasksEnvironment.forIssue({ environmentId, input: reference }));
  const commands = useTaskCommands(environmentId);
  const openThread = useOpenThread();
  const [created, setCreated] = useState<HoustonTask | null>(null);
  const [busy, setBusy] = useState<"create" | "start" | "plan" | null>(null);
  const linked = created ?? query.data;

  if (linked !== null) return <LinkedTaskRow task={linked} />;
  if (!query.isSuccess && query.isPending) return null;

  const create = async (): Promise<HoustonTask | null> => {
    const outcome = await commands.createFromIssue(reference);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Task not created",
        description: readableFailure(squashAtomCommandFailure(outcome), "The server refused it."),
      });
      return null;
    }
    setCreated(outcome.value);
    return outcome.value;
  };

  const start = async (task: HoustonTask, overrideReadiness = false) => {
    const outcome = await commands.start({
      id: task.key,
      projectId: task.projectId ?? (reference.projectId as ProjectId),
      ...(overrideReadiness ? { overrideReadiness: true } : {}),
    });
    if (outcome._tag === "Failure") {
      const error = squashAtomCommandFailure(outcome);
      if (
        !overrideReadiness &&
        typeof error === "object" &&
        error !== null &&
        "kind" in error &&
        (error as { kind?: unknown }).kind === "unready"
      ) {
        const confirmed = await requestConfirmDialog(
          `${readableFailure(error, "The task was not ready.")}\nStart anyway? The queue will still skip it.`,
        );
        if (confirmed === true) await start(task, true);
        return;
      }
      toastManager.add({
        type: "error",
        title: "Task not started",
        description: readableFailure(error, "The server refused it."),
      });
      return;
    }
    if (outcome.value.run.threadId !== null) {
      void openThread({
        environmentId,
        projectId: task.projectId,
        threadId: outcome.value.run.threadId as never,
      });
    }
  };

  const runCreate = async () => {
    setBusy("create");
    const task = await create();
    setBusy(null);
    if (task !== null) {
      toastManager.add({ type: "success", title: `Created ${task.key}` });
    }
  };

  const runStart = async () => {
    setBusy("start");
    const task = await create();
    if (task !== null) await start(task);
    setBusy(null);
  };

  const runPlan = async () => {
    setBusy("plan");
    const task = await create();
    if (task === null) {
      setBusy(null);
      return;
    }
    const projectId = task.projectId ?? (reference.projectId as ProjectId);
    const settings = await loadTaskSettings(environmentId, projectId);
    if (settings === null) {
      setBusy(null);
      toastManager.add({
        type: "error",
        title: "Task not planned",
        description: "The workspace's task settings are not loaded yet.",
      });
      return;
    }
    const outcome = await commands.planStart({
      id: task.key,
      expectedRevision: task.revision,
      modelSelection: settings.startModel,
    });
    setBusy(null);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Task not planned",
        description: readableFailure(squashAtomCommandFailure(outcome), "The server refused it."),
      });
      return;
    }
    const threadId = outcome.value.planning?.threadId ?? null;
    if (threadId !== null) {
      void openThread({ environmentId, projectId, threadId: threadId as never });
    }
  };

  const disabled = busy !== null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Text as="span" variant="caption" tone="muted">
        No task yet.
      </Text>
      <Button size="xs" variant="outline" disabled={disabled} onClick={() => void runCreate()}>
        Create task
      </Button>
      <Button size="xs" variant="outline" disabled={disabled} onClick={() => void runStart()}>
        <PlayIcon aria-hidden />
        Start
      </Button>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void runPlan()}>
        Plan
      </Button>
    </div>
  );
}
