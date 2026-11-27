// What a bot run's thread says about it: one state and its reason, re-derived from the thread's
// records each time, and who started each provider turn. Pure, so every row is tested alone.
import type { HoustonBotRunState } from "@houston-app/contracts/houston/bots";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from "@houston-app/contracts";
import { runRanAfter } from "@houston-app/shared/orchestrationV2ThreadError";

import { cancelledBeforeStart } from "../../orchestration-v2/RestartBackgroundNote.ts";
import { USER_STOP_REASON } from "../../orchestration-v2/RunExecutionService.ts";
import { applyCredentialRules, credentialRules } from "../redact.ts";

export type RunRead = Pick<
  OrchestrationV2Run,
  | "id"
  | "ordinal"
  | "status"
  | "queueHeld"
  | "startedAt"
  | "completedAt"
  | "restartContinuationOfRunId"
>;

export interface BotRunRead {
  /** As stored; a kind this build does not know is followed like the unattended kind. */
  readonly kind: string;
  /** Houston's own recorded stop, which explains only the thread run it names. */
  readonly stop: { readonly runId: string; readonly reason: string } | null;
  readonly thread: {
    readonly deleted: boolean;
    readonly archived: boolean;
    readonly pendingRuntimeRequest: boolean;
    readonly pendingBackground: boolean;
    readonly lastError: string | null;
  };
  readonly runs: ReadonlyArray<RunRead>;
  /** A restart continuation of the latest run that has not been delivered yet. */
  readonly continuationPending: boolean;
  /** The latest run's stop request, and whether a client's command wrote it. */
  readonly interrupt: { readonly message: string; readonly byClient: boolean } | null;
}

export interface DerivedBotRunState {
  readonly state: HoustonBotRunState;
  readonly reason: string | null;
}

const LIVE: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const MASK = credentialRules("[redacted]");

/** The newest run that ran, by `runRanAfter`; queued, rolled back and never-started runs are not. */
export const latestRunOf = (runs: ReadonlyArray<RunRead>): RunRead | undefined =>
  runs
    .filter((run) => run.status !== "queued" && run.status !== "rolled_back")
    .filter((run) => !cancelledBeforeStart(run))
    .reduce<RunRead | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );

const stopReason = (read: BotRunRead, latest: RunRead): string => {
  if (read.stop !== null && read.stop.runId === latest.id) return read.stop.reason;
  const interrupt = read.interrupt;
  if (interrupt === null) return "interrupted";
  if (interrupt.message === USER_STOP_REASON) {
    return interrupt.byClient ? "you stopped it" : "interrupted";
  }
  return `interrupted: ${interrupt.message}`;
};

/** The first row of the state table that the thread matches. Results come with the result tool. */
export const deriveBotRunState = (read: BotRunRead): DerivedBotRunState => {
  if (read.thread.deleted) return { state: "stopped", reason: "the thread was deleted" };
  if (read.thread.archived) return { state: "stopped", reason: "the thread was archived" };
  const live = read.runs.some(
    (run) => LIVE.has(run.status) || (run.status === "queued" && run.queueHeld !== true),
  );
  if (live && read.kind === "asked" && read.thread.pendingRuntimeRequest) {
    return { state: "waiting", reason: null };
  }
  if (live || read.thread.pendingBackground || read.continuationPending) {
    return { state: "running", reason: null };
  }
  const held = read.runs.some((run) => run.status === "queued" && run.queueHeld === true);
  const withHeld = (derived: DerivedBotRunState): DerivedBotRunState =>
    held
      ? {
          ...derived,
          reason:
            derived.reason === null
              ? "a message is waiting"
              : `${derived.reason}; a message is waiting`,
        }
      : derived;
  const latest = latestRunOf(read.runs);
  if (latest === undefined) {
    const rolledBack = read.runs.some((run) => run.status === "rolled_back");
    return withHeld({
      state: "stopped",
      reason: rolledBack ? "the owner went back to before it" : "stopped before it started",
    });
  }
  switch (latest.status) {
    case "completed":
      return withHeld({ state: "finished", reason: "no result handed back" });
    case "failed":
      return withHeld({
        state: "failed",
        reason: applyCredentialRules(read.thread.lastError ?? "the run failed", MASK),
      });
    default:
      return withHeld({ state: "stopped", reason: stopReason(read, latest) });
  }
};

/** A client allocates a bare uuid per command; agents' and Houston's own ids carry a prefix. */
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isClientCommandId = (commandId: string | null): boolean =>
  commandId !== null && BARE_UUID.test(commandId);

export type BotTurnStarter = "owner" | "houston";

/** `message` is the run's user message, followed through a restart continuation to its source. */
export const startedByOf = (input: {
  readonly botRunId: string;
  readonly origin: string;
  /** A delegated child of the bot thread: its turns are never the owner's. */
  readonly child: boolean;
  readonly message:
    | (Pick<OrchestrationV2ConversationMessage, "id" | "createdBy"> & {
        readonly scheduledTaskId?: string | undefined;
      })
    | undefined;
}): BotTurnStarter => {
  const { message } = input;
  if (input.child || message === undefined) return "houston";
  if (message.id === `bot-run:${input.botRunId}`) {
    return input.origin === "routine" ? "houston" : "owner";
  }
  if (message.id.startsWith("bot-owner:")) return "owner";
  return message.createdBy === "user" && message.scheduledTaskId === undefined
    ? "owner"
    : "houston";
};
