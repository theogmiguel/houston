/**
 * A fixture of Houston's MCP tool surface for the local-model evals. It mirrors the names,
 * descriptions and required arguments the server advertises, so a captured harness template can
 * be replayed without loading the whole server. Update it when a tool this eval uses changes.
 */
import {
  toolsForMcpProfile,
  type McpToolProfile,
} from "@houston-app/provider-core/server/mcpToolProfile";

export interface EvalTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

const object = (
  properties: Readonly<Record<string, unknown>>,
  required: ReadonlyArray<string> = [],
) => ({ type: "object", properties, required, additionalProperties: false });

const string = (description: string) => ({ type: "string", description });

const TOOLS: ReadonlyArray<EvalTool> = [
  {
    name: "orchestrator_capabilities",
    description: "List the providers, models and settings this thread can delegate to.",
    input_schema: object({}),
  },
  {
    name: "delegate_task",
    description: "Start one child agent with a self-contained task.",
    input_schema: object(
      {
        task: string("The brief the child receives. It carries no parent history."),
        title: string("A short title for the child thread."),
        role: { type: "string", enum: ["implementation", "research", "review", "design", "test"] },
      },
      ["task"],
    ),
  },
  {
    name: "task_status",
    description: "Read one delegated task's state and result.",
    input_schema: object({ taskId: string("The id returned by delegate_task.") }, ["taskId"]),
  },
  {
    name: "houston_thread_search",
    description: "Search this environment's threads by title, branch, project or message text.",
    input_schema: object({ query: string("Text to look for.") }, ["query"]),
  },
  {
    name: "houston_thread_read",
    description: "Read a thread's messages or recent activity.",
    input_schema: object(
      {
        threadId: string("The thread to read."),
        view: { type: "string", enum: ["messages", "activity"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["threadId"],
    ),
  },
  {
    name: "houston_thread_wait",
    description: "Wait for a thread's running turn to finish.",
    input_schema: object({ threadId: string("The thread to wait for.") }, ["threadId"]),
  },
  {
    name: "houston_project_list",
    description: "List the environment's projects.",
    input_schema: object({}),
  },
  {
    name: "houston_worktree_list",
    description: "List branch refs and checkout paths for a workspace.",
    input_schema: object({ query: string("Filter by branch or path.") }),
  },
  {
    name: "request_secret",
    description: "Ask the user for a secret in a private card, never in chat.",
    input_schema: object(
      { label: string("What the secret is for."), reason: string("Why it is needed.") },
      ["label", "reason"],
    ),
  },
];

export const HOUSTON_MCP_PREFIX = "mcp__houston__";

/** Houston tools a session lists, in the runner's Anthropic-shaped form. */
export const visibleT3Tools = (options: {
  readonly subagent?: boolean;
  readonly links?: boolean;
  readonly forge?: boolean;
  readonly profile?: McpToolProfile;
}): ReadonlyArray<EvalTool & { readonly name: string }> =>
  TOOLS.filter(
    (tool) => toolsForMcpProfile([{ name: tool.name }], options.profile ?? "full").length === 1,
  ).map((tool) => ({
    ...tool,
    name: `${HOUSTON_MCP_PREFIX}${tool.name}`,
  }));
