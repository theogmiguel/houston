import {
  HOUSTON_MERGE_QUEUE_LIMITS,
  type HoustonMergeQueueEntry,
  type HoustonMergeQueueFailure,
  type HoustonMergeQueueGate,
  type HoustonMergeQueueLogEntry,
  type HoustonMergeQueueSettings,
  type HoustonMergeQueueSnapshot,
  type HoustonMergeQueueStatus,
  type HoustonMergeQueueVerification,
} from "@houston-app/contracts/houston/mergeQueue";

export type MergeQueueTone = "ok" | "warn" | "error" | "info" | "neutral";

const STATUS_PRESENTATION: Record<
  HoustonMergeQueueStatus,
  { readonly label: string; readonly tone: MergeQueueTone }
> = {
  ready: { label: "Ready", tone: "ok" },
  blocked: { label: "Blocked", tone: "warn" },
  verifying: { label: "Verifying", tone: "info" },
  waitingForSlot: { label: "Waiting for a slot", tone: "neutral" },
  fixing: { label: "Fixing", tone: "warn" },
  parked: { label: "Parked", tone: "error" },
  paused: { label: "Paused", tone: "neutral" },
  watching: { label: "Watching", tone: "info" },
};

const GATE_LABEL: Record<HoustonMergeQueueGate["kind"], string> = {
  mergeable: "Mergeable",
  reviewThreads: "No unresolved review threads",
  reviewer: "Reviewer passed",
  verification: "Verification",
};

const FAILURE_TITLE: Record<HoustonMergeQueueFailure["kind"], string> = {
  conflict: "Conflict rebasing onto the base",
  failed: "Verification failed",
  timedOut: "Verification timed out",
  refused: "The queue refused it",
  checksFailed: "Checks failed on the pushed head",
  ejected: "Ejected from GitHub's queue",
};

export const MERGE_QUEUE_STATUS_LABEL = STATUS_PRESENTATION;

export function mergeQueueStatusTone(status: HoustonMergeQueueStatus): MergeQueueTone {
  return STATUS_PRESENTATION[status].tone;
}

export function mergeQueueStatusLabel(
  entry: Pick<HoustonMergeQueueEntry, "status" | "verifyingSince">,
  settings: HoustonMergeQueueSettings | null,
  now: number,
): string {
  if (entry.status !== "verifying") return STATUS_PRESENTATION[entry.status].label;
  const running = entry.verifyingSince === null ? 0 : now - Date.parse(entry.verifyingSince);
  const elapsed = formatMergeQueueElapsed(Number.isFinite(running) ? running : 0);
  const limit = settings === null ? null : `${settings.timeLimitMinutes}m`;
  return limit === null ? `Verifying ${elapsed}` : `Verifying ${elapsed} / ${limit}`;
}

/** `4m 12s`: minutes and seconds, the way a verification run counts up. */
export function formatMergeQueueElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

export function formatMergeQueueClock(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function shortMergeQueueSha(sha: string | null | undefined): string {
  return sha === null || sha === undefined ? "" : sha.slice(0, 7);
}

export interface MergeQueueSections {
  readonly inLine: ReadonlyArray<HoustonMergeQueueEntry>;
  readonly parked: ReadonlyArray<HoustonMergeQueueEntry>;
  readonly today: ReadonlyArray<HoustonMergeQueueLogEntry>;
}

/** Ranked entries first, then the unranked ones held behind a parked entry or being fixed. */
export function mergeQueueSections(
  snapshot: Pick<HoustonMergeQueueSnapshot, "entries" | "log">,
  now = Date.now(),
): MergeQueueSections {
  return {
    inLine: [
      ...snapshot.entries.filter((entry) => entry.position > 0),
      ...snapshot.entries.filter((entry) => entry.position === 0 && entry.status !== "parked"),
    ],
    parked: snapshot.entries.filter((entry) => entry.status === "parked"),
    today: mergeQueueLogsToday(snapshot.log, now),
  };
}

export function mergeQueueLogsToday(
  log: ReadonlyArray<HoustonMergeQueueLogEntry>,
  now = Date.now(),
): ReadonlyArray<HoustonMergeQueueLogEntry> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return log.filter((row) => {
    const at = Date.parse(row.at);
    return Number.isFinite(at) && at >= start.getTime() && row.kind !== "push";
  });
}

/** The header count excludes parked entries, which are listed apart. */
export function mergeQueueLineCount(snapshot: Pick<HoustonMergeQueueSnapshot, "entries">): number {
  return snapshot.entries.filter((entry) => entry.status !== "parked").length;
}

export interface MergeQueueProjectEntries {
  readonly environmentId: string;
  readonly snapshot: Pick<HoustonMergeQueueSnapshot, "entries">;
}

export interface MergeQueueBadges {
  /** Entries in line across every project the list shows. */
  readonly count: number;
  readonly parked: boolean;
  readonly positions: ReadonlyMap<string, number>;
}

/** A row's badge is `environment:project:repository:number`, the same key the list rows use. */
export function mergeQueueRowKey(
  environmentId: string,
  entry: Pick<HoustonMergeQueueEntry, "projectId" | "repository" | "number">,
): string {
  return `${environmentId}:${entry.projectId}:${entry.repository.toLowerCase()}:${entry.number}`;
}

/** The header count and the row badges span every project the list shows, not just one scope. */
export function mergeQueueBadges(
  projects: ReadonlyArray<MergeQueueProjectEntries>,
): MergeQueueBadges {
  const positions = new Map<string, number>();
  let count = 0;
  let parked = false;
  for (const { environmentId, snapshot } of projects) {
    count += mergeQueueLineCount(snapshot);
    for (const entry of snapshot.entries) {
      if (entry.status === "parked") parked = true;
      positions.set(mergeQueueRowKey(environmentId, entry), entry.position);
    }
  }
  return { count, parked, positions };
}

export function mergeQueueEntryKey(projectId: string, number: number): string {
  return `${projectId}:${number}`;
}

export function mergeQueueEntryFor(
  entries: ReadonlyArray<HoustonMergeQueueEntry>,
  number: number,
): HoustonMergeQueueEntry | null {
  return entries.find((entry) => entry.number === number) ?? null;
}

/** What the row says when it is not blocked: where it stands in line. */
export function mergeQueueEntryLine(
  entry: HoustonMergeQueueEntry,
  previous: HoustonMergeQueueEntry | null,
  next: boolean,
  settings: HoustonMergeQueueSettings | null,
  now = Date.now(),
): string {
  if (entry.status === "verifying") {
    const running = entry.verifyingSince === null ? 0 : now - Date.parse(entry.verifyingSince);
    const limit = settings === null ? "" : ` of ${settings.timeLimitMinutes}m`;
    const base = entry.baseRef ?? "its base";
    return `${formatMergeQueueElapsed(Number.isFinite(running) ? running : 0)}${limit} · rebased on ${base}`;
  }
  if (entry.status === "waitingForSlot") return "Verifies once the slot on this machine is free";
  if (entry.status === "fixing") {
    return `Handed to its thread: ${entry.reason ?? "verification failed"}`;
  }
  if (entry.status === "parked") {
    return entry.reason ?? entry.failure?.message ?? "Parked";
  }
  if (entry.reason !== null) return entry.reason;
  if (next) {
    const verification = entry.verification;
    if (verification?.forkSha !== undefined) {
      return `Restacked after #${entry.dependsOn ?? "?"} · verified on ${verification.baseRef}@${shortMergeQueueSha(verification.baseSha)}`;
    }
    if (verification !== null) {
      return `Verified on ${verification.baseRef}@${shortMergeQueueSha(verification.baseSha)}`;
    }
    return "Next in line, ready to merge";
  }
  if (entry.dependsOn !== null) return `Merges after #${entry.dependsOn}, which it depends on`;
  return previous === null ? "Ready to merge" : `Merges after #${previous.number}`;
}

export function mergeQueueGateLabel(gate: HoustonMergeQueueGate): string {
  return GATE_LABEL[gate.kind];
}

export function mergeQueueGateTone(gate: HoustonMergeQueueGate): MergeQueueTone {
  switch (gate.state) {
    case "passed":
      return "ok";
    case "failed":
      return "error";
    case "pending":
      return "warn";
    case "notApplicable":
      return "neutral";
  }
}

export function mergeQueueGateReason(gate: HoustonMergeQueueGate): string {
  if (gate.state === "notApplicable" && gate.kind === "reviewer") return "Not a task slice";
  return gate.reason ?? "";
}

/** The line under the gates: the commit the verified head became. */
export function mergeQueueVerificationLine(
  entry: Pick<HoustonMergeQueueEntry, "verification">,
): string | null {
  const verification = entry.verification;
  if (verification === null) return null;
  return verificationLine(verification);
}

function verificationLine(verification: HoustonMergeQueueVerification): string {
  const at = formatMergeQueueClock(verification.at);
  const when = at === "" ? "" : ` at ${at}`;
  return `Rebased ${shortMergeQueueSha(verification.headSha)} onto ${verification.baseRef}@${shortMergeQueueSha(verification.baseSha)} and verified it as ${shortMergeQueueSha(verification.verifiedSha)}${when}. Merge head merges exactly ${shortMergeQueueSha(verification.verifiedSha)}.`;
}

export function mergeQueueFailureTitle(failure: Pick<HoustonMergeQueueFailure, "kind">): string {
  return FAILURE_TITLE[failure.kind];
}

/** Why a failed entry is out of line, and what the owner thread was told. */
export function mergeQueueFailureNote(failure: HoustonMergeQueueFailure): string {
  return failure.notifiedThreadId === null
    ? "No thread owns this pull request, so it is parked and the queue moved on."
    : "Its thread was told; the queue moved on and watches for a new head.";
}

export function mergeQueueLogLine(row: HoustonMergeQueueLogEntry): string {
  if (row.kind === "park") return `Parked. ${row.detail ?? "Verification failed"}`;
  if (row.kind === "push") {
    return `Pushed ${shortMergeQueueSha(row.newSha)} to ${row.refName ?? "its branch"} over ${shortMergeQueueSha(row.oldSha)}`;
  }
  if (row.kind === "restack") {
    return `Restacked ${row.refName ?? "its branch"} onto the base after ${shortMergeQueueSha(row.forkSha)}: ${shortMergeQueueSha(row.oldSha)} → ${shortMergeQueueSha(row.newSha)}`;
  }
  if (row.kind === "retarget") {
    return `${row.detail ?? "Retargeted"} to ${row.refName ?? "the base"}`;
  }
  if (row.kind === "hand_off") {
    return `${row.detail ?? "Handed to GitHub"} at ${shortMergeQueueSha(row.headSha)}`;
  }
  const into = row.refName ?? "its base";
  const merged = row.headSha
    ? `Merged into ${into}@${shortMergeQueueSha(row.headSha)}${row.method ? ` · ${row.method}` : ""}`
    : `Merged into ${into}`;
  return row.detail?.startsWith("Merged by ")
    ? `${merged} ${row.detail.slice("Merged ".length)}`
    : merged;
}

/** The policy line above the queue: what it does on its own, with which command. */
export function mergeQueuePolicyLine(
  settings: HoustonMergeQueueSettings | null,
  handOff: HoustonMergeQueueSnapshot["handOff"],
): string {
  const github =
    handOff === "mergeQueue"
      ? " · GitHub's merge queue lands it"
      : handOff === "autoMerge"
        ? " · GitHub auto-merge lands it"
        : "";
  if (settings === null) return `You merge the head${github}.`;
  const command = settings.verificationCommand.trim();
  if (command === "") return `You merge the head. No verification command is set${github}.`;
  const mode = settings.mergeWhenVerified
    ? `Merges when verified with ${command}`
    : `You merge the head. Each head is verified with ${command}`;
  return `${mode}, one at a time on this machine, ${settings.timeLimitMinutes} min limit${github}.`;
}

export function mergeQueueAwayNotice(
  away: Pick<HoustonMergeQueueSnapshot["away"], "merged" | "parked">,
): string | null {
  if (away.merged === 0 && away.parked === 0) return null;
  const merged =
    away.merged === 1 ? "merged 1 pull request" : `merged ${away.merged} pull requests`;
  const parked = away.parked === 1 ? "parked 1" : `parked ${away.parked}`;
  if (away.merged === 0) return `While you were away the queue parked ${away.parked}.`;
  if (away.parked === 0) return `While you were away the queue ${merged}.`;
  return `While you were away the queue ${merged} and ${parked}.`;
}

export interface MergeQueueEntryActions {
  readonly canMergeHead: boolean;
  readonly canRetry: boolean;
  readonly canHandToThread: boolean;
  readonly canDequeue: boolean;
  readonly canRevert: boolean;
}

export function mergeQueueEntryActions(
  entry: HoustonMergeQueueEntry,
  snapshot: Pick<HoustonMergeQueueSnapshot, "log">,
): MergeQueueEntryActions {
  const failed = entry.status === "parked" || entry.status === "fixing";
  return {
    canMergeHead: entry.status === "ready",
    canRetry: failed,
    canHandToThread: failed,
    canDequeue: true,
    canRevert: snapshot.log.some((row) => row.kind === "merge" && row.number === entry.number),
  };
}

const MERGE_QUEUE_COMMAND_ERROR_PATTERN = /[\r\n]/;

export function mergeQueueCommandError(command: string): string | null {
  const trimmed = command.trim();
  const bytes = new TextEncoder().encode(trimmed).length;
  const limit = HOUSTON_MERGE_QUEUE_LIMITS.commandBytes;
  if (bytes > limit) {
    return `The verification command is ${bytes} bytes; the limit is ${limit} bytes.`;
  }
  if (MERGE_QUEUE_COMMAND_ERROR_PATTERN.test(command))
    return "The verification command must be one line.";
  return null;
}

export function mergeQueueTimeLimitError(value: number): string | null {
  const { minimum, maximum } = HOUSTON_MERGE_QUEUE_LIMITS.timeLimitMinutes;
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? null
    : `The time limit is ${value} minutes; enter ${minimum}-${maximum} minutes.`;
}

export function mergeQueueSettingsError(input: {
  readonly verificationCommand: string;
  readonly timeLimitMinutes: number;
  readonly mergeWhenVerified: boolean;
}): string | null {
  const commandError = mergeQueueCommandError(input.verificationCommand);
  if (commandError !== null) return commandError;
  const limitError = mergeQueueTimeLimitError(input.timeLimitMinutes);
  if (limitError !== null) return limitError;
  if (input.mergeWhenVerified && input.verificationCommand.trim() === "") {
    return "Merge when verified needs a verification command.";
  }
  return null;
}
