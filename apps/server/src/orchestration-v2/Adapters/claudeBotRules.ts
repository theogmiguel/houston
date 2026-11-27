// Houston: how a bot thread's rules reach Claude Code. Two mechanisms refuse each call on their
// own (the refused names, and a blocking tool check), and a call that starts with no decision
// from the check stops the bot run.
import type { HookCallback, SDKMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { HoustonBotProviderPolicy } from "@houston-app/contracts/houston/bots";
import { parseCliArgs } from "@houston-app/shared/cliArgs";

import { decideToolCall } from "../../houston/bots/toolRules.ts";

export const NOBODY_WATCHING_MESSAGE =
  "Nobody is watching this bot run. Continue without this, or hand back a question.";

export const toolCheckDidNotRunMessage = (botName: string) =>
  `Houston's tool check did not run, so ${botName} was stopped.`;

export const botRulesChangedMessage = (botName: string) =>
  `${botName}'s rules changed; stop its background work first.`;

/** Launch arguments an unattended bot run may start Claude with; any other changes its rules. */
export const UNATTENDED_LAUNCH_FLAGS: ReadonlySet<string> = new Set([
  "add-dir",
  "model",
  "effort",
  "thinking-display",
  "verbose",
  "debug",
]);

/** Why this account cannot start this bot thread's query, or undefined when it can. */
export function claudeBotLaunchRefusal(input: {
  readonly policy: HoustonBotProviderPolicy;
  readonly account: string;
  readonly launchArgs: string | undefined;
  readonly sdkSettings: string | Settings | undefined;
}): string | undefined {
  if (input.policy.kind === "unattended") {
    const flags = Object.keys(parseCliArgs(input.launchArgs ?? "").flags);
    const refused = flags.find((flag) => !UNATTENDED_LAUNCH_FLAGS.has(flag));
    if (refused !== undefined) {
      return `${input.account} starts Claude with --${refused}, which changes what an unattended bot run may do. Remove it in Settings ▸ Providers, or choose another account for ${input.policy.botName}.`;
    }
  }
  // A settings file path takes no extra keys, so memory could not be turned off.
  if (typeof input.sdkSettings === "string") {
    return `${input.account} starts Claude with a settings file, so Houston cannot turn off its memory for ${input.policy.botName}. Remove it in Settings ▸ Providers, or choose another account.`;
  }
  return undefined;
}

/** What the agent SDK says when it refuses a query whose blocking check would not run. */
const TOOL_CHECK_UNSUPPORTED = [
  "does not honor onFailure on hook matchers",
  "did not register your hooks",
] as const;

/** A bot thread's query that Claude Code refused because it cannot run the blocking check, said
 * by name; undefined for any other failure. */
export function claudeBotToolCheckUnsupportedMessage(
  account: string,
  cause: unknown,
): string | undefined {
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const message = Reflect.get(current, "message");
    if (
      typeof message === "string" &&
      TOOL_CHECK_UNSUPPORTED.some((sentence) => message.includes(sentence))
    ) {
      return `${account} uses a version of Claude Code that cannot run Houston's tool check. Update it in Settings ▸ Providers.`;
    }
    current = Reflect.get(current, "cause");
  }
  return undefined;
}

/** Provider memory is off in every bot thread; merged last, so no other setting turns it on. */
export const withBotMemoryOff = (settings: Settings | undefined): Settings => ({
  ...settings,
  autoMemoryEnabled: false,
  autoDreamEnabled: false,
});

/** Tool-use ids the check decided. A frame can be read twice (held, then released), so an id is
 * kept until newer ones push it out; the bound is far above the calls one turn makes. */
export class ClaudeBotToolDecisions {
  private static readonly LIMIT = 16_384;
  private readonly ids = new Set<string>();

  record(toolUseId: string): void {
    if (this.ids.size >= ClaudeBotToolDecisions.LIMIT) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(toolUseId);
  }

  has(toolUseId: string): boolean {
    return this.ids.has(toolUseId);
  }
}

/** The blocking PreToolUse check of a bot thread, in the main thread and in subagents. */
export function makeClaudeBotToolCheck(
  policy: HoustonBotProviderPolicy,
  decisions: ClaudeBotToolDecisions,
): HookCallback {
  return (input) => {
    if (input.hook_event_name !== "PreToolUse") return Promise.resolve({});
    decisions.record(input.tool_use_id);
    const decision = decideToolCall({
      refusedTools: policy.refusedTools,
      rules: policy.rules,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      mcpServer: input.mcp_server,
    });
    return Promise.resolve(
      decision.allow
        ? {}
        : {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: decision.reason,
            },
          },
    );
  };
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part: unknown) =>
            typeof part === "object" && part !== null
              ? String(Reflect.get(part, "text") ?? "")
              : "",
          )
          .join("")
      : "";

/** Claude Code writes this error itself, without running anything, for an unknown tool or bad
 * input. The proof run pins the shapes. */
const CLAUDE_UNRUN_TOOL_ERROR = "<tool_use_error>";

/** The calls a frame shows to have started: progress, or a result Claude Code read back. */
export function claudeStartedToolCalls(
  message: SDKMessage,
): ReadonlyArray<{ readonly toolUseId: string; readonly unrun: boolean }> {
  if (message.type === "tool_progress") {
    return [{ toolUseId: message.tool_use_id, unrun: false }];
  }
  if (message.type !== "user" || typeof message.message.content === "string") return [];
  return message.message.content.flatMap((block: unknown) => {
    if (typeof block !== "object" || block === null) return [];
    const type = Reflect.get(block, "type");
    const toolUseId = Reflect.get(block, "tool_use_id");
    if ((type !== "tool_result" && type !== "mcp_tool_result") || typeof toolUseId !== "string") {
      return [];
    }
    const unrun =
      Reflect.get(block, "is_error") === true &&
      textOf(Reflect.get(block, "content")).trimStart().startsWith(CLAUDE_UNRUN_TOOL_ERROR);
    return [{ toolUseId, unrun }];
  });
}
