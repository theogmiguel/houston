// The merge queue's rules: enqueue checks, order, the gates, the line and who goes next, which
// verification and failure still hold, the push guard, the output tail and the WSL refusal.
// Nothing here reads GitHub, git or the database.
import type { ProjectId, PullRequestCheckStatus } from "@t3tools/contracts";
import {
  HOUSTON_MERGE_QUEUE_LIMITS,
  HoustonMergeQueueError,
  type HoustonMergeQueueEntry,
  type HoustonMergeQueueErrorKind,
  type HoustonMergeQueueFailure,
  type HoustonMergeQueueGate,
  type HoustonMergeQueueGitHubHold,
  type HoustonMergeQueueMergeMethod,
  type HoustonMergeQueueSettingsSetInput,
  type HoustonMergeQueueStatus,
  type HoustonMergeQueueVerification,
} from "@t3tools/contracts/houston/mergeQueue";
import type { HoustonTaskRunState } from "@t3tools/contracts/houston/tasks";

import { redactSecrets, stripAnsi } from "./redact.ts";

/** What a verification keeps of the command's output, and what a failure reports of it. */
export const OUTPUT_KEEP_BYTES = 64 * 1024;
const TAIL_MAX_LINES = 40;
const TAIL_MAX_CHARS = 4_000;
const SHOWN_CHECK_NAMES = 3;

export const SETTINGS_PATH = "Settings ▸ Workspaces ▸ Merge queue";

/** What the latest GitHub read said about an entry; a failed read keeps no earlier answer. */
export interface Facts {
  readonly readAt: string;
  readonly error: string | null;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string | null;
  readonly title: string | null;
  readonly url: string;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly status: PullRequestCheckStatus;
    readonly required: boolean;
  }>;
  readonly reviewDecision: "approved" | "changes-requested" | "review-required" | null;
  /** GitHub's `mergeStateStatus`; null when the read could not say. */
  readonly mergeState: string | null;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  /** Unresolved review threads among those read; null when they could not be read. */
  readonly unresolvedThreads: number | null;
  readonly threadsTruncated: boolean;
  readonly mergeMethods: {
    readonly merge: boolean;
    readonly squash: boolean;
    readonly rebase: boolean;
  };
  readonly defaultBranch: string | null;
}

/** A merged dependency as the queue last saw it. */
export interface Stacked {
  readonly number: number;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string | null;
}

export interface QueueRow {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly repository: string;
  readonly url: string;
  readonly title: string | null;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string | null;
  readonly dependsOn: number | null;
  readonly ownerThreadId: string | null;
  readonly position: number;
  readonly enqueuedAt: string;
  readonly facts: Facts | null;
  readonly verification: HoustonMergeQueueVerification | null;
  readonly failure: HoustonMergeQueueFailure | null;
  readonly stacked: Stacked | null;
  readonly github: HoustonMergeQueueGitHubHold | null;
}

/** What the Tasks backlog says about an entry's reviewer gate. */
export type Review =
  | { readonly kind: "notSlice" }
  | { readonly kind: "slice"; readonly key: string; readonly state: HoustonTaskRunState | null }
  | { readonly kind: "unreadable"; readonly error: string };

export interface LineContext {
  readonly commandSet: boolean;
  /** Why the queue is paused, naming which pause. */
  readonly paused: string | null;
  /** The entry of this project being verified now, and since when. */
  readonly running: { readonly number: number; readonly since: string } | null;
  /** Why this server cannot verify the project at all. */
  readonly refusal: string | null;
}

export const refuse = (
  kind: HoustonMergeQueueErrorKind,
  operation: string,
  message: string,
  extras: { readonly limit?: number; readonly actual?: number; readonly expected?: number } = {},
) => new HoustonMergeQueueError({ kind, operation, message, ...extras });

const count = (value: number) => value.toLocaleString("en-US");
export const shortSha = (sha: string) => sha.slice(0, 7);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const nameList = (names: ReadonlyArray<string>) =>
  names.length <= SHOWN_CHECK_NAMES
    ? names.join(", ")
    : `${names.slice(0, SHOWN_CHECK_NAMES).join(", ")} and ${names.length - SHOWN_CHECK_NAMES} more`;

/** Refuses overfilling the queue, an unqueued dependency or a cycle; a re-enqueue keeps its place. */
export const checkEnqueue = (
  rows: ReadonlyArray<Pick<QueueRow, "number" | "dependsOn">>,
  label: string,
  number: number,
  dependsOn: number | null,
): HoustonMergeQueueError | undefined => {
  const operation = "houston.mergeQueue.enqueue";
  const queued = rows.some((row) => row.number === number);
  const limit = HOUSTON_MERGE_QUEUE_LIMITS.entries;
  if (!queued && rows.length >= limit) {
    return refuse(
      "limit",
      operation,
      `the merge queue of ${label} is full: it holds ${rows.length} entries and its limit is ${limit}; refusing to enqueue PR #${number}`,
      { limit, actual: rows.length },
    );
  }
  if (dependsOn === null) return undefined;
  if (dependsOn === number) {
    return refuse(
      "invalid",
      operation,
      `PR #${number} cannot depend on itself: dependsOn forms the cycle #${number} → #${number}`,
    );
  }
  if (!rows.some((row) => row.number === dependsOn)) {
    return refuse(
      "invalid",
      operation,
      `dependsOn names PR #${dependsOn}, which is not in the merge queue of ${label}; enqueue #${dependsOn} first`,
    );
  }
  const chain = [number, dependsOn];
  let cursor = dependsOn;
  for (let step = 0; step <= rows.length; step += 1) {
    const next = rows.find((row) => row.number === cursor)?.dependsOn ?? null;
    if (next === null) return undefined;
    chain.push(next);
    if (next === number) {
      return refuse(
        "invalid",
        operation,
        `PR #${number} cannot depend on #${dependsOn}: that forms the cycle ${chain.map((n) => `#${n}`).join(" → ")}`,
      );
    }
    cursor = next;
  }
  return undefined;
};

/** First in, first out, except that an entry waits behind the entry it depends on. */
export const order = <Row extends Pick<QueueRow, "number" | "dependsOn" | "position">>(
  rows: ReadonlyArray<Row>,
): Array<Row> => {
  const waiting = [...rows].sort((left, right) => left.position - right.position);
  const ordered: Array<Row> = [];
  while (waiting.length > 0) {
    const numbers = new Set(waiting.map((row) => row.number));
    // Enqueue refuses cycles; the fallback only keeps a corrupt row from hiding the rest.
    const index = Math.max(
      0,
      waiting.findIndex((row) => row.dependsOn === null || !numbers.has(row.dependsOn)),
    );
    ordered.push(waiting.splice(index, 1)[0]!);
  }
  return ordered;
};

const FAILING: ReadonlySet<PullRequestCheckStatus> = new Set([
  "failure",
  "cancelled",
  "action-required",
]);
const PASSING: ReadonlySet<PullRequestCheckStatus> = new Set(["success", "skipped", "neutral"]);

const pendingRefusal = (number: number, facts: Facts) => {
  const pending = facts.checks
    .filter((check) => !FAILING.has(check.status) && !PASSING.has(check.status))
    .map((check) => check.name);
  return pending.length === 0
    ? null
    : `PR #${number} is waiting on ${plural(pending.length, "check", "checks")}: ${nameList(pending)}`;
};

const computingRefusal = (number: number) =>
  `GitHub is still computing whether PR #${number} can merge`;

/** A conflict with, or a branch behind, the base: a rebase answers it. */
const baseRefusal = (number: number, facts: Facts) => {
  const base = facts.baseRef ?? "its base branch";
  if (facts.mergeability === "conflicting" || facts.mergeState === "DIRTY") {
    return `PR #${number} conflicts with ${base}`;
  }
  return facts.mergeState === "BEHIND" ? `PR #${number} is behind ${base}` : null;
};

/** The `mergeable` gate's first blocking fact, in order: state, draft, checks, review, merge state. */
export const mergeRefusal = (number: number, facts: Facts): string | null => {
  if (facts.state === "merged") return `PR #${number} is already merged`;
  if (facts.state === "closed") return `PR #${number} is closed`;
  if (facts.isDraft) return `PR #${number} is a draft — mark it ready for review first`;
  const failing = facts.checks
    .filter((check) => FAILING.has(check.status))
    .map((check) => check.name);
  if (failing.length > 0) {
    return `PR #${number} has ${plural(failing.length, "failing check", "failing checks")}: ${nameList(failing)}`;
  }
  const pending = pendingRefusal(number, facts);
  if (pending !== null) return pending;
  if (facts.reviewDecision === "changes-requested")
    return `changes were requested on PR #${number}`;
  if (facts.reviewDecision === "review-required") return `PR #${number} needs an approving review`;
  const base = baseRefusal(number, facts);
  if (base !== null) return base;
  switch (facts.mergeState) {
    case "CLEAN":
      return null;
    case "DRAFT":
      return `PR #${number} is a draft — mark it ready for review first`;
    case "BLOCKED":
      return `GitHub reports PR #${number} blocked by branch protection`;
    case "HAS_HOOKS":
      return `PR #${number} is waiting on repository hooks`;
    case "UNSTABLE":
      return `GitHub reports PR #${number} unstable — a check may have failed`;
    default:
      return computingRefusal(number);
  }
};

/** The only refusal is the base: the verification's rebase answers it. */
export const baseOnly = (number: number, facts: Facts) => {
  const refusal = mergeRefusal(number, facts);
  return refusal !== null && refusal === baseRefusal(number, facts);
};

/** GitHub answers the refusal on its own given time: checks still run, or it is computing. */
const settling = (number: number, facts: Facts) => {
  const refusal = mergeRefusal(number, facts);
  return (
    refusal !== null &&
    (refusal === pendingRefusal(number, facts) || refusal === computingRefusal(number))
  );
};

/** Names of checks GitHub reports failing on the head. */
export const failingChecks = (facts: Facts) =>
  facts.checks.filter((check) => FAILING.has(check.status)).map((check) => check.name);

/** The same answer, whenever it was read. */
export const sameAnswer = (left: Facts | null, right: Facts) =>
  left !== null &&
  JSON.stringify({ ...left, readAt: "" }) === JSON.stringify({ ...right, readAt: "" });

const gate = (
  kind: HoustonMergeQueueGate["kind"],
  failure: string | null,
  applies = true,
): HoustonMergeQueueGate => ({
  kind,
  state: !applies ? "notApplicable" : failure === null ? "passed" : "failed",
  reason: failure,
});

const unread = (row: QueueRow) =>
  row.facts === null
    ? `PR #${row.number} has not been read from GitHub yet`
    : row.facts.error !== null
      ? `could not read PR #${row.number} from GitHub: ${row.facts.error}`
      : null;

const threadsRefusal = (number: number, facts: Facts) => {
  if (facts.unresolvedThreads === null) return `could not read the review threads of PR #${number}`;
  if (facts.unresolvedThreads === 0) {
    return facts.threadsTruncated
      ? `PR #${number} has more review threads than Houston reads; check them on GitHub`
      : null;
  }
  return `PR #${number} has ${plural(facts.unresolvedThreads, "unresolved review thread", "unresolved review threads")}`;
};

const reviewerRefusal = (number: number, review: Review) => {
  switch (review.kind) {
    case "notSlice":
      return null;
    case "unreadable":
      return `could not read the task backlog for PR #${number}'s reviewer verdict: ${review.error}`;
    case "slice":
      switch (review.state) {
        case "handed_back":
          return null;
        case null:
          return `${review.key} has no reviewer verdict yet`;
        case "preparing":
        case "running":
        case "waiting_for_input":
        case "validating":
          return `${review.key}'s review is still running`;
        case "needs_review":
          return `${review.key}'s newest reviewer verdict is not pass`;
        default:
          return `${review.key}'s newest review ended without a verdict`;
      }
  }
};

/** The three GitHub and backlog gates, each failing closed. */
export const gates = (row: QueueRow, review: Review): Array<HoustonMergeQueueGate> => {
  const missing = unread(row);
  const facts = row.facts;
  return [
    gate("mergeable", missing ?? (facts === null ? null : mergeRefusal(row.number, facts))),
    gate("reviewThreads", missing ?? (facts === null ? null : threadsRefusal(row.number, facts))),
    gate("reviewer", reviewerRefusal(row.number, review), review.kind !== "notSlice"),
  ];
};

/** A verification holds for the head it verified or the commit it pushed, on the same base. */
export const verificationHolds = (row: QueueRow): HoustonMergeQueueVerification | null => {
  const verification = row.verification;
  return verification !== null &&
    (verification.headSha === row.headSha || verification.verifiedSha === row.headSha) &&
    verification.baseRef === row.baseRef
    ? verification
    : null;
};

/** The pushed commit's awaited check count while GitHub reports fewer than its old head had. */
export const unreportedChecks = (row: QueueRow): number | null => {
  const held = verificationHolds(row);
  if (held === null || held.headChecks === undefined || row.headSha !== held.verifiedSha) {
    return null;
  }
  return (row.facts?.checks.length ?? 0) < held.headChecks ? held.headChecks : null;
};

/** A failure keeps the entry out of line only for the head it names. */
export const failureHolds = (row: QueueRow): HoustonMergeQueueFailure | null =>
  row.failure !== null && row.failure.headSha === row.headSha ? row.failure : null;

const verificationGate = (
  row: QueueRow,
  next: boolean,
  ctx: LineContext,
): HoustonMergeQueueGate => {
  if (!ctx.commandSet) {
    return {
      kind: "verification",
      state: "notApplicable",
      reason: "No verification command is set",
    };
  }
  if (ctx.refusal !== null) return { kind: "verification", state: "failed", reason: ctx.refusal };
  const holds = verificationHolds(row);
  if (holds !== null) {
    return {
      kind: "verification",
      state: "passed",
      reason: `Verified on ${holds.baseRef}@${shortSha(holds.baseSha)}`,
    };
  }
  if (ctx.running?.number === row.number) {
    return { kind: "verification", state: "pending", reason: "Verifying now" };
  }
  const failure = failureHolds(row);
  if (failure !== null) return { kind: "verification", state: "failed", reason: failure.message };
  return {
    kind: "verification",
    state: "pending",
    reason: next ? "Runs once the verification slot is free" : "Runs when it goes next",
  };
};

/** Houston has no answer for the entry yet, so the line waits for it instead of passing it. */
const holdsLine = (row: QueueRow, review: Review) =>
  review.kind === "unreadable" ||
  row.facts === null ||
  row.facts.error !== null ||
  row.facts.unresolvedThreads === null ||
  settling(row.number, row.facts);

type Turn =
  | { readonly kind: "open" }
  | { readonly kind: "taken" }
  | { readonly kind: "held"; readonly number: number; readonly why: string };

/** Entries in line order: parked, fixing and dependent entries at 0, the rest ranked from 1. */
export const line = (
  rows: ReadonlyArray<QueueRow>,
  reviews: ReadonlyArray<Review>,
  ctx: LineContext,
): Array<HoustonMergeQueueEntry> => {
  const queued = new Set(rows.map((row) => row.number));
  const held = new Map<number, string>();
  const blocked = new Set<number>();
  let turn: Turn = { kind: "open" };
  let rank = 0;
  return rows.map((row, index) => {
    const review = reviews[index] ?? { kind: "notSlice" };
    const rowGates = gates(row, review);
    if (
      ctx.commandSet &&
      row.facts !== null &&
      row.facts.error === null &&
      baseOnly(row.number, row.facts)
    ) {
      const base = row.baseRef ?? "its base";
      for (const [at, value] of rowGates.entries()) {
        if (value.kind === "mergeable" && value.state === "failed") {
          rowGates[at] = {
            ...value,
            state: "pending",
            reason: `${value.reason}; verification rebases it onto ${base}`,
          };
        }
      }
    }
    const failure = failureHolds(row);
    const holder =
      row.dependsOn !== null && held.has(row.dependsOn)
        ? { number: row.dependsOn, why: held.get(row.dependsOn)! }
        : null;
    let next = false;
    let status: HoustonMergeQueueStatus;
    let reason: string | null;
    let position: number;
    if (failure !== null) {
      const fixing = failure.notifiedThreadId !== null;
      status = fixing ? "fixing" : "parked";
      held.set(row.number, fixing ? "being fixed" : "parked");
      reason = failure.message;
      position = 0;
    } else if (holder !== null) {
      held.set(row.number, holder.why);
      status = "blocked";
      reason = `waits for #${holder.number}, which is ${holder.why}`;
      position = 0;
    } else {
      rank += 1;
      position = rank;
      const dependency =
        row.dependsOn === null || !queued.has(row.dependsOn)
          ? null
          : blocked.has(row.dependsOn)
            ? `waits for #${row.dependsOn}, which is blocked`
            : null;
      const gateBlock = rowGates.find((value) => value.state === "failed")?.reason ?? null;
      const holds = dependency === null && gateBlock !== null && holdsLine(row, review);
      const own = dependency ?? gateBlock ?? (ctx.commandSet ? ctx.refusal : null);
      const needsVerification = ctx.commandSet && verificationHolds(row) === null;
      const running = ctx.running?.number === row.number;
      if (own !== null) {
        blocked.add(row.number);
        if (holds && turn.kind === "open") turn = { kind: "held", number: row.number, why: own };
        status = "blocked";
        reason = own;
      } else if (running) {
        if (turn.kind === "open") turn = { kind: "taken" };
        status = "verifying";
        reason = null;
      } else if (turn.kind === "held") {
        status = "blocked";
        reason = `the queue waits for #${turn.number}: ${turn.why}`;
      } else if (turn.kind === "taken") {
        status = "ready";
        reason = null;
      } else {
        turn = { kind: "taken" };
        next = true;
        if (ctx.paused !== null) {
          status = "paused";
          reason = ctx.paused;
        } else {
          status = needsVerification ? "waitingForSlot" : "ready";
          reason = null;
        }
      }
    }
    rowGates.push(verificationGate(row, next, ctx));
    return {
      projectId: row.projectId,
      number: row.number,
      repository: row.repository,
      url: row.url,
      title: row.title,
      headRef: row.headRef,
      headSha: row.headSha,
      baseRef: row.baseRef,
      dependsOn: row.dependsOn,
      ownerThreadId: row.ownerThreadId,
      position,
      status,
      reason,
      gates: rowGates,
      verification: verificationHolds(row),
      failure,
      github: row.github !== null && row.github.headSha === row.headSha ? row.github : null,
      enqueuedAt: row.enqueuedAt,
      readAt: row.facts?.readAt ?? null,
      verifyingSince: status === "verifying" ? (ctx.running?.since ?? null) : null,
    };
  });
};

/** The entry the runner works on and the only one the user's Merge accepts. */
export const nextUp = (entries: ReadonlyArray<HoustonMergeQueueEntry>) =>
  entries.find((entry) => entry.position > 0 && entry.status !== "blocked");

/** The method the queue merges with: squash first, then a merge commit, then rebase. */
export const preferredMethod = (
  methods: Facts["mergeMethods"] | undefined,
): HoustonMergeQueueMergeMethod | null =>
  methods === undefined
    ? null
    : methods.squash
      ? "squash"
      : methods.merge
        ? "merge"
        : methods.rebase
          ? "rebase"
          : null;

export interface CheckedSettings {
  readonly verificationCommand: string;
  readonly timeLimitMinutes: number;
  readonly mergeWhenVerified: boolean;
}

/** Bounds a settings write: one trimmed line, the byte and minute limits, the policy's command. */
export const checkSettings = (
  input: Omit<HoustonMergeQueueSettingsSetInput, "projectId">,
  currentRevision: number,
): CheckedSettings | HoustonMergeQueueError => {
  const operation = "houston.mergeQueue.settings.set";
  const command = input.verificationCommand.trim();
  const bytes = new TextEncoder().encode(command).length;
  const limit = HOUSTON_MERGE_QUEUE_LIMITS.commandBytes;
  if (bytes > limit) {
    return refuse(
      "limit",
      operation,
      `the verification command is ${count(bytes)} bytes and its limit is ${count(limit)} bytes`,
      { limit, actual: bytes },
    );
  }
  if (/[\r\n]/.test(command)) {
    return refuse("invalid", operation, "the verification command must be one line");
  }
  const { minimum, maximum } = HOUSTON_MERGE_QUEUE_LIMITS.timeLimitMinutes;
  if (
    !Number.isInteger(input.timeLimitMinutes) ||
    input.timeLimitMinutes < minimum ||
    input.timeLimitMinutes > maximum
  ) {
    return refuse(
      "limit",
      operation,
      `the time limit is ${input.timeLimitMinutes} minutes; it must be ${minimum}-${maximum} minutes`,
      { limit: maximum, actual: input.timeLimitMinutes },
    );
  }
  if (input.mergeWhenVerified && command.length === 0) {
    return refuse(
      "invalid",
      operation,
      `Merge when verified needs a verification command; set one in ${SETTINGS_PATH}`,
    );
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
    return refuse(
      "conflict",
      operation,
      `the merge queue settings expected revision ${input.expectedRevision}, actual revision ${currentRevision}`,
      { expected: input.expectedRevision, actual: currentRevision },
    );
  }
  return {
    verificationCommand: command,
    timeLimitMinutes: input.timeLimitMinutes,
    mergeWhenVerified: input.mergeWhenVerified,
  };
};

export interface PushGuardInput {
  readonly branch: string;
  readonly baseRef: string | null;
  readonly defaultBranch: string | null;
  /** Branches checked out in a worktree under a managed worktrees directory of the project. */
  readonly managedBranches: ReadonlySet<string>;
  /** Branches recorded on a Houston task run of the project. */
  readonly taskBranches: ReadonlySet<string>;
}

/** Why a push to `branch` is refused, naming the branch and the rule; null allows it. */
export const pushGuard = (input: PushGuardInput): string | null => {
  const { branch } = input;
  const refused = (why: string) => `refusing to push to ${branch}: ${why}`;
  if (input.baseRef === branch) {
    return refused(
      "it is the base of the pull request, and the merge queue never pushes to a base",
    );
  }
  if (input.defaultBranch === null) {
    return refused("the repository's default branch could not be read, so it cannot be ruled out");
  }
  if (input.defaultBranch === branch) {
    return refused("it is the default branch, and the merge queue never pushes to a base");
  }
  if (!branch.startsWith("houston/") && !branch.startsWith("t3/")) {
    return refused(
      "the merge queue pushes only to branches Houston created, and it is outside houston/ and t3/",
    );
  }
  if (!input.managedBranches.has(branch) && !input.taskBranches.has(branch)) {
    return refused(
      "Houston created no worktree on that branch: none is checked out in a managed worktree or recorded on a task run",
    );
  }
  return null;
};

/** Keeps at most the last `OUTPUT_KEEP_BYTES` of a command's output. */
export const keepTail = (kept: Uint8Array, chunk: Uint8Array): Uint8Array => {
  if (chunk.length >= OUTPUT_KEEP_BYTES) return chunk.slice(chunk.length - OUTPUT_KEEP_BYTES);
  const total = kept.length + chunk.length;
  const drop = Math.max(0, total - OUTPUT_KEEP_BYTES);
  const next = new Uint8Array(total - drop);
  next.set(kept.subarray(drop), 0);
  next.set(chunk, kept.length - drop);
  return next;
};

/** The last lines of the output, without colour codes or secrets. */
export const reportTail = (bytes: Uint8Array): string => {
  const text = redactSecrets(stripAnsi(new TextDecoder().decode(bytes)))
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "");
  const tail = text.split("\n").slice(-TAIL_MAX_LINES).join("\n");
  const chars = [...tail];
  return chars.length > TAIL_MAX_CHARS ? chars.slice(-TAIL_MAX_CHARS).join("") : tail;
};

/** Why this server cannot verify in `path`: a Windows path into a WSL distro's file share. */
export const wslRefusal = (path: string, platform: NodeJS.Platform): string | null => {
  if (platform !== "win32") return null;
  const lower = path.replaceAll("/", "\\").toLowerCase();
  const share = [
    "\\\\wsl.localhost\\",
    "\\\\wsl$\\",
    "\\\\?\\unc\\wsl.localhost\\",
    "\\\\?\\unc\\wsl$\\",
  ].some((prefix) => lower.startsWith(prefix));
  return share
    ? `${path} is a WSL distro's file share, which the Windows server cannot verify in; add it as a WSL workspace so its distro verifies it`
    : null;
};

/** How one verification ended. */
export type VerifyOutcome =
  | { readonly _tag: "Passed"; readonly baseSha: string; readonly verifiedSha: string }
  | { readonly _tag: "Conflict"; readonly baseSha: string; readonly files: ReadonlyArray<string> }
  | {
      readonly _tag: "Failed";
      readonly baseSha: string;
      readonly code: number | null;
      readonly tail: string;
    }
  | { readonly _tag: "TimedOut"; readonly baseSha: string; readonly tail: string }
  | { readonly _tag: "HeadMoved"; readonly found: string }
  | { readonly _tag: "Refused"; readonly message: string };

/** The failure a verification outcome records; null for a pass or a moved head. */
export const failureFor = (
  outcome: VerifyOutcome,
  context: {
    readonly command: string;
    readonly baseRef: string;
    readonly headSha: string;
    readonly timeLimitMinutes: number;
    readonly at: string;
  },
): HoustonMergeQueueFailure | null => {
  const failure = (
    kind: HoustonMergeQueueFailure["kind"],
    message: string,
    patch: Partial<HoustonMergeQueueFailure> = {},
  ): HoustonMergeQueueFailure => ({
    kind,
    message,
    headSha: context.headSha,
    baseSha: null,
    files: [],
    outputTail: null,
    notifiedThreadId: null,
    at: context.at,
    ...patch,
  });
  const onto = (baseSha: string) => `${context.baseRef}@${shortSha(baseSha)}`;
  switch (outcome._tag) {
    case "Passed":
    case "HeadMoved":
      return null;
    case "Conflict":
      return failure(
        "conflict",
        `Rebasing onto ${onto(outcome.baseSha)} stopped on a conflict in ${plural(outcome.files.length, "file", "files")}`,
        { baseSha: outcome.baseSha, files: [...outcome.files] },
      );
    case "Failed":
      return failure(
        "failed",
        `\`${context.command}\` failed (${outcome.code === null ? "a signal" : `exit ${outcome.code}`}) on the head rebased onto ${onto(outcome.baseSha)}`,
        { baseSha: outcome.baseSha, outputTail: outcome.tail },
      );
    case "TimedOut":
      return failure(
        "timedOut",
        `\`${context.command}\` ran past its ${context.timeLimitMinutes}-minute time limit on the head rebased onto ${onto(outcome.baseSha)}`,
        { baseSha: outcome.baseSha, outputTail: outcome.tail },
      );
    case "Refused":
      return failure("refused", outcome.message);
  }
};
