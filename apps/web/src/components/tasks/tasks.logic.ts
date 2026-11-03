import type {
  HoustonTaskComment,
  HoustonTaskDetail,
  HoustonTaskDomainKind,
  HoustonTaskHistoryEntry,
  HoustonTaskPriority,
  HoustonTaskRun,
  HoustonTaskRunState,
  HoustonTaskStatus,
  HoustonTaskSummary,
} from "@houston-app/contracts/houston/tasks";

import {
  compareTasksForQueue,
  taskIsFolded,
  taskQueueSection,
  type TaskQueueSection,
} from "@houston-app/client-runtime/state/tasks";

export const QUEUE_SECTION_ORDER: ReadonlyArray<TaskQueueSection> = [
  "your_turn",
  "working",
  "stopped",
  "up_next",
  "backlog",
];

export const QUEUE_SECTION_LABELS: Record<TaskQueueSection, string> = {
  your_turn: "Your turn",
  working: "Agents working",
  stopped: "Stopped",
  up_next: "Up next",
  backlog: "Backlog",
  none: "Other",
};

export type TaskNextActionKind = "answer" | "review" | "resume" | "start" | "plan";

export interface TaskNextAction {
  readonly kind: TaskNextActionKind;
  readonly label: string;
}

/** The queue's one next step for a task, or null when the row offers no action. */
export function taskNextAction(summary: HoustonTaskSummary): TaskNextAction | null {
  if (taskIsFolded(summary)) return null;
  switch (taskQueueSection(summary)) {
    case "your_turn":
      return summary.openRun?.state === "waiting_for_input"
        ? { kind: "answer", label: "Answer" }
        : { kind: "review", label: "Review changes" };
    case "stopped":
      return { kind: "resume", label: "Resume" };
    case "up_next":
      return { kind: "start", label: "Start" };
    case "backlog":
      return { kind: "plan", label: "Plan" };
    case "working":
    case "none":
      return null;
  }
}

export interface TaskPlanTarget {
  readonly projectId: string | null;
  readonly domainKind: HoustonTaskDomainKind | null;
  readonly planningOpen?: boolean;
}

/** Why `houston.tasks.plan.start` would refuse this task, or null when it can plan. */
export function taskPlanBlocker(task: TaskPlanTarget): string | null {
  if (task.projectId === null) return "Assign a workspace before planning.";
  if (task.domainKind === null) return "Set a kind (delivery or slice) before planning.";
  if (task.planningOpen === true) return "A planning session is already open.";
  return null;
}

export const TASK_STATUS_LABELS: Record<HoustonTaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  canceled: "Canceled",
};

export const TASK_KIND_LABELS: Record<HoustonTaskDomainKind, string> = {
  delivery: "Delivery",
  slice: "Slice",
};

export const TASK_PRIORITY_LABELS: Record<HoustonTaskPriority, string> = {
  none: "No priority",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const TASK_RUN_STATE_LABELS: Record<HoustonTaskRunState, string> = {
  preparing: "Preparing",
  running: "Running",
  waiting_for_input: "Waiting for you",
  validating: "Validating",
  handed_back: "Handed back",
  needs_review: "Needs review",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

export function taskProgressLabel(summary: {
  readonly acceptanceChecked: number;
  readonly acceptanceTotal: number;
}): string | null {
  return summary.acceptanceTotal === 0
    ? null
    : `${summary.acceptanceChecked}/${summary.acceptanceTotal}`;
}

/** The row's second line, derived from what a summary carries. */
export function taskStatusLine(summary: HoustonTaskSummary): {
  readonly tone: "default" | "success" | "warning" | "danger";
  readonly text: string;
} {
  const section = taskQueueSection(summary);
  if (section === "your_turn") {
    if (summary.openRun?.state === "waiting_for_input") {
      return { tone: "warning", text: summary.openRun.reason ?? "The agent is waiting for you" };
    }
    return { tone: "success", text: "Ready for review" };
  }
  if (section === "working") {
    const branch = summary.openRun?.branch;
    return { tone: "default", text: branch ?? "Working" };
  }
  if (section === "stopped") {
    return { tone: "warning", text: summary.openRun?.reason ?? "Interrupted" };
  }
  if (section === "up_next") return { tone: "default", text: "Ready to start" };
  if (summary.acceptanceTotal === 0) return { tone: "warning", text: "No acceptance items" };
  if (!summary.ready) return { tone: "warning", text: "Not ready" };
  return { tone: "default", text: "Ready to plan" };
}

export interface QueuedTaskGroups {
  readonly sections: ReadonlyArray<{
    readonly section: TaskQueueSection;
    readonly label: string;
    readonly tasks: ReadonlyArray<HoustonTaskSummary>;
  }>;
  readonly folded: ReadonlyArray<HoustonTaskSummary>;
}

export function taskMatchesQuery(summary: HoustonTaskSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    summary.key.toLowerCase().includes(needle) ||
    summary.title.toLowerCase().includes(needle) ||
    String(summary.number) === needle
  );
}

export function queueTaskGroups(
  tasks: ReadonlyArray<HoustonTaskSummary>,
  options: { readonly query?: string } = {},
): QueuedTaskGroups {
  const query = options.query ?? "";
  const open = tasks.filter((task) => !taskIsFolded(task) && taskMatchesQuery(task, query));
  const sections = QUEUE_SECTION_ORDER.map((section) => {
    const inSection = open.filter((task) => taskQueueSection(task) === section);
    const ordered =
      section === "up_next"
        ? inSection.toSorted(compareTasksForQueue)
        : inSection.toSorted(byNewest);
    return { section, label: QUEUE_SECTION_LABELS[section], tasks: ordered };
  }).filter((group) => group.tasks.length > 0);
  const folded = tasks
    .filter((task) => taskIsFolded(task) && taskMatchesQuery(task, query))
    .toSorted(byNewest);
  return { sections, folded };
}

function byNewest(left: HoustonTaskSummary, right: HoustonTaskSummary): number {
  return right.number - left.number;
}

export interface ProjectDeliveryGroup {
  readonly delivery: HoustonTaskSummary;
  readonly slices: ReadonlyArray<HoustonTaskSummary>;
}

export interface ProjectTaskGroup {
  readonly projectId: string | null;
  readonly title: string;
  readonly tasks: ReadonlyArray<HoustonTaskSummary>;
  readonly deliveries: ReadonlyArray<ProjectDeliveryGroup>;
  readonly loose: ReadonlyArray<HoustonTaskSummary>;
  readonly sliceDone: number;
  readonly sliceTotal: number;
}

export const NO_PROJECT_TITLE = "No project";

/** Groups work by workspace, then by delivery and its slices, from summaries alone. */
export function groupTasksByProject(
  tasks: ReadonlyArray<HoustonTaskSummary>,
  projectTitles: ReadonlyMap<string, string>,
  options: { readonly query?: string } = {},
): ReadonlyArray<ProjectTaskGroup> {
  const query = options.query ?? "";
  const open = tasks.filter((task) => task.archivedAt === null && taskMatchesQuery(task, query));
  const byProject = new Map<string | null, HoustonTaskSummary[]>();
  for (const task of open) {
    const key = task.projectId;
    const bucket = byProject.get(key);
    if (bucket === undefined) byProject.set(key, [task]);
    else bucket.push(task);
  }
  const groups: ProjectTaskGroup[] = [];
  for (const [projectId, projectTasks] of byProject) {
    const ordered = projectTasks.toSorted(byNewest);
    const ids = new Set(ordered.map((task) => task.id));
    const slicesByParent = new Map<number, HoustonTaskSummary[]>();
    const loose: HoustonTaskSummary[] = [];
    for (const task of ordered) {
      if (task.parentId !== null && ids.has(task.parentId)) {
        const bucket = slicesByParent.get(task.parentId);
        if (bucket === undefined) slicesByParent.set(task.parentId, [task]);
        else bucket.push(task);
      } else {
        loose.push(task);
      }
    }
    const deliveries = ordered
      .filter((task) => slicesByParent.has(task.id))
      .map((delivery) => ({
        delivery,
        slices: (slicesByParent.get(delivery.id) ?? []).toSorted(byNewest),
      }));
    const slices = [...slicesByParent.values()].flat();
    groups.push({
      projectId,
      title: projectId === null ? NO_PROJECT_TITLE : (projectTitles.get(projectId) ?? projectId),
      tasks: ordered,
      deliveries,
      loose: loose.filter((task) => !slicesByParent.has(task.id)),
      sliceDone: slices.filter((slice) => slice.status === "done").length,
      sliceTotal: slices.length,
    });
  }
  return groups.toSorted((left, right) =>
    left.projectId === null
      ? 1
      : right.projectId === null
        ? -1
        : left.title.localeCompare(right.title),
  );
}

export interface TaskActivityItem {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly kind: "comment" | "history";
  readonly body?: string;
  readonly text?: string;
}

const HISTORY_ACTION_LABELS: Record<string, string> = {
  "houston:start": "Started the task",
  "houston:resume": "Resumed the task",
  "houston:retry": "Retried the task",
  "houston:stop": "Stopped the run",
  "houston:handback": "Handed the task back",
  "houston:plan-answer": "Answered a planning question",
  "houston:plan-approve": "Approved the plan",
  "houston:review": "Started a review",
  "houston:rework": "Started a rework round",
  domain_update: "Changed the delivery settings",
};

export function describeHistoryEntry(entry: HoustonTaskHistoryEntry): string {
  const label = HISTORY_ACTION_LABELS[entry.action] ?? entry.action;
  const changes = parseChanges(entry.changes);
  if (changes !== null && typeof changes.status === "object" && changes.status !== null) {
    const status = changes.status as { readonly new?: unknown };
    if (typeof status.new === "string" && status.new in TASK_STATUS_LABELS) {
      return `${label} · ${TASK_STATUS_LABELS[status.new as HoustonTaskStatus]}`;
    }
  }
  return label;
}

function parseChanges(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Comments and recorded changes in one oldest-first feed. */
export function taskActivity(
  comments: ReadonlyArray<HoustonTaskComment>,
  history: ReadonlyArray<HoustonTaskHistoryEntry>,
): ReadonlyArray<TaskActivityItem> {
  const items: TaskActivityItem[] = [
    ...comments.map((comment) => ({
      id: `comment:${comment.id}`,
      at: comment.createdAt,
      actor: comment.author,
      kind: "comment" as const,
      body: comment.body,
    })),
    ...history.map((entry) => ({
      id: `history:${entry.id}`,
      at: entry.createdAt,
      actor: entry.actor,
      kind: "history" as const,
      text: describeHistoryEntry(entry),
    })),
  ];
  return items.toSorted((left, right) => left.at.localeCompare(right.at));
}

/** The attempt a detail's card shows: the newest run of either kind. */
export function currentAttempt(detail: HoustonTaskDetail): HoustonTaskRun | null {
  return detail.runs[0] ?? null;
}

/** The newest review verdict on a task, if any run recorded one. */
export function latestReview(detail: HoustonTaskDetail) {
  return detail.runs.find((run) => run.review !== null)?.review ?? null;
}

export const TASK_KEY_PATTERN = /\bHOU-[1-9][0-9]*\b/giu;

/** Upper-case task keys in a text, in order; used for terminal links and project copy. */
export function taskKeysInText(text: string): ReadonlyArray<string> {
  return [...text.matchAll(TASK_KEY_PATTERN)].map((match) => match[0].toUpperCase());
}

const LIVE_RUN_STATES: ReadonlySet<HoustonTaskRunState> = new Set([
  "preparing",
  "running",
  "waiting_for_input",
  "validating",
]);

/** The detail header's one next step, from the task's status and its newest live run. */
export function taskDetailAction(detail: HoustonTaskDetail): TaskNextAction | null {
  const task = detail.task;
  if (task.archivedAt !== null || task.status === "done" || task.status === "canceled") return null;
  const openRun = detail.runs.find((run) => LIVE_RUN_STATES.has(run.state)) ?? null;
  if (openRun?.state === "waiting_for_input") return { kind: "answer", label: "Answer" };
  if (openRun !== null) return null;
  if (task.status === "in_review") return { kind: "review", label: "Review changes" };
  if (task.status === "in_progress") return { kind: "resume", label: "Resume" };
  if (task.status === "todo") return { kind: "start", label: "Start" };
  return { kind: "plan", label: "Plan" };
}
