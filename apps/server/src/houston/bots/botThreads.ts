// Which bot run's rules a thread runs under. The runtime policy asks this on every turn.
import type { OrchestrationV2AppThread, RuntimeMode, ThreadId } from "@houston-app/contracts";
import type {
  HoustonBotProviderPolicy,
  HoustonBotRunPolicy,
} from "@houston-app/contracts/houston/bots";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpBotCaller } from "../../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { botRunPolicyOfThread, PolicyJson, type BotRunPolicyRow } from "./botRuns.ts";
import { policyFor } from "./kinds.ts";
import { botSystemAppend } from "./openingBlock.ts";

/** Delegation links followed up to the bot thread; deeper work fails instead of guessing. */
export const BOT_THREAD_WALK_LIMIT = 8;

const RESULT_TOOL = "houston_bot_result";
const UNNAMED_BOT = "This bot";

export class HoustonBotThreadLookupError extends Schema.TaggedError<HoustonBotThreadLookupError>()(
  "HoustonBotThreadLookupError",
  {
    threadId: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail ?? "Houston could not read whether this thread is a bot's.";
  }
}

export type BotThreadRead = Pick<OrchestrationV2AppThread, "id" | "lineage" | "houstonBot">;

export interface BotThreadPolicy {
  /** Empty for a marked thread whose bot run this build cannot find. */
  readonly botRunId: string;
  /** The mode the kind fixes, which the runtime policy applies before its ceiling. */
  readonly runtimeMode?: RuntimeMode;
  readonly provider: HoustonBotProviderPolicy;
}

export interface HoustonBotThreadsShape {
  readonly policyOf: (
    thread: BotThreadRead,
  ) => Effect.Effect<BotThreadPolicy | undefined, HoustonBotThreadLookupError>;
}

/** No default layer: an assembly that leaves it out fails to build instead of running bot threads
 * without their rules. */
export class HoustonBotThreads extends Context.Service<HoustonBotThreads, HoustonBotThreadsShape>()(
  "@houston-app/cli/houston/bots/botThreads/HoustonBotThreads",
) {}

/** For assemblies without bots, such as upstream's tests: no thread is a bot's. */
export const layerNoBotThreads = Layer.succeed(HoustonBotThreads, {
  policyOf: Effect.fn("HoustonBotThreads.none")(() =>
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - the shape returns undefined, not void.
    Effect.succeed(undefined),
  ),
});

const decodePolicy = Schema.decodeUnknownOption(PolicyJson);

/** The narrowest reading: anything this build cannot read is the unattended kind, in Auto. */
const UNREADABLE = policyFor({
  kind: "unattended",
  bot: { askedMode: "auto", unattendedFullAccess: false, maxMinutes: 20 },
});

const storedPolicy = (row: BotRunPolicyRow | undefined): HoustonBotRunPolicy => {
  if (row === undefined || (row.kind !== "asked" && row.kind !== "unattended")) return UNREADABLE;
  const decoded = decodePolicy(row.policy_json);
  return Option.isSome(decoded) && decoded.value.kind === row.kind ? decoded.value : UNREADABLE;
};

/** The bot thread itself, while its bot exists, is told who it is; a child does only the work. */
const appendOf = (row: BotRunPolicyRow | undefined, child: boolean) =>
  child || row === undefined || row.instructions === null || row.job === null
    ? undefined
    : botSystemAppend({
        name: row.bot_name,
        job: row.job,
        revisionN: row.revision_n,
        instructions: row.instructions,
      });

const applied = (
  policy: HoustonBotRunPolicy,
  botRunId: string,
  botName: string,
  child: boolean,
  instructionsAppend: string | undefined,
): BotThreadPolicy => {
  const { houstonTools } = policy.rules;
  const provider: HoustonBotProviderPolicy = {
    botName,
    kind: policy.kind,
    child,
    // A child hands back nothing itself: the bot thread above it does.
    refusedTools:
      child && houstonTools === undefined
        ? [...policy.refusedTools, `mcp__houston__${RESULT_TOOL}`]
        : policy.refusedTools,
    rules:
      child && houstonTools !== undefined
        ? { ...policy.rules, houstonTools: houstonTools.filter((name) => name !== RESULT_TOOL) }
        : policy.rules,
    neverAsk: policy.neverAsk,
    ...(instructionsAppend === undefined ? {} : { instructionsAppend }),
  };
  return policy.runtimeMode === undefined
    ? { botRunId, provider }
    : { botRunId, runtimeMode: policy.runtimeMode, provider };
};

const HOUSTON_TOOL_PREFIX = "mcp__houston__";

/** What the thread's Houston credential carries: the Houston tools the stored rules allow. */
export const mcpBotCallerOf = ({ botRunId, provider }: BotThreadPolicy): McpBotCaller => ({
  kind: provider.kind,
  child: provider.child,
  botRunId,
  botName: provider.botName,
  tools:
    provider.rules.houstonTools === undefined
      ? {
          deny: provider.refusedTools
            .filter((name) => name.startsWith(HOUSTON_TOOL_PREFIX))
            .map((name) => name.slice(HOUSTON_TOOL_PREFIX.length)),
        }
      : { allow: provider.rules.houstonTools },
});

export function makeBotThreads(input: {
  readonly sql: SqlClient.SqlClient;
  /** Undefined when the thread does not exist. */
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<BotThreadRead | undefined, ProjectionStore.ProjectionStoreV2Error>;
}): HoustonBotThreadsShape {
  return {
    policyOf: Effect.fn("HoustonBotThreads.policyOf")(function* (start: BotThreadRead) {
      const failed = (cause: unknown) =>
        new HoustonBotThreadLookupError({ threadId: start.id, cause });
      let current: BotThreadRead = start;
      for (let steps = 0; ; steps += 1) {
        const row = yield* botRunPolicyOfThread(input.sql, current.id).pipe(
          Effect.mapError(failed),
        );
        if (row !== undefined || current.houstonBot !== undefined) {
          return applied(
            storedPolicy(row),
            row?.id ?? current.houstonBot?.botRunId ?? "",
            row?.bot_name ?? UNNAMED_BOT,
            steps > 0,
            appendOf(row, steps > 0),
          );
        }
        // Only delegation carries a bot's rules down; a fork or a side chat is the owner's own.
        const parentId = current.lineage.parentThreadId;
        if (current.lineage.relationshipToParent !== "subagent" || parentId === null) {
          return undefined;
        }
        if (steps === BOT_THREAD_WALK_LIMIT) {
          return yield* new HoustonBotThreadLookupError({
            threadId: start.id,
            detail: `This thread is more than ${BOT_THREAD_WALK_LIMIT} delegations below the thread that started it, so Houston cannot tell whether it is a bot's.`,
          });
        }
        const parent = yield* input.readThread(parentId).pipe(Effect.mapError(failed));
        if (parent === undefined) return undefined;
        current = parent;
      }
    }),
  };
}

export const layer = Layer.effect(
  HoustonBotThreads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return makeBotThreads({
      sql,
      readThread: (threadId) =>
        projections.getThread(threadId).pipe(
          Effect.map((thread): BotThreadRead | undefined => thread),
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () =>
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - a missing thread is undefined.
              Effect.succeed(undefined),
          }),
        ),
    });
  }),
).pipe(Layer.provide(ProjectionStore.layer));
