import { type EnvironmentId, type ProjectId } from "@houston-app/contracts";
import type {
  HoustonTaskAcceptanceItem,
  HoustonTaskComment,
  HoustonTaskDetail,
  HoustonTaskDomainKind,
  HoustonTaskHistoryEntry,
  HoustonTaskPriority,
  HoustonTaskStatus,
} from "@houston-app/contracts/houston/tasks";

import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { resolveProviderInstanceDisplayName } from "@houston-app/client-runtime/state/provider-instance-display";
import * as Cause from "effect/Cause";
import {
  ArchiveIcon,
  CircleIcon,
  MoreHorizontalIcon,
  PlayIcon,
  RotateCwIcon,
  SquareIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { requestConfirmDialog } from "~/confirmDialog";
import { useOpenThreadInGrid } from "~/grid/openThreadInGrid";
import { readLocalApi } from "~/localApi";
import { useEnvironmentProviders } from "~/state/environments";
import { refreshTaskDetail, useTaskDetail, useTaskSettings } from "~/state/tasks";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Card } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { TaskEditorDialog, type TaskDeliveryOption } from "./TaskEditorDialog";
import { useTaskCommands } from "./useTaskCommands";
import {
  TASK_KIND_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_RUN_STATE_LABELS,
  TASK_STATUS_LABELS,
  currentAttempt,
  latestReview,
  taskActivity,
  taskDetailAction,
  taskPlanBlocker,
  type TaskNextAction,
} from "./tasks.logic";

type DetailTab = "overview" | "activity";

function readableFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The task request failed.";
}

function queryFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return readableFailure(error);
}

function reportFailure(title: string, error: unknown) {
  toastManager.add({ type: "error", title, description: readableFailure(error) });
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Text as="span" variant="caption" tone="muted">
        {label}
      </Text>
      <span className="flex min-w-0 flex-1 justify-end overflow-hidden">{children}</span>
    </div>
  );
}

function StatusPill({
  status,
  disabled,
  onChange,
}: {
  status: HoustonTaskStatus;
  disabled: boolean;
  onChange: (status: HoustonTaskStatus) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant="outline" disabled={disabled} aria-label="Change status" />
        }
      >
        <CircleIcon aria-hidden />
        <Text as="span" variant="callout" weight="medium">
          {TASK_STATUS_LABELS[status]}
        </Text>
      </MenuTrigger>
      <MenuPopup align="start">
        {(Object.keys(TASK_STATUS_LABELS) as HoustonTaskStatus[]).map((value) => (
          <MenuItem key={value} onClick={() => onChange(value)}>
            {TASK_STATUS_LABELS[value]}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function PriorityPill({
  priority,
  disabled,
  onChange,
}: {
  priority: HoustonTaskPriority;
  disabled: boolean;
  onChange: (priority: HoustonTaskPriority) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant="outline" disabled={disabled} aria-label="Change priority" />
        }
      >
        <Text as="span" variant="callout" weight="medium">
          {TASK_PRIORITY_LABELS[priority]}
        </Text>
      </MenuTrigger>
      <MenuPopup align="start">
        {(Object.keys(TASK_PRIORITY_LABELS) as HoustonTaskPriority[]).map((value) => (
          <MenuItem key={value} onClick={() => onChange(value)}>
            {TASK_PRIORITY_LABELS[value]}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function KindPill({
  kind,
  parentId,
  disabled,
  onChange,
}: {
  kind: HoustonTaskDomainKind | null;
  parentId: number | null;
  disabled: boolean;
  onChange: (kind: HoustonTaskDomainKind) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" variant="outline" disabled={disabled} aria-label="Change kind" />}
      >
        <Text as="span" variant="callout" weight="medium">
          {kind === null ? "No kind" : TASK_KIND_LABELS[kind]}
        </Text>
      </MenuTrigger>
      <MenuPopup align="start">
        {(Object.keys(TASK_KIND_LABELS) as HoustonTaskDomainKind[]).map((value) => (
          <MenuItem
            key={value}
            disabled={value === "slice" && parentId === null}
            onClick={() => onChange(value)}
          >
            {TASK_KIND_LABELS[value]}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function WorkspacePill({
  projects,
  projectId,
  disabled,
  onChange,
}: {
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  projectId: string | null;
  disabled: boolean;
  onChange: (projectId: string | null) => void;
}) {
  const title =
    projectId === null
      ? "No workspace"
      : (projects.find((p) => p.id === projectId)?.title ?? projectId);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant="outline" disabled={disabled} aria-label="Change workspace" />
        }
      >
        <Text as="span" variant="callout" weight="medium" truncate>
          {title}
        </Text>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem onClick={() => onChange(null)}>No workspace</MenuItem>
        <MenuSeparator />
        {projects.map((project) => (
          <MenuItem key={project.id} onClick={() => onChange(project.id)}>
            {project.title}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function AttemptCard({
  detail,
  environmentId,
  onOpenThread,
}: {
  detail: HoustonTaskDetail;
  environmentId: EnvironmentId;
  onOpenThread: (threadId: string) => void;
}) {
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const run = currentAttempt(detail);
  if (run === null) return null;
  const provider = providers.find((entry) => entry.instanceId === run.provider);
  const providerLabel =
    provider === undefined ? run.provider : resolveProviderInstanceDisplayName(provider);
  const review = latestReview(detail);
  const waiting = run.state === "waiting_for_input";
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Text as="span" variant="caption" tone="muted">
            Attempt {run.attempt}
          </Text>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {provider === undefined ? null : (
              <ProviderInstanceIcon
                driverKind={provider.driver}
                displayName={providerLabel}
                size="compact"
              />
            )}
            <Text as="span" variant="callout" weight="medium" truncate>
              {providerLabel}
            </Text>
          </span>
          <Badge
            variant={waiting ? "warning" : run.state === "failed" ? "error" : "default"}
            size="sm"
          >
            {TASK_RUN_STATE_LABELS[run.state]}
          </Badge>
        </div>
        {run.reason === null ? null : (
          <Text variant="callout" tone={waiting ? "warning" : "muted"}>
            {run.reason}
          </Text>
        )}
        <PropertyRow label="Branch">
          <Text as="span" variant="caption" mono truncate>
            {run.branch ?? "No branch"}
          </Text>
        </PropertyRow>
        <PropertyRow label="Thread">
          {run.threadId === null ? (
            <Text as="span" variant="caption" tone="muted">
              No thread
            </Text>
          ) : (
            <InlineButton
              tone="muted"
              onClick={() => onOpenThread(run.threadId as string)}
              className="min-w-0"
            >
              <Text as="span" variant="caption" tone="secondary" truncate>
                Open thread
              </Text>
            </InlineButton>
          )}
        </PropertyRow>
        {review === null ? null : (
          <PropertyRow label="Review">
            <Text
              as="span"
              variant="caption"
              tone={
                review.verdict === "pass"
                  ? "success"
                  : review.verdict === "fail"
                    ? "danger"
                    : "muted"
              }
            >
              {review.verdict === "pass"
                ? "Passed"
                : review.verdict === "fail"
                  ? `${review.findings.length} findings`
                  : (review.skippedReason ?? "Skipped")}
              {review.outdated ? " · outdated" : ""}
            </Text>
          </PropertyRow>
        )}
      </div>
    </Card>
  );
}

function AcceptanceList({
  items,
  disabled,
  onToggle,
}: {
  items: ReadonlyArray<HoustonTaskAcceptanceItem>;
  disabled: boolean;
  onToggle: (item: HoustonTaskAcceptanceItem, checked: boolean) => void;
}) {
  if (items.length === 0) {
    return (
      <Text variant="callout" tone="muted">
        No acceptance items yet. Add them when you edit the task.
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {items.map((item) => (
        <label key={item.id} className="flex min-w-0 items-start gap-2 py-0.5">
          <Checkbox
            checked={item.checkedAt !== null}
            disabled={disabled}
            onCheckedChange={(checked) => onToggle(item, checked === true)}
            aria-label={`Acceptance ${item.position + 1}`}
          />
          <Text
            as="span"
            variant="callout"
            tone={item.checkedAt === null ? "default" : "muted"}
            className="flex-1"
          >
            {item.text}
          </Text>
        </label>
      ))}
    </div>
  );
}

function ActivityFeed({
  comments,
  history,
}: {
  comments: ReadonlyArray<HoustonTaskComment>;
  history: ReadonlyArray<HoustonTaskHistoryEntry>;
}) {
  const items = taskActivity(comments, history);
  if (items.length === 0) {
    return (
      <Text variant="callout" tone="muted">
        No activity yet.
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.id} className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <Text as="span" variant="caption" tone="secondary" weight="medium" truncate>
              {item.actor === "user" ? "You" : item.actor}
            </Text>
            <Text as="span" variant="caption" tone="muted">
              <RelativeTime timestamp={item.at} />
            </Text>
          </div>
          {item.kind === "comment" ? (
            <Text variant="callout" preserve>
              {item.body}
            </Text>
          ) : (
            <Text variant="callout" tone="muted">
              {item.text}
            </Text>
          )}
        </div>
      ))}
    </div>
  );
}

const LIVE_RUN_STATES = new Set(["preparing", "running", "waiting_for_input", "validating"]);

export function TaskDetailPanel({
  environmentId,
  taskKey,
  projects,
  deliveries = [],
}: {
  environmentId: EnvironmentId;
  taskKey: string;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  deliveries?: ReadonlyArray<TaskDeliveryOption>;
}) {
  const result = useTaskDetail(environmentId, taskKey);
  const detail = result !== null && result._tag === "Success" ? result.value : null;
  const settings = useTaskSettings(environmentId, detail?.task.projectId ?? null);
  const openThread = useOpenThreadInGrid();
  const commands = useTaskCommands(environmentId);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [comment, setComment] = useState("");
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [editing, setEditing] = useState(false);

  if (detail === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6">
        <Text variant="callout" tone="muted">
          {result !== null && result._tag === "Failure"
            ? queryFailure(result.cause)
            : "Loading task…"}
        </Text>
        {result !== null && result._tag === "Failure" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => refreshTaskDetail(environmentId, taskKey)}
          >
            Reload
          </Button>
        ) : null}
      </div>
    );
  }

  const task = detail.task;
  const action = taskDetailAction(detail);
  const attempt = currentAttempt(detail);
  const domain = detail.domain;
  const plan = domain.plan;
  const unanswered =
    plan?.proposal.questions.filter(
      (question) => !plan.answers.some((answer) => answer.question === question),
    ) ?? [];
  const disabled = busy !== null;
  const planBlocker = taskPlanBlocker({
    projectId: task.projectId,
    domainKind: domain.kind,
    planningOpen: detail.planning !== null,
  });

  const reload = () => {
    setConflict(false);
    refreshTaskDetail(environmentId, taskKey);
  };

  const handleFailure = (title: string, error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "kind" in error &&
      (error as { kind?: unknown }).kind === "conflict"
    ) {
      setConflict(true);
    }
    reportFailure(title, error);
  };

  const runSave = async (patch: {
    readonly title?: string;
    readonly description?: string;
    readonly status?: HoustonTaskStatus;
    readonly priority?: HoustonTaskPriority;
    readonly projectId?: ProjectId | null;
    readonly acceptance?: ReadonlyArray<string>;
  }) => {
    setBusy("save");
    const outcome = await commands.save({ id: task.key, expectedRevision: task.revision, patch });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Task not saved", squashAtomCommandFailure(outcome));
      return false;
    }
    return true;
  };

  const runDomainSave = async (kind: HoustonTaskDomainKind) => {
    setBusy("domain");
    const outcome = await commands.saveDomain({
      id: task.key,
      expectedRevision: task.revision,
      kind,
    });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Kind not saved", squashAtomCommandFailure(outcome));
    }
  };

  const runCheck = async (item: HoustonTaskAcceptanceItem, checked: boolean) => {
    setBusy("check");
    const outcome = await commands.check({ id: task.key, item: item.id, checked });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Acceptance not updated", squashAtomCommandFailure(outcome));
    }
  };

  const runComment = async () => {
    const body = comment.trim();
    if (body.length === 0) return;
    setBusy("comment");
    const outcome = await commands.comment({ id: task.key, body });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Comment not added", squashAtomCommandFailure(outcome));
      return;
    }
    setComment("");
  };

  const runArchive = async (archived: boolean) => {
    setBusy("archive");
    const outcome = await commands.archive({
      id: task.key,
      archived,
      expectedRevision: task.revision,
    });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Task not archived", squashAtomCommandFailure(outcome));
    }
  };

  const runControl = async (runId: number, control: "stop" | "resume" | "retry") => {
    setBusy(control);
    const outcome = await commands.runControl({ runId, action: control });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Run not changed", squashAtomCommandFailure(outcome));
      return;
    }
    refreshTaskDetail(environmentId, taskKey);
  };

  const openRunThread = (threadId: string) => {
    void openThread({
      environmentId,
      projectId: task.projectId,
      threadId: threadId as never,
    });
  };

  const runStart = async (overrideReadiness = false) => {
    setBusy("start");
    const outcome = await commands.start({
      id: task.key,
      ...(task.projectId === null ? {} : { projectId: task.projectId }),
      ...(overrideReadiness ? { overrideReadiness: true } : {}),
    });
    setBusy(null);
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
          `${readableFailure(error)}\nStart anyway? The queue will still skip it.`,
        );
        if (confirmed === true) await runStart(true);
        return;
      }
      handleFailure("Task not started", error);
      return;
    }
    refreshTaskDetail(environmentId, taskKey);
    if (outcome.value.run.threadId !== null) openRunThread(outcome.value.run.threadId as string);
  };

  const runPlan = async () => {
    if (settings === null) {
      reportFailure("Plan not started", "The workspace's task settings are not loaded yet.");
      return;
    }
    setBusy("plan");
    const outcome = await commands.planStart({
      id: task.key,
      expectedRevision: task.revision,
      modelSelection: settings.startModel,
    });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Plan not started", squashAtomCommandFailure(outcome));
      return;
    }
    refreshTaskDetail(environmentId, taskKey);
    const threadId = outcome.value.planning?.threadId ?? null;
    if (threadId !== null) openRunThread(threadId as string);
  };

  const answerQuestion = async (question: string) => {
    const answer = (questionDrafts[question] ?? "").trim();
    if (answer.length === 0) return;
    setBusy("answer");
    const outcome = await commands.planAnswer({
      id: task.key,
      expectedRevision: task.revision,
      question,
      answer,
    });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Answer not saved", squashAtomCommandFailure(outcome));
      return;
    }
    setQuestionDrafts((current) => {
      const next = { ...current };
      delete next[question];
      return next;
    });
  };

  const approvePlan = async () => {
    if (plan === null) return;
    setBusy("approve");
    const outcome = await commands.planApprove({
      id: task.key,
      expectedRevision: task.revision,
      planRevision: plan.revision,
    });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Plan not approved", squashAtomCommandFailure(outcome));
    }
  };

  const startReview = async () => {
    if (attempt === null) return;
    setBusy("review");
    const outcome = await commands.reviewStart({ runId: attempt.id });
    setBusy(null);
    if (outcome._tag === "Failure") {
      handleFailure("Review not started", squashAtomCommandFailure(outcome));
      return;
    }
    refreshTaskDetail(environmentId, taskKey);
    const review = outcome.value.runs[0];
    if (review?.threadId !== undefined && review?.threadId !== null) {
      openRunThread(review.threadId as string);
    }
  };

  const primary = (next: TaskNextAction | null) => {
    switch (next?.kind) {
      case "answer":
        return (
          <Button
            size="sm"
            disabled={attempt?.threadId === null}
            onClick={() =>
              attempt?.threadId ? openRunThread(attempt.threadId as string) : undefined
            }
          >
            Answer
          </Button>
        );
      case "review":
        return (
          <Button
            size="sm"
            onClick={() =>
              attempt?.threadId ? openRunThread(attempt.threadId as string) : undefined
            }
          >
            Review changes
          </Button>
        );
      case "resume":
        return (
          <Button
            size="sm"
            disabled={disabled || attempt === null}
            onClick={() => (attempt ? void runControl(attempt.id, "resume") : undefined)}
          >
            <PlayIcon aria-hidden />
            Resume
          </Button>
        );
      case "start":
        return (
          <Button size="sm" disabled={disabled} onClick={() => void runStart()}>
            <PlayIcon aria-hidden />
            Start
          </Button>
        );
      case "plan": {
        const button = (
          <Button
            size="sm"
            disabled={disabled}
            aria-disabled={planBlocker !== null}
            onClick={() => {
              if (planBlocker === null) void runPlan();
            }}
          >
            Plan
          </Button>
        );
        return planBlocker === null ? (
          button
        ) : (
          <Tooltip>
            <TooltipTrigger render={button} />
            <TooltipPopup>{planBlocker}</TooltipPopup>
          </Tooltip>
        );
      }
      default:
        return null;
    }
  };

  const openSource = () => {
    if (task.refUrl === null) return;
    const url = task.refUrl;
    const api = readLocalApi();
    if (api == null) window.open(url, "_blank", "noreferrer");
    else void api.shell.openExternal(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 flex-col gap-2 p-4 pb-3">
        <Text as="span" variant="caption" mono tone="muted">
          {task.key}
        </Text>
        <Text variant="headline" weight="semibold">
          {task.title}
        </Text>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <StatusPill
            status={task.status}
            disabled={disabled}
            onChange={(status) => void runSave({ status })}
          />
          <PriorityPill
            priority={task.priority}
            disabled={disabled}
            onChange={(priority) => void runSave({ priority })}
          />
          <KindPill
            kind={domain.kind}
            parentId={task.parentId}
            disabled={disabled}
            onChange={(kind) => void runDomainSave(kind)}
          />
          <WorkspacePill
            projects={projects}
            projectId={task.projectId}
            disabled={disabled}
            onChange={(projectId) => void runSave({ projectId: projectId as ProjectId | null })}
          />
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          {primary(action)}
          <Menu>
            <MenuTrigger
              render={<Button size="icon-sm" variant="outline" aria-label="More task actions" />}
            >
              <MoreHorizontalIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setEditing(true)}>Edit task</MenuItem>
              {attempt?.threadId === undefined || attempt?.threadId === null ? null : (
                <MenuItem onClick={() => openRunThread(attempt.threadId as string)}>
                  Open session
                </MenuItem>
              )}
              {attempt !== null && attempt.kind === "implementation" ? (
                <MenuItem onClick={() => void startReview()}>Review with an agent</MenuItem>
              ) : null}
              {attempt?.state === "failed" || attempt?.state === "needs_review" ? (
                <MenuItem
                  onClick={() => (attempt ? void runControl(attempt.id, "retry") : undefined)}
                >
                  <RotateCwIcon aria-hidden />
                  Retry
                </MenuItem>
              ) : null}
              {attempt !== null && LIVE_RUN_STATES.has(attempt.state) ? (
                <MenuItem onClick={() => void runControl(attempt.id, "stop")}>
                  <SquareIcon aria-hidden />
                  Stop run
                </MenuItem>
              ) : null}
              <MenuSeparator />
              {task.archivedAt === null ? (
                <MenuItem onClick={() => void runArchive(true)}>
                  <ArchiveIcon aria-hidden />
                  Archive task
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void runArchive(false)}>
                  <ArchiveIcon aria-hidden />
                  Restore task
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {conflict ? (
        <div className="mx-4 mb-3">
          <Alert variant="warning" controlAlignment="first-line">
            <AlertDescription>
              This task changed elsewhere. Reload before saving again.
            </AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={reload}>
                Reload
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        <AttemptCard detail={detail} environmentId={environmentId} onOpenThread={openRunThread} />
        <div className="flex min-w-0 items-center gap-1">
          <Button
            size="sm"
            variant={tab === "overview" ? "secondary" : "ghost"}
            onClick={() => setTab("overview")}
          >
            Overview
          </Button>
          <Button
            size="sm"
            variant={tab === "activity" ? "secondary" : "ghost"}
            onClick={() => setTab("activity")}
          >
            Activity {detail.comments.length + detail.history.length}
          </Button>
        </div>
        {tab === "overview" ? (
          <div className="flex min-w-0 flex-col gap-4">
            <section className="flex min-w-0 flex-col gap-1">
              <Text variant="caption" tone="muted" weight="medium">
                Description
              </Text>
              <Text variant="callout" preserve>
                {task.description.trim().length === 0 ? "No description yet." : task.description}
              </Text>
            </section>
            <section className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <Text variant="caption" tone="muted" weight="medium">
                  Acceptance
                </Text>
                <Text variant="caption" tone="muted">
                  {detail.acceptance.filter((item) => item.checkedAt !== null).length}/
                  {detail.acceptance.length}
                </Text>
              </div>
              <AcceptanceList
                items={detail.acceptance}
                disabled={disabled}
                onToggle={(item, checked) => void runCheck(item, checked)}
              />
            </section>
            {domain.readiness.reasons.length === 0 ? null : (
              <section className="flex min-w-0 flex-col gap-1">
                <Text variant="caption" tone="muted" weight="medium">
                  Before it can start
                </Text>
                {domain.readiness.reasons.map((reason) => (
                  <Text key={reason} variant="callout" tone="warning">
                    {reason}
                  </Text>
                ))}
              </section>
            )}
            {plan === null ? null : (
              <section className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Text variant="caption" tone="muted" weight="medium">
                    Plan
                  </Text>
                  <Text variant="caption" tone="muted">
                    {plan.answers.length}/{plan.proposal.questions.length} answered
                  </Text>
                </div>
                {plan.proposal.description.trim().length === 0 ? null : (
                  <Text variant="callout" preserve>
                    {plan.proposal.description}
                  </Text>
                )}
                {plan.proposal.questions.map((question) => {
                  const answer = plan.answers.find((entry) => entry.question === question);
                  return (
                    <div key={question} className="flex min-w-0 flex-col gap-1">
                      <Text variant="callout" weight="medium">
                        {question}
                      </Text>
                      {answer === undefined ? (
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Input
                            value={questionDrafts[question] ?? ""}
                            placeholder="Your answer"
                            aria-label="Your answer"
                            onChange={(event) =>
                              setQuestionDrafts((current) => ({
                                ...current,
                                [question]: event.currentTarget.value,
                              }))
                            }
                          />
                          <Button
                            size="sm"
                            disabled={
                              disabled || (questionDrafts[question] ?? "").trim().length === 0
                            }
                            onClick={() => void answerQuestion(question)}
                          >
                            Answer
                          </Button>
                        </div>
                      ) : (
                        <Text variant="callout" tone="muted">
                          {answer.answer}
                        </Text>
                      )}
                    </div>
                  );
                })}
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || unanswered.length > 0}
                    onClick={() => void approvePlan()}
                  >
                    Approve plan
                  </Button>
                </div>
              </section>
            )}
            {task.refUrl === null ? null : (
              <section className="flex min-w-0 items-center gap-2">
                <Text variant="caption" tone="muted" weight="medium">
                  Source
                </Text>
                <Button size="sm" variant="ghost" onClick={openSource}>
                  <Text as="span" variant="callout" tone="accent" truncate>
                    {task.refUrl}
                  </Text>
                </Button>
              </section>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <ActivityFeed comments={detail.comments} history={detail.history} />
            <div className="flex min-w-0 flex-col gap-1.5">
              <Textarea
                value={comment}
                onChange={(event) => setComment(event.currentTarget.value)}
                placeholder="Add a comment"
                aria-label="Add a comment"
                rows={3}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={disabled || comment.trim().length === 0}
                  onClick={() => void runComment()}
                >
                  Comment
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
      <TaskEditorDialog
        open={editing}
        onOpenChange={setEditing}
        environmentId={environmentId}
        projects={projects}
        task={task}
        domainKind={domain.kind}
        deliveries={deliveries}
        acceptance={detail.acceptance}
        onSaved={() => refreshTaskDetail(environmentId, taskKey)}
        onConflict={() => setConflict(true)}
      />
    </div>
  );
}
