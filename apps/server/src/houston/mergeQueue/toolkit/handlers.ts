// Every call resolves the caller thread's project and acts on that project's queue only; a pull
// request URL of another repository is refused before GitHub is read.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  HoustonMergeQueueError,
  type HoustonMergeQueueEntry,
} from "@t3tools/contracts/houston/mergeQueue";
import { hasSourceThread } from "@t3tools/contracts/houston/sideThreads";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { loadCaller } from "../../../mcp/threadAccess.ts";
import { SIDE_THREAD_READ_ONLY } from "../../sideThreads.ts";
import { HoustonMergeQueueProject } from "../Project.ts";
import { refuse } from "../rules.ts";
import { HoustonMergeQueueService } from "../Service.ts";
import {
  HOUSTON_MERGE_QUEUE_UNTRUSTED_LABEL,
  type HoustonMergeQueueAgentEntry,
  HoustonMergeQueueToolkit,
} from "./tools.ts";

const PULL_URL = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i;

const untrusted: typeof HOUSTON_MERGE_QUEUE_UNTRUSTED_LABEL = HOUSTON_MERGE_QUEUE_UNTRUSTED_LABEL;

const isQueueError = Schema.is(HoustonMergeQueueError);

/** A queue refusal can quote GitHub or git (a fork's name, an error), so it carries the label. */
const labelled = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.mapError(effect, (error) =>
    isQueueError(error)
      ? (new HoustonMergeQueueError({
          kind: error.kind,
          operation: error.operation,
          message: `${error.message}. ${untrusted}`,
          ...(error.limit === undefined ? {} : { limit: error.limit }),
          ...(error.actual === undefined ? {} : { actual: error.actual }),
          ...(error.expected === undefined ? {} : { expected: error.expected }),
        }) as E)
      : error,
  );

/** The calling thread and its project, once its credential grants pull requests. */
const callerOf = Effect.fn("HoustonMergeQueueToolkit.callerOf")(function* (
  tool: string,
  access: "reads" | "writes",
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadScope = yield* McpInvocationContext.requireThreadScope(scope, tool);
  yield* McpInvocationContext.requireMcpCapability("pull-requests");
  const { caller } = yield* loadCaller();
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  // Side threads hold no credential; this backstops a credential that outlived that rule.
  if (access === "writes" && caller.side !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `${tool} refused: ${caller.id} is a side thread (${caller.side.kind}${hasSourceThread(caller.side) ? ` of ${caller.side.sourceThreadId}` : ""}). ${SIDE_THREAD_READ_ONLY}`,
    });
  }
  return { threadId: threadScope.thread.threadId, projectId: caller.projectId };
});

/** The number in the caller's repository; a URL of another repository is refused naming both. */
const ownNumber = Effect.fn("HoustonMergeQueueToolkit.ownNumber")(function* (
  tool: string,
  projectId: HoustonMergeQueueEntry["projectId"],
  pullRequest: number | string,
) {
  if (typeof pullRequest === "number") return pullRequest;
  const match = PULL_URL.exec(pullRequest.trim());
  if (match === null) {
    return yield* refuse("invalid", tool, `${pullRequest} is not a pull request number or URL`);
  }
  const target = yield* (yield* HoustonMergeQueueProject).target(tool, projectId);
  const host = match[1]!;
  const repository = match[2]!;
  const own = `${target.host}/${target.repository}`;
  if (host.toLowerCase() !== target.host.toLowerCase()) {
    return yield* refuse(
      "refused",
      tool,
      `${pullRequest} is on ${host}/${repository}, not ${own}; an agent of ${target.title} queues only pull requests of ${own}`,
    );
  }
  if (repository.toLowerCase() !== target.repository.toLowerCase()) {
    return yield* refuse(
      "refused",
      tool,
      `${pullRequest} is in ${repository}, not ${target.repository}; an agent of ${target.title} queues only pull requests of ${target.repository}`,
    );
  }
  return Number(match[3]);
});

const agentEntry = (entry: HoustonMergeQueueEntry): HoustonMergeQueueAgentEntry => ({
  number: entry.number,
  title: entry.title,
  url: entry.url,
  headRef: entry.headRef,
  headSha: entry.headSha,
  baseRef: entry.baseRef,
  dependsOn: entry.dependsOn,
  ownerThreadId: entry.ownerThreadId,
  position: entry.position,
  status: entry.status,
  reason: entry.reason,
  gates: entry.gates,
  failure:
    entry.failure === null ? null : { kind: entry.failure.kind, message: entry.failure.message },
});

export const layer = McpToolAccess.toLayer(HoustonMergeQueueToolkit, {
  houston_merge_queue_enqueue: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_merge_queue_enqueue";
      const agent = yield* callerOf(tool, "writes");
      const number = yield* ownNumber(tool, agent.projectId, input.pullRequest);
      const entry = yield* (yield* HoustonMergeQueueService).enqueue(
        {
          projectId: agent.projectId,
          pullRequest: number,
          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
        },
        agent.threadId,
      );
      return { untrusted, entry: agentEntry(entry) };
    }).pipe(labelled),
  ),
  houston_merge_queue_dequeue: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_merge_queue_dequeue";
      const agent = yield* callerOf(tool, "writes");
      const number = yield* ownNumber(tool, agent.projectId, input.pullRequest);
      return yield* (yield* HoustonMergeQueueService).dequeue({
        projectId: agent.projectId,
        number,
      });
    }).pipe(labelled),
  ),
  houston_merge_queue_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const agent = yield* callerOf("houston_merge_queue_status", "reads");
      const snapshot = yield* (yield* HoustonMergeQueueService).get({ projectId: agent.projectId });
      return { untrusted, message: snapshot.message, entries: snapshot.entries.map(agentEntry) };
    }).pipe(labelled),
  ),
});
