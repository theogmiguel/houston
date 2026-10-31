// Every call checks the caller's project access first; writes then stay in that project or on
// unassigned tasks, and starting work needs a caller that may delegate.
import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import {
  type HoustonTaskDetail,
  type HoustonTaskPatch,
  type HoustonTaskSummary,
} from "@t3tools/contracts/houston/tasks";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../../../mcp/delegatedTaskModes.ts";
import { type CallerLimits, loadCaller } from "../../../mcp/threadAccess.ts";
import { compareReady, refuse } from "../rules.ts";
import { HoustonTaskRuns, type HoustonTaskAgent } from "../TaskRuns.ts";
import { HoustonTaskService } from "../TaskService.ts";
import {
  HOUSTON_TASK_TOOL_COMMENTS,
  HOUSTON_TASK_TOOL_TEXT_BYTES,
  HOUSTON_TASK_UNTRUSTED_LABEL,
  HoustonTaskToolkit,
} from "./tools.ts";

const ACCESS_SETTING = "Settings ▸ Tasks ▸ Agent access";
const SUBMIT_TOOLS: ReadonlySet<string> = new Set([
  "houston_task_plan_submit",
  "houston_task_review_submit",
]);
const LIST_LIMIT = 20;

const untrusted: typeof HOUSTON_TASK_UNTRUSTED_LABEL = HOUSTON_TASK_UNTRUSTED_LABEL;

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** Cuts one string at the byte cap, naming the cap and the full size. */
const capText = (text: string): string => {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= HOUSTON_TASK_TOOL_TEXT_BYTES) return text;
  const cut = Buffer.from(text, "utf8")
    .subarray(0, HOUSTON_TASK_TOOL_TEXT_BYTES)
    .toString("utf8")
    .replace(/�+$/, "");
  return `${cut}\n… [cut at ${HOUSTON_TASK_TOOL_TEXT_BYTES} bytes; the full text is ${bytes} bytes]`;
};

/** Every text field of a result, however deep, capped. */
const capped = <A>(value: A): A => {
  if (typeof value === "string") return capText(value) as A;
  if (Array.isArray(value)) return value.map(capped) as A;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, capped(field)]),
    ) as A;
  }
  return value;
};

type Mode = "read" | "write" | "delegate";

/** The calling thread as an agent, after its capability and project access are checked. */
const agentFor = Effect.fn("HoustonTaskToolkit.agentFor")(function* (tool: string, mode: Mode) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadScope = yield* McpInvocationContext.requireThreadScope(scope, tool);
  const { caller } = yield* loadCaller();
  const threadId = threadScope.thread.threadId;
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  const runs = yield* HoustonTaskRuns;
  if (mode !== "read") {
    if (caller.side !== undefined) {
      return yield* denied(`thread ${threadId} is a side thread, which is read-only`);
    }
    if (!SUBMIT_TOOLS.has(tool)) {
      const refusal = yield* runs.agentWriteRefusal(threadId);
      if (refusal !== undefined) return yield* refusal;
    }
  }
  if (
    mode === "delegate" &&
    (!threadScope.capabilities.has("orchestration") || threadScope.thread.subagent === true)
  ) {
    return yield* denied(
      `${tool} starts work as your child, and thread ${threadId} may not delegate`,
    );
  }
  const projectId = caller.projectId;
  const agent = {
    threadId,
    projectId,
    actor: `agent:${threadId} (${caller.title})`,
    provider: threadScope.thread.providerInstanceId,
    limits: { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode },
  } satisfies HoustonTaskAgent & { readonly limits: CallerLimits };
  // A planner or reviewer the user started submits whatever the access: its credential is
  // already bound to its own task and round, and gating it would leave its session open.
  if (SUBMIT_TOOLS.has(tool)) return agent;
  const settings = yield* (yield* HoustonTaskService).getSettings({ projectId });
  if (settings.access === "off") {
    return yield* refuse(
      "access_off",
      tool,
      `agent access to tasks is off for project ${projectId} (${ACCESS_SETTING})`,
    );
  }
  if (mode !== "read" && settings.access === "read") {
    return yield* refuse(
      "read_only",
      tool,
      `${ACCESS_SETTING} is read for project ${projectId}, so agents may only read tasks`,
    );
  }
  return agent;
});

const otherWorkspace = (tool: string, what: string, projectId: string) =>
  refuse(
    "read_only",
    tool,
    `${what} belongs to project ${projectId}; tasks of another workspace are read-only to agents`,
  );

/** The task, when it is the agent's to write: its own project's or unassigned. */
const ownTask = Effect.fn("HoustonTaskToolkit.ownTask")(function* (
  tool: string,
  agent: HoustonTaskAgent,
  id: string,
) {
  const detail = yield* (yield* HoustonTaskService).get({ id });
  const projectId = detail.task.projectId;
  if (projectId !== null && projectId !== agent.projectId) {
    return yield* otherWorkspace(tool, detail.task.key, projectId);
  }
  return detail;
});

/** Refuses moving a task into another project and a status only the user sets. */
const checkPatch = (
  tool: string,
  agent: HoustonTaskAgent,
  patch: {
    readonly status?: string | undefined;
    readonly projectId?: ProjectId | null | undefined;
  },
) => {
  if (patch.status === "done") {
    return Effect.fail(
      refuse("invalid", tool, "agents cannot set status done; hand the task back for review"),
    );
  }
  if (
    patch.projectId !== undefined &&
    patch.projectId !== null &&
    patch.projectId !== agent.projectId
  ) {
    return Effect.fail(otherWorkspace(tool, "the task", patch.projectId));
  }
  return Effect.void;
};

const toPatch = Effect.fn("HoustonTaskToolkit.toPatch")(function* (input: {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly status?: HoustonTaskPatch["status"] | undefined;
  readonly priority?: HoustonTaskPatch["priority"] | undefined;
  readonly projectId?: ProjectId | null | undefined;
  readonly parent?: string | null | undefined;
  readonly refUrl?: string | null | undefined;
  readonly acceptance?: ReadonlyArray<string> | undefined;
}) {
  const parentId =
    input.parent === undefined || input.parent === null
      ? input.parent
      : (yield* (yield* HoustonTaskService).get({ id: input.parent })).task.id;
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(input.refUrl === undefined ? {} : { refUrl: input.refUrl }),
    ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
  } satisfies HoustonTaskPatch;
});

/** The backlog's first snapshot, unarchived tasks only. */
const unarchived = Effect.gen(function* () {
  const [first] = yield* (yield* HoustonTaskService)
    .subscribe({ scope: "all" })
    .pipe(Stream.take(1), Stream.runCollect);
  const tasks = first !== undefined && "snapshot" in first ? first.snapshot.tasks : [];
  return tasks.filter((summary) => summary.archivedAt === null);
});

const isReady = (summary: HoustonTaskSummary) => summary.status === "todo" && summary.ready;

const detailResult = (detail: HoustonTaskDetail) => ({ untrusted, detail: capped(detail) });

export const layer = McpToolAccess.toLayer(HoustonTaskToolkit, {
  houston_task_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const agent = yield* agentFor("houston_task_list", "read");
      const query = input.query?.trim().toLowerCase();
      const mine = `agent:${agent.threadId} `;
      const tasks = (yield* unarchived)
        .filter(
          (summary) =>
            (input.status === undefined || summary.status === input.status) &&
            (input.ready !== true || isReady(summary)) &&
            (query === undefined ||
              query.length === 0 ||
              summary.key.toLowerCase().includes(query) ||
              summary.title.toLowerCase().includes(query)) &&
            (input.mine !== true ||
              summary.createdBy.startsWith(mine) ||
              summary.openRun?.threadId === agent.threadId),
        )
        .sort((left, right) => right.number - left.number);
      return {
        untrusted,
        tasks: capped(tasks.slice(0, input.limit ?? LIST_LIMIT)),
        total: tasks.length,
      };
    }),
  ),
  houston_task_get: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* agentFor("houston_task_get", "read");
      const detail = yield* (yield* HoustonTaskService).get({ id: input.id });
      return capped({
        untrusted,
        task: detail.task,
        acceptance: detail.acceptance,
        comments: detail.comments.slice(-HOUSTON_TASK_TOOL_COMMENTS),
        commentsTotal: detail.comments.length,
        runs: detail.runs,
        domain: detail.domain,
      });
    }),
  ),
  houston_task_next: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* agentFor("houston_task_next", "read");
      const [next] = (yield* unarchived).filter(isReady).sort(compareReady);
      return { untrusted, task: next === undefined ? null : capped(next) };
    }),
  ),
  houston_task_create: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_task_create";
      const agent = yield* agentFor(tool, "write");
      yield* checkPatch(tool, agent, input);
      const patch = yield* toPatch({ projectId: agent.projectId, ...input });
      const task = yield* (yield* HoustonTaskService).save({ patch }, agent.actor);
      return { untrusted, task: capped(task) };
    }),
  ),
  houston_task_update: McpToolAccess.writesWithCapability(({ id, expectedRevision, ...input }) =>
    Effect.gen(function* () {
      const tool = "houston_task_update";
      const agent = yield* agentFor(tool, "write");
      yield* ownTask(tool, agent, id);
      yield* checkPatch(tool, agent, input);
      const patch = yield* toPatch(input);
      const task = yield* (yield* HoustonTaskService).save(
        { id, expectedRevision, patch },
        agent.actor,
      );
      return { untrusted, task: capped(task) };
    }),
  ),
  houston_task_comment: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_task_comment";
      const agent = yield* agentFor(tool, "write");
      yield* ownTask(tool, agent, input.id);
      const task = yield* (yield* HoustonTaskService).comment(input, agent.actor);
      return { untrusted, task: capped(task) };
    }),
  ),
  houston_task_check: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_task_check";
      const agent = yield* agentFor(tool, "write");
      yield* ownTask(tool, agent, input.id);
      const task = yield* (yield* HoustonTaskService).check(
        { id: input.id, item: input.item, checked: input.checked ?? true },
        agent.actor,
      );
      return { untrusted, task: capped(task) };
    }),
  ),
  houston_task_claim: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_task_claim";
      const agent = yield* agentFor(tool, "write");
      yield* ownTask(tool, agent, input.id);
      const run = yield* (yield* HoustonTaskRuns).claim(agent, input);
      return { untrusted, run: capped(run) };
    }),
  ),
  houston_task_handback: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_task_handback";
      const agent = yield* agentFor(tool, "write");
      yield* ownTask(tool, agent, input.id);
      const run = yield* (yield* HoustonTaskRuns).agentHandback(agent, {
        id: input.id,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.result === undefined ? {} : { result: input.result }),
      });
      return { untrusted, run: capped(run) };
    }),
  ),
  houston_task_plan_submit: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const agent = yield* agentFor("houston_task_plan_submit", "write");
      return detailResult(yield* (yield* HoustonTaskRuns).planSubmit(agent.threadId, input));
    }),
  ),
  houston_task_review_submit: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const agent = yield* agentFor("houston_task_review_submit", "write");
      return detailResult(yield* (yield* HoustonTaskRuns).reviewSubmit(agent.threadId, input));
    }),
  ),
  houston_task_execute: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_task_execute";
      const agent = yield* agentFor(tool, "delegate");
      yield* ownTask(tool, agent, input.id);
      // The child runs unattended, so it never runs broader than the caller that started it.
      const modes = {
        runtimeMode: yield* resolveRuntimeMode(agent.limits.runtimeMode, input.runtimeMode),
        interactionMode: yield* resolveInteractionMode(
          agent.limits.interactionMode,
          input.interactionMode,
        ),
      };
      const run = yield* (yield* HoustonTaskRuns).execute(agent, {
        id: input.id,
        modes,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
      });
      return { untrusted, run: capped(run), threadId: run.threadId };
    }),
  ),
  houston_task_review: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_task_review";
      const agent = yield* agentFor(tool, "delegate");
      const runs = yield* HoustonTaskRuns;
      const task = yield* runs.taskOfRun(input.runId);
      yield* ownTask(tool, agent, task.key);
      const detail = yield* runs.reviewStart({
        runId: input.runId,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      });
      const review = detail.runs.find((run) => run.kind === "review");
      if (review === undefined) {
        return yield* refuse("invalid", tool, `no review run started for run ${input.runId}`);
      }
      return { untrusted, run: capped(review), threadId: review.threadId };
    }),
  ),
});
