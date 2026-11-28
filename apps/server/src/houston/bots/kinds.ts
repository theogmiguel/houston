// The only place a kind of bot run becomes rules. The result is stored with the bot run.
import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";
import type {
  HoustonBot,
  HoustonBotRunKind,
  HoustonBotRunPolicy,
} from "@houston-app/contracts/houston/bots";

/** The provider's own timers: nothing a bot run starts may outlive it or wake it later. */
const TIMER_TOOLS = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger"];

export const REFUSED_HOUSTON_TOOLS = [
  "schedule_task",
  "delete_scheduled_task",
  "run_scheduled_task_now",
] as const;

/** Built-in tools an unattended bot run may call, by name; any other, a later one too, is refused. */
export const UNATTENDED_BUILTIN_TOOLS: ReadonlyArray<string> = [
  "Bash",
  "PowerShell",
  "TaskStop",
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LSP",
  "Skill",
  "TodoWrite",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "WaitForMcpServers",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
];

/** Houston tools an unattended bot run may call; only reads, and the result tool. */
export const UNATTENDED_HOUSTON_TOOLS: ReadonlyArray<string> = [
  "houston_bot_result",
  "houston_environment_read",
  "houston_project_list",
  "houston_project_read",
  "houston_thread_list",
  "houston_thread_read",
  "houston_thread_search",
  "houston_task_list",
  "houston_task_get",
  "list_issues",
  "read_issue",
  "list_thread_issues",
  "list_thread_pull_requests",
];

const houstonToolName = (name: string) => `mcp__houston__${name}`;

const REFUSED_IN_EVERY_KIND = [...TIMER_TOOLS, ...REFUSED_HOUSTON_TOOLS.map(houstonToolName)];

/** `Task` is the older name of `Agent`, which the SDK's list no longer carries. */
const UNATTENDED_REFUSED = [
  ...new Set([
    ...BUILTIN_TOOL_NAMES.filter((name) => !UNATTENDED_BUILTIN_TOOLS.includes(name)),
    "Task",
    ...REFUSED_IN_EVERY_KIND,
  ]),
];

export function policyFor(input: {
  readonly kind: HoustonBotRunKind;
  readonly bot: Pick<HoustonBot, "askedMode" | "unattendedFullAccess" | "maxMinutes">;
}): HoustonBotRunPolicy {
  switch (input.kind) {
    case "asked":
      return {
        kind: "asked",
        refusedTools: REFUSED_IN_EVERY_KIND,
        rules: { connectorTools: "all", gh: "any" },
        neverAsk: false,
      };
    case "unattended":
      return {
        kind: "unattended",
        runtimeMode: input.bot.unattendedFullAccess ? "full-access" : "auto",
        refusedTools: UNATTENDED_REFUSED,
        rules: {
          builtinTools: [...UNATTENDED_BUILTIN_TOOLS],
          connectorTools: "reads",
          houstonTools: [...UNATTENDED_HOUSTON_TOOLS],
          gh: "reads",
        },
        neverAsk: true,
        maxMinutes: input.bot.maxMinutes,
      };
  }
}
