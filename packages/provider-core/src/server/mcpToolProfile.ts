/** Which of Houston's MCP tools a session advertises. Tool text is the same in every profile. */
export const MCP_TOOL_PROFILES = ["full", "lean"] as const;
export type McpToolProfile = (typeof MCP_TOOL_PROFILES)[number];

/**
 * Tools a lean session advertises: orchestration, threads, projects, worktrees, secrets and
 * scheduling, which the always-on instructions name. Device, preview, HTML, pull request,
 * attachment and queue tools are left out, not deferred. An allowlist, so a new tool stays out of
 * lean until someone weighs its schema cost here.
 */
export const LEAN_MCP_TOOL_NAMES: ReadonlyArray<string> = [
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "request_secret",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "create_threads",
  "houston_thread_launch",
  "houston_thread_list",
  "houston_thread_read",
  "houston_thread_update",
  "houston_thread_send",
  "houston_thread_wait",
  "houston_thread_interrupt",
  "houston_thread_search",
  "houston_thread_configure",
  "houston_thread_organize",
  "houston_pending_request",
  "houston_environment_links",
  "houston_environment_link",
  "houston_environment_unlink",
  "houston_project_list",
  "houston_project_read",
  "houston_project_create",
  "houston_project_update",
  "houston_project_delete",
  "houston_project_clone",
  "houston_worktree_handoff",
  "houston_worktree_status",
  "houston_worktree_list",
];

const LEAN = new Set(LEAN_MCP_TOOL_NAMES);

export const isMcpToolInProfile = (name: string, profile: McpToolProfile) =>
  profile === "full" || LEAN.has(name);

export const toolsForMcpProfile = <T extends { readonly name: string }>(
  tools: ReadonlyArray<T>,
  profile: McpToolProfile,
) => tools.filter((tool) => isMcpToolInProfile(tool.name, profile));

/** UTF-8 bytes of the fields a model sees for a profile's tools; protocol metadata is excluded. */
export const mcpToolListJsonBytes = (
  tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema?: unknown;
  }>,
  profile: McpToolProfile,
) =>
  new TextEncoder().encode(
    JSON.stringify(
      toolsForMcpProfile(tools, profile).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    ),
  ).length;
