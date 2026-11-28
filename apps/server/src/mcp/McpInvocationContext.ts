import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@houston-app/contracts";
import type { HoustonBotRunKind } from "@houston-app/contracts/houston/bots";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { formatThreadLink } from "@houston-app/shared/threadLinks";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
  "issues",
  // Houston: a task's planner or reviewer, which may call only its submit tool.
  "houston-task-submit",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** A delegated child task; its parent owns the work it hands back. */
  readonly subagent?: boolean;
  /** Houston: the bot run this thread works for, which fixes the Houston tools it may call. */
  readonly bot?: McpBotCaller;
}

/** Houston tools a credential may call: only the listed ones, or every one but them. */
export type McpToolScope =
  | { readonly allow: ReadonlyArray<string> }
  | { readonly deny: ReadonlyArray<string> };

export interface McpBotCaller {
  readonly kind: HoustonBotRunKind;
  readonly child: boolean;
  readonly botRunId: string;
  readonly botName: string;
  readonly tools: McpToolScope;
}

/** Houston: the only tools a task's planner or reviewer credential may call. */
export const HOUSTON_TASK_SUBMIT_TOOLS: ReadonlyArray<string> = [
  "houston_task_plan_submit",
  "houston_task_review_submit",
];

export const toolScopeOf = (scope: McpInvocationScope): McpToolScope | undefined =>
  scope.capabilities.has("houston-task-submit")
    ? { allow: HOUSTON_TASK_SUBMIT_TOOLS }
    : scope.thread?.bot?.tools;

const inToolScope = (tools: McpToolScope | undefined, name: string): boolean =>
  tools === undefined ||
  ("allow" in tools ? tools.allow.includes(name) : !tools.deny.includes(name));

const sameNames = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((name, index) => name === b[index]);

/** Whether a credential issued for `a` may stand in for one issued now for `b`. */
export const sameBotCaller = (a: McpBotCaller | undefined, b: McpBotCaller | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.kind === b.kind &&
      a.child === b.child &&
      a.botRunId === b.botRunId &&
      a.botName === b.botName &&
      ("allow" in a.tools
        ? "allow" in b.tools && sameNames(a.tools.allow, b.tools.allow)
        : "deny" in b.tools && sameNames(a.tools.deny, b.tools.deny));

const otherEnvironmentOf = (scope: McpInvocationScope, args: unknown): boolean => {
  const named = args as
    | { readonly environmentId?: unknown; readonly target?: { readonly environmentId?: unknown } }
    | undefined;
  return [named?.environmentId, named?.target?.environmentId].some(
    (environmentId) => environmentId !== undefined && environmentId !== scope.environmentId,
  );
};

/**
 * Why a call is refused by the credential's tool scope, or undefined. A bot thread also acts on
 * this machine only: no bot record would exist on another.
 */
export const toolScopeRefusal = (
  scope: McpInvocationScope,
  tool: string,
  args: unknown,
): string | undefined => {
  if (scope.capabilities.has("houston-task-submit")) {
    return inToolScope(toolScopeOf(scope), tool)
      ? undefined
      : `capability_denied: thread ${scope.thread?.threadId ?? "unknown"} plans or reviews a Houston task, so its credential may call only ${HOUSTON_TASK_SUBMIT_TOOLS.join(" and ")}, not ${tool}.`;
  }
  const bot = scope.thread?.bot;
  if (bot === undefined) return undefined;
  if (!inToolScope(bot.tools, tool))
    return `Houston's ${tool} is not available in this bot thread.`;
  return otherEnvironmentOf(scope, args) ? `${bot.botName} works on this machine only.` : undefined;
};

/** `McpSchema.EnabledWhen` beside a tool's own: a bot thread lists only the tools it may call. */
export const listedForBots = (tool: string) => (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return inToolScope(scope?.thread?.bot?.tools, tool);
};

export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  /**
   * Another Houston environment's peer link. What it starts here carries its
   * session as `linkOrigin`, and it changes only that work (`linkOrigin.ts`).
   */
  readonly linked?: boolean | undefined;
  /**
   * Narrower modes the client asked for on this request (`Houston-Mode-Limit`):
   * another environment passing on the limits of the agent it calls for.
   */
  readonly narrowedTo?: ClientModes | undefined;
  /** The origin an outside client reached; its thread links open the web app there. */
  readonly webOrigin?: string | undefined;
}

/**
 * `Houston-Mode-Limit: <runtimeMode>/<interactionMode>` lets an OAuth client cap
 * a request below what it was approved with: another environment passes on
 * the limits of the agent it calls for. It can only narrow (see
 * `clientModeCeiling`), so a client gains nothing by sending a broad one.
 */
export const MODE_LIMIT_HEADER = "houston-mode-limit";

export interface ClientModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const interactionModeRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

/**
 * The modes a client caller's writes are capped at: what it was approved
 * with, narrowed by what it asked for on this request. A read-only client
 * never reaches a write (`McpToolAccess` refuses it first), so it maps to the
 * lowest runtime mode rather than to nothing.
 */
export const clientModeCeiling = (client: McpClientCaller | undefined): ClientModes => {
  const approved: ClientModes = {
    runtimeMode:
      client === undefined || client.access === "read-only" ? "approval-required" : client.access,
    interactionMode: "default",
  };
  const asked = client?.narrowedTo;
  if (asked === undefined) return approved;
  return {
    runtimeMode:
      runtimeModeRank[asked.runtimeMode] < runtimeModeRank[approved.runtimeMode]
        ? asked.runtimeMode
        : approved.runtimeMode,
    interactionMode:
      interactionModeRank[asked.interactionMode] < interactionModeRank[approved.interactionMode]
        ? asked.interactionMode
        : approved.interactionMode,
  };
};

/**
 * A client approved above an administrator's runtime-mode ceiling acts as if it had narrowed
 * itself to the ceiling, so what it starts and schedules is not refused for a mode it never chose.
 */
export const withRuntimeModeCeiling = (
  scope: McpInvocationScope,
  ceiling: RuntimeMode | undefined,
): McpInvocationScope => {
  if (ceiling === undefined || scope.client === undefined) return scope;
  const asked = scope.client.narrowedTo;
  return {
    ...scope,
    client: {
      ...scope.client,
      narrowedTo: {
        runtimeMode:
          asked !== undefined && runtimeModeRank[asked.runtimeMode] < runtimeModeRank[ceiling]
            ? asked.runtimeMode
            : ceiling,
        interactionMode: asked?.interactionMode ?? "default",
      },
    },
  };
};

/** Thread callers default to their own thread; client callers need thread for tools that act as the caller. */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly requestNamespace: string;
  readonly thread: McpThreadCaller | undefined;
  readonly client: McpClientCaller | undefined;
  /** False while the Linked environments beta is off here; `/mcp` reads it per request. */
  readonly linkedEnvironments?: boolean;
}

/**
 * Houston renders `houston-thread://` links as thread chips. Other MCP clients cannot open them, so
 * they get a web URL on the origin they reached instead.
 */
export const threadLinkFor = (
  scope: Pick<McpInvocationScope, "environmentId" | "client">,
  threadId: ThreadId,
): string => {
  const origin = scope.client?.webOrigin;
  return origin === undefined
    ? formatThreadLink({ environmentId: scope.environmentId, threadId })
    : `${origin}/${encodeURIComponent(scope.environmentId)}/${encodeURIComponent(threadId)}`;
};

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("@houston-app/cli/mcp/McpInvocationContext") {}

/**
 * `McpSchema.EnabledWhen` for tools a delegated child must not see or call.
 * EnabledWhen only receives the MCP client profile, so read the Houston caller from the request fiber.
 */
export const hiddenFromSubagents = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.thread?.subagent !== true;
};

/** `McpSchema.EnabledWhen` for tools only a linked environment's own session may see or call. */
export const hiddenUnlessLinkedSession = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.client?.linked === true;
};

/** `McpSchema.EnabledWhen` for tools that only serve links, hidden while the beta is off. */
export const hiddenWhileLinksOff = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.linkedEnvironments !== false;
};

export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    ...(invocation.thread === undefined
      ? {}
      : {
          threadId: invocation.thread.threadId,
          providerSessionId: invocation.thread.providerSessionId,
          providerInstanceId: invocation.thread.providerInstanceId,
        }),
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

export const requireThreadMcpCapability = <const C extends "preview" | "device">(
  capability: C,
): Effect.Effect<McpThreadInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        invocation.capabilities.has(capability) && invocation.thread !== undefined,
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling Houston thread, so it needs an agent running inside Houston. This MCP client signed in from outside a thread.`,
  });

export type McpThreadInvocationScope = McpInvocationScope & { readonly thread: McpThreadCaller };

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);
