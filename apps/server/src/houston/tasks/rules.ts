// The rules that decide an outcome in the Tasks backlog, as pure functions over plain values.
import {
  HOUSTON_TASK_LIMITS,
  HoustonTaskError,
  type HoustonTaskDomainKind,
  type HoustonTaskPriority,
  type HoustonTaskQueue,
  type HoustonTaskReadiness,
  type HoustonTaskRunState,
  type HoustonTaskStatus,
} from "@t3tools/contracts/houston/tasks";

export const OPEN_RUN_STATES: ReadonlySet<HoustonTaskRunState> = new Set([
  "preparing",
  "running",
  "waiting_for_input",
  "validating",
]);

export const isOpenRun = (state: HoustonTaskRunState): boolean => OPEN_RUN_STATES.has(state);

// The stored integer of a priority, as Houston 1 stored it: 0 none, 1 urgent .. 4 low.
const PRIORITIES: ReadonlyArray<HoustonTaskPriority> = ["none", "urgent", "high", "medium", "low"];

export const priorityValue = (priority: HoustonTaskPriority): number =>
  PRIORITIES.indexOf(priority);

export const priorityFromValue = (value: number): HoustonTaskPriority | undefined =>
  PRIORITIES[value];

export const refuse = (
  kind: HoustonTaskError["kind"],
  operation: string,
  message: string,
  numbers: { readonly limit?: number; readonly actual?: number; readonly expected?: number } = {},
) =>
  new HoustonTaskError({
    kind,
    operation,
    message: `${operation} refused: ${message}`,
    ...numbers,
  });

export const limitRefusal = (operation: string, limit: number, actual: number, unit: string) =>
  refuse("limit", operation, `${actual} ${unit} is over the limit of ${limit} ${unit}`, {
    limit,
    actual,
  });

export const conflictRefusal = (
  operation: string,
  what: string,
  expected: number,
  actual: number,
) =>
  refuse(
    "conflict",
    operation,
    `${what} expected revision ${expected}, actual revision ${actual}`,
    { expected, actual },
  );

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
const chars = (text: string) => [...text].length;

/** The trimmed title, or the refusal: empty is invalid, over the cap a limit. */
export const checkTitle = (operation: string, raw: string): string | HoustonTaskError => {
  const title = raw.trim();
  if (title.length === 0) {
    return refuse("invalid", operation, "a title cannot be empty (expected 1 to 200 characters)");
  }
  const length = chars(title);
  return length > HOUSTON_TASK_LIMITS.titleChars
    ? limitRefusal(operation, HOUSTON_TASK_LIMITS.titleChars, length, "characters in the title")
    : title;
};

export const checkDescription = (operation: string, text: string): HoustonTaskError | undefined => {
  const bytes = utf8Bytes(text);
  return bytes > HOUSTON_TASK_LIMITS.descriptionBytes
    ? limitRefusal(
        operation,
        HOUSTON_TASK_LIMITS.descriptionBytes,
        bytes,
        "bytes in the description",
      )
    : undefined;
};

export const checkComment = (operation: string, body: string): HoustonTaskError | undefined => {
  if (body.trim().length === 0) return refuse("invalid", operation, "a comment cannot be empty");
  const bytes = utf8Bytes(body);
  return bytes > HOUSTON_TASK_LIMITS.commentBytes
    ? limitRefusal(operation, HOUSTON_TASK_LIMITS.commentBytes, bytes, "bytes in the comment")
    : undefined;
};

/** The trimmed acceptance list, or the refusal naming the item cap or the empty item. */
export const checkAcceptance = (
  operation: string,
  raw: ReadonlyArray<string>,
): ReadonlyArray<string> | HoustonTaskError => {
  if (raw.length > HOUSTON_TASK_LIMITS.acceptanceItems) {
    return limitRefusal(
      operation,
      HOUSTON_TASK_LIMITS.acceptanceItems,
      raw.length,
      "acceptance items",
    );
  }
  const items: Array<string> = [];
  for (const [index, item] of raw.entries()) {
    const text = item.trim();
    if (text.length === 0) {
      return refuse("invalid", operation, `acceptance item ${index + 1} is empty`);
    }
    if (chars(text) > HOUSTON_TASK_LIMITS.titleChars) {
      return limitRefusal(
        operation,
        HOUSTON_TASK_LIMITS.titleChars,
        chars(text),
        `characters in acceptance item ${index + 1}`,
      );
    }
    items.push(text);
  }
  return items;
};

/** `existing` is the count before the write; the refusal names the count the write would make. */
export const checkCommentCount = (operation: string, existing: number) =>
  existing >= HOUSTON_TASK_LIMITS.commentsPerTask
    ? limitRefusal(operation, HOUSTON_TASK_LIMITS.commentsPerTask, existing + 1, "comments")
    : undefined;

export const checkTaskCount = (operation: string, existing: number) =>
  existing >= HOUSTON_TASK_LIMITS.tasks
    ? limitRefusal(operation, HOUSTON_TASK_LIMITS.tasks, existing + 1, "tasks")
    : undefined;

export const checkReworkRounds = (operation: string, rounds: number) =>
  rounds > HOUSTON_TASK_LIMITS.reworkRounds
    ? limitRefusal(operation, HOUSTON_TASK_LIMITS.reworkRounds, rounds, "rework rounds")
    : undefined;

/** `cycle` when `parentId` is `taskId` (null when new) or its descendant; `missing` if unknown. */
export const parentCycle = (
  taskId: number | null,
  parentId: number,
  parentOf: (id: number) => number | null | undefined,
): "cycle" | "missing" | null => {
  if (parentOf(parentId) === undefined) return "missing";
  const seen = new Set<number>();
  let current: number | null | undefined = parentId;
  while (current !== null && current !== undefined) {
    if (current === taskId) return "cycle";
    // A cycle already stored must not hang the walk.
    if (seen.has(current)) return "cycle";
    seen.add(current);
    current = parentOf(current);
  }
  return null;
};

/** Whether blocking `taskId` by `blockedBy` closes a loop through the stored blockers. */
export const blockerCycle = (
  taskId: number,
  blockedBy: ReadonlyArray<number>,
  blockersOf: (id: number) => ReadonlyArray<number>,
): boolean => {
  const seen = new Set<number>();
  const pending = [...blockedBy];
  while (pending.length > 0) {
    const next = pending.pop() as number;
    if (next === taskId) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...blockersOf(next));
  }
  return false;
};

export const blockerFinished = (blocker: {
  readonly status: HoustonTaskStatus;
  readonly archived: boolean;
}): boolean => blocker.status === "done" || blocker.status === "canceled";

/** The one queue a task sits in, by the first rule that holds. */
export const queueOf = (task: {
  readonly status: HoustonTaskStatus;
  readonly archived: boolean;
  readonly ready: boolean;
  /** The newest run's state, of either kind; a closed run does not count. */
  readonly runState: HoustonTaskRunState | null;
}): HoustonTaskQueue => {
  if (task.archived) return "none";
  const open = task.runState !== null && isOpenRun(task.runState) ? task.runState : null;
  if (open === "waiting_for_input") return "your_turn";
  if (open !== null) return "working";
  if (task.status === "in_review") return "your_turn";
  if (task.status === "in_progress") return "stopped";
  if (task.status === "todo" && task.ready) return "up_next";
  return "none";
};

// `none` sorts after `low`.
const readyRank = (priority: HoustonTaskPriority) =>
  priority === "none" ? PRIORITIES.length : priorityValue(priority);

/** Ready order: priority urgent to low, then none; then oldest first. */
export const compareReady = (
  left: {
    readonly priority: HoustonTaskPriority;
    readonly createdAt: string;
    readonly number: number;
  },
  right: {
    readonly priority: HoustonTaskPriority;
    readonly createdAt: string;
    readonly number: number;
  },
): number =>
  readyRank(left.priority) - readyRank(right.priority) ||
  (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0) ||
  left.number - right.number;

/** A delivery's status from its slice children only, or null for no change or a user's status. */
export const rollupDelivery = (delivery: {
  readonly current: HoustonTaskStatus;
  readonly userStatusOverride: boolean;
  readonly children: ReadonlyArray<{
    readonly kind: HoustonTaskDomainKind | null;
    readonly status: HoustonTaskStatus;
  }>;
}): HoustonTaskStatus | null => {
  if (delivery.userStatusOverride) return null;
  const slices = delivery.children.filter((child) => child.kind === "slice");
  if (slices.length === 0) return null;
  const derived: HoustonTaskStatus = slices.every((slice) => slice.status === "done")
    ? "done"
    : slices.some((slice) => slice.status === "in_progress")
      ? "in_progress"
      : slices.some((slice) => slice.status === "in_review")
        ? "in_review"
        : "todo";
  return derived === delivery.current ? null : derived;
};

/** An acceptance item an agent can check: not blank and not a placeholder. */
const verifiable = (item: string) => {
  const text = item.trim();
  return text.length > 0 && text.toLowerCase() !== "tbd";
};

export const readiness = (task: {
  readonly hasProject: boolean;
  readonly acceptance: ReadonlyArray<string>;
  readonly unansweredQuestions: number;
  readonly unfinishedBlockers: ReadonlyArray<number>;
  /** Null for a task with no domain row; then no initiative is needed. */
  readonly domain: {
    readonly kind: HoustonTaskDomainKind;
    readonly initiative: { readonly archived: boolean; readonly sameProject: boolean } | null;
  } | null;
  readonly planningOpen: boolean;
}): HoustonTaskReadiness => {
  const reasons: Array<string> = [];
  if (!task.hasProject) reasons.push("task has no project");
  if (task.domain?.kind === "delivery" && task.domain.initiative === null) {
    reasons.push("a delivery needs an initiative");
  }
  const initiative = task.domain?.initiative;
  if (
    initiative !== null &&
    initiative !== undefined &&
    (initiative.archived || !initiative.sameProject)
  ) {
    reasons.push("the task's initiative is archived or belongs to another project");
  }
  if (!task.acceptance.some(verifiable)) {
    reasons.push("task needs at least one verifiable acceptance item");
  }
  if (task.unansweredQuestions > 0) {
    reasons.push(`task has ${task.unansweredQuestions} unanswered planning question(s)`);
  }
  if (task.planningOpen) reasons.push("task has an open planning session");
  if (task.unfinishedBlockers.length > 0) {
    reasons.push(`task has ${task.unfinishedBlockers.length} unfinished blocker(s)`);
  }
  return {
    ready: reasons.length === 0,
    reasons,
    acceptanceTotal: task.acceptance.length,
    unresolvedQuestions: task.unansweredQuestions,
    unfinishedBlockers: [...task.unfinishedBlockers],
  };
};

const withoutTrailingSeparators = (path: string, separators: RegExp) => {
  let end = path.length;
  while (end > 1 && separators.test(path[end - 1] as string)) end -= 1;
  return path.slice(0, end);
};

/** Windows paths compare without case or separator kind; trailing separators never count. */
export const v1PathMatches = (v1Path: string, root: string, platform: NodeJS.Platform): boolean => {
  if (platform === "win32") {
    const normalize = (path: string) =>
      withoutTrailingSeparators(path.replaceAll("/", "\\"), /\\/).toLowerCase();
    return normalize(v1Path) === normalize(root);
  }
  return withoutTrailingSeparators(v1Path, /\//) === withoutTrailingSeparators(root, /\//);
};
