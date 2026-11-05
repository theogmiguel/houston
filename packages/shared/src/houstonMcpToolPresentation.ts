export type HoustonMcpToolLogo = "houston";

export interface HoustonMcpToolPresentation {
  readonly displayName: string;
  readonly logo: HoustonMcpToolLogo;
}

export type HoustonMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "background-wait"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-links"
  | "environment-link"
  | "environment-unlink"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render";

export interface HoustonMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "houston" | "browser" | "device" | "pull-request";
  readonly summaryAction: HoustonMcpToolSummaryAction;
}

function tool(
  labels: HoustonMcpToolDefinition["labels"],
  summaryAction: HoustonMcpToolSummaryAction,
  icon: HoustonMcpToolDefinition["icon"] = "houston",
  displayName = `${labels[0]} ${labels[3]}`,
): HoustonMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

// Codex registers "houston-direct" for Houston tools kept out of Code Mode.
const HOUSTON_MCP_SERVER_ALIASES = new Set([
  "houston",
  "houston_code",
  "houston-direct",
  "houston_direct",
]);

const HOUSTON_MCP_TOOLS: Readonly<Record<string, HoustonMcpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  link_pull_requests: tool(
    ["Link", "Linking", "Linked", "pull requests"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  unlink_pull_requests: tool(
    ["Unlink", "Unlinking", "Unlinked", "pull requests by state"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Unwatching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started writing", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(["Schedule", "Scheduling", "Scheduled", "a task"], "schedule-create"),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  create_threads: tool(["Create", "Creating", "Created", "Houston threads"], "thread-create"),
  houston_thread_start: tool(["Start", "Starting", "Started", "a Houston thread"], "thread-create"),
  houston_thread_list: tool(["List", "Listing", "Listed", "Houston threads"], "thread-list"),
  houston_thread_read: tool(["Read", "Reading", "Read", "a Houston thread"], "thread-read"),
  houston_thread_send: tool(["Send", "Sending", "Sent", "to a Houston thread"], "thread-send"),
  houston_thread_wait: tool(["Wait", "Waiting", "Waited", "for a Houston thread"], "thread-wait"),
  houston_workflow_stop: tool(
    ["Stop", "Stopping", "Requested a stop for", "a workflow"],
    "workflow-stop",
  ),
  houston_background_wait: tool(
    ["Update", "Updating", "Updated", "background waits"],
    "background-wait",
  ),
  houston_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a Houston thread"],
    "thread-interrupt",
  ),
  houston_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  houston_worktree_status: tool(
    ["Get", "Getting", "Got", "thread worktree status"],
    "worktree-status",
  ),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_act: tool(["Use", "Using", "Used", "the preview browser"], "browser", "browser"),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  houston_queue: tool(["Manage", "Managing", "Managed", "queued messages"], "queue-edit"),
  houston_pending_request: tool(
    ["Handle", "Handling", "Handled", "pending questions"],
    "question-respond",
  ),
  houston_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  houston_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  houston_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  houston_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  houston_queue_reorder: tool(
    ["Reorder", "Reordering", "Reordered", "a queued run"],
    "queue-reorder",
  ),
  houston_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  houston_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  houston_pending_request_read: tool(
    ["Read", "Reading", "Read", "pending questions"],
    "question-read",
  ),
  houston_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  houston_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  houston_thread_configure: tool(
    ["Use", "Using", "Used", "thread model settings"],
    "thread-configure",
  ),
  houston_thread_transfer: tool(["Use", "Using", "Used", "thread transfers"], "thread-fork"),
  houston_thread_fork: tool(
    ["Fork", "Forking", "Requested a fork of", "this thread"],
    "thread-fork",
  ),
  houston_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  houston_thread_search: tool(
    ["Search", "Searching", "Searched", "thread content"],
    "thread-search",
  ),
  houston_thread_transfers: tool(
    ["Read", "Reading", "Read", "thread transfers"],
    "thread-transfers",
  ),
  houston_thread_organize: tool(
    ["Organize", "Organizing", "Organized", "a thread"],
    "thread-organize",
  ),
  houston_thread_update: tool(
    ["Update", "Updating", "Updated", "Houston thread metadata"],
    "thread-update",
  ),
  houston_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  houston_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  houston_preview_close: tool(
    ["Close", "Closing", "Closed", "a preview tab"],
    "browser",
    "browser",
  ),
  houston_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  houston_environment_links: tool(
    ["List", "Listing", "Listed", "linked environments"],
    "environment-links",
  ),
  houston_environment_link: tool(
    ["Ask to link", "Asking to link", "Asked to link", "an environment"],
    "environment-link",
  ),
  houston_environment_unlink: tool(
    ["Forget", "Forgetting", "Forgot", "a linked environment"],
    "environment-unlink",
  ),
  houston_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  houston_thread_launch: tool(
    ["Launch", "Launching", "Launched", "a project thread"],
    "thread-create",
  ),
  houston_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  houston_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  houston_project_create: tool(
    ["Register", "Registering", "Registered", "a project"],
    "project-create",
  ),
  houston_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  houston_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  houston_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  houston_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  houston_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  houston_thread_send_attachments: tool(
    ["Send", "Sending", "Sent", "attachments"],
    "attachment-send",
  ),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
};

export const HOUSTON_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(HOUSTON_MCP_TOOLS));

function normalizeHoustonMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

// Timelines resolve every work row's tool name on each update; names repeat across updates.
// ACP titles can carry whole commands, so long labels are parsed but not kept.
const toolNameCache = new Map<string, string | null>();
const TOOL_NAME_CACHE_LIMIT = 10_000;
const TOOL_NAME_CACHE_MAX_KEY_LENGTH = 256;

function resolveHoustonMcpToolName(value: string): string | null {
  if (value.length > TOOL_NAME_CACHE_MAX_KEY_LENGTH) return parseHoustonMcpToolName(value);
  const cached = toolNameCache.get(value);
  if (cached !== undefined) return cached;
  const name = parseHoustonMcpToolName(value);
  if (toolNameCache.size >= TOOL_NAME_CACHE_LIMIT) toolNameCache.clear();
  toolNameCache.set(value, name);
  return name;
}

// ACP tool prefixes vary; match loosely but require a known display-name entry.
function parseHoustonMcpToolName(value: string): string | null {
  const label = normalizeHoustonMcpToolLabel(value);
  if (Object.hasOwn(HOUSTON_MCP_TOOLS, label)) return label;
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      HOUSTON_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch =
    /^(?<server>houston[-_]direct|houston|houston_code)(?:[.:/]|\s*·\s*|\s+)(?<tool>.+)$/i.exec(
      label,
    );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed =
    /^(?:mcp[-_]{1,2})?(?:houston[-_]direct|houston_code|houston)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(
      label,
    );
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(HOUSTON_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 thread prefixes can contain underscores; choose the longest known tool-name suffix.
  if (!/^houston-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(HOUSTON_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

export function resolveHoustonMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveHoustonMcpToolName(toolName);
  return name !== null && Object.hasOwn(HOUSTON_MCP_TOOLS, name) ? name : null;
}

type SummaryInput = Readonly<Record<string, unknown>>;

const asSummaryInput = (input: unknown): SummaryInput | undefined =>
  typeof input === "object" && input !== null ? (input as SummaryInput) : undefined;

/** Action tools present each call as the single-purpose tool its action replaced. */
const ACTION_TOOLS: Readonly<Record<string, (action: string) => string | undefined>> = {
  preview_act: (action) => `preview_${action}`,
  houston_queue: (action) => `houston_queue_${action}`,
  houston_pending_request: (action) => `houston_pending_request_${action}`,
  houston_thread_transfer: (action) =>
    ({
      fork: "houston_thread_fork",
      merge_back: "houston_thread_merge_back",
      status: "houston_thread_transfers",
    })[action],
};

/** Pass the call's input so an action tool resolves to the labels and summary of its action. */
export function resolveHoustonMcpToolDefinition(
  toolName: string | null | undefined,
  input?: unknown,
): HoustonMcpToolDefinition | null {
  const name = toolName == null ? null : resolveHoustonMcpToolName(toolName);
  if (name === null || !Object.hasOwn(HOUSTON_MCP_TOOLS, name)) return null;
  const action = asSummaryInput(input)?.action;
  const actionTool = typeof action === "string" ? ACTION_TOOLS[name]?.(action) : undefined;
  return actionTool !== undefined && Object.hasOwn(HOUSTON_MCP_TOOLS, actionTool)
    ? HOUSTON_MCP_TOOLS[actionTool]!
    : HOUSTON_MCP_TOOLS[name]!;
}

/** Tools whose summary depends on which fields a call sets. */
const ACTION_SUMMARIES: Readonly<
  Record<string, (input: SummaryInput) => HoustonMcpToolSummaryAction | undefined>
> = {
  houston_thread_configure: ({ modelSelection }) =>
    modelSelection === undefined ? "thread-configuration" : "thread-configure",
  schedule_task: ({ scheduledTaskId }) =>
    scheduledTaskId === undefined ? "schedule-create" : "schedule-update",
};

export function resolveHoustonMcpSummaryAction(
  toolName: string | null | undefined,
  input: unknown,
): HoustonMcpToolSummaryAction | null {
  const definition = resolveHoustonMcpToolDefinition(toolName, input);
  if (definition === null) return null;
  const summarize = ACTION_SUMMARIES[resolveHoustonMcpToolName(toolName!) ?? ""];
  const fields = asSummaryInput(input);
  return (fields && summarize?.(fields)) ?? definition.summaryAction;
}

export function resolveHoustonMcpToolPresentation(
  toolName: string | null | undefined,
  input?: unknown,
): HoustonMcpToolPresentation | null {
  const definition = resolveHoustonMcpToolDefinition(toolName, input);
  return definition === null ? null : { displayName: definition.displayName, logo: "houston" };
}
