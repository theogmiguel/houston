// The ids the error log may hold. Callers can choose part of an id: an agent's request key, a
// provider instance's name, a provider's own id. An id is written only when every part is one a
// machine makes or a word Houston's id builders join; a builder's new word is omitted until listed.

const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
// A digest or an undashed uuid: neither a word spelled in hexadecimal letters nor a long number.
const HEX = "(?=[a-f]*[0-9])(?=[0-9]*[a-f])[0-9a-f]{16,64}";
const NUMBER = "[0-9]{1,20}";
const GENERATED = new RegExp(`^(?:${UUID}|${HEX}|${NUMBER})$`);
/** `task-review-<uuid>`, `merge-queue-<uuid>`, `task-run-<number>`. */
const PREFIXED = new RegExp(`^([a-z-]+)-(?:${UUID}|${NUMBER})$`);

// Ids nest by percent-encoding, once per level: a delegated task's run's attempt is at four.
const MAX_ENCODINGS = 8;
const MAX_CHARS = 512;

// One line per source: the literal words that its template or join puts between ids. A missing word
// loses an id from the log, never privacy. Left out on purpose: `runtime-reconcile` ids, whose ISO
// time is no part of this grammar, and the names users give provider instances.
const WORDS: ReadonlySet<string> = new Set(
  [
    // provider-core IdAllocator: kinds, then the parts between them.
    "event message node project provider-session provider-thread provider-turn run run-attempt",
    "checkpoint-scope context-handoff runtime-request thread turn-item attempt command",
    "created-thread delegated-task from-provider-instance name native-item native-request",
    "native-thread native-turn ordinal provider provider-instance root shared signal",
    "to-provider-instance",
    // Signals and native ids the orchestrator passes to it.
    "interrupt-request failed pending queued-start-failure workspace-preparation",
    "workspace-preparation-failure",
    // The driver kinds, which are also the default provider instances' names.
    "acpRegistry antigravity claudeAgent codex cursor fx grok kiro muse opencode pi remote",
    // mcp: OrchestratorMcpService and its operations.
    "mcp cancel-task cancel-task-completion-delivery cancel-task-orphan create-thread delegate-task",
    "delegate-task-wake-policy dispatch-thread record-created-thread schedule-task",
    "task-status-acknowledge thread-interrupt thread-send thread-stop",
    // mcp: launches and forks, metadata, worktrees, pull requests; McpOAuth's namespace.
    "launch fork thread-update rename regenerate_title worktree-handoff worktree-continuation",
    "mcp-pr-link mcp-pr-unlink mcp-pr-watch client",
    // peer: RemoteDelegation, PeerForwarding, PeerLinkRequests.
    "cancel delegate fwd link-pending link-request remote-delegate remote-task",
    "remote-task-complete",
    // Orchestrator: commands, and effects by their request type.
    "effect system delegated-completion-delivery delegated-task-question dropped-steer",
    "restart-continuation restart-continuation-retry resume-queued-runs side-chat side-thread",
    "start-queued delegated-tasks.stop provider-session.detach provider-thread.rollback",
    "provider-turn.interrupt provider-turn.restart provider-turn.start provider-turn.steer",
    "runtime-request.respond subagent.stop terminal.cleanup thread-title.generate",
    // Orchestrator: messages and turn items it names.
    "approval-feedback async-answer recovery-cancel runtime-request-delivery-failure",
    // ThreadDeletion, CheckpointCaptureService, ProviderRuntimeRecoveryService, EffectWorker.
    "attachment.cleanup preview.cleanup scheduled-tasks.cleanup checkpoint.capture restart-prepare",
    "background-work-settled delivery-failed mailbox-accepted rollback-failed steer-follow-up",
    "thread.history-purge unresponsive",
    // Reactors and services that dispatch as the server.
    "server auto-settle delegated-task-question-cancel idle-compact pr-created-link pr-stack-link",
    "pr-sync pr-watch provider-continuation settle-after-run thread-issue-link thread-issue-unlink",
    "thread-pull-request title-complete limit-arm limit-resume legacy",
    // ThreadLaunchService, ThreadManagementService, ProjectService.
    "branch-rename cancel-workspace fail initial-message progress release setup workspace worktree",
    "stop delete-thread force-stop",
    // ScheduledTaskService.
    "scheduled-task scheduled-task-message manual scheduled webhook",
    // Projects: managed folders, promotion, clones, the welcome wizard; the client's own commands.
    "named-project scratch-project scratch-project-icon scratch-promotion scratch-promotion-project",
    "project-clone-create project-clone-done onboarding create detach model-selection",
    // SecretRequests, and imports of agent sessions and of v1.
    "secret-request declined saved import houston-v1-import-project",
    // houston/: tasks, merge queue, Slack, side threads.
    "houston-task-plan houston-task-review houston-task-run findings task task-plan task-review",
    "task-run houston-merge-queue merge-queue hand houston-slack-answer side side-run",
  ].flatMap((line) => line.split(" ")),
);

/** The value with every level of percent-encoding removed, or undefined when it cannot be. */
const decoded = (value: string): string | undefined => {
  let current = value;
  for (let level = 0; level <= MAX_ENCODINGS; level += 1) {
    if (!current.includes("%")) return current;
    try {
      current = decodeURIComponent(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const isGeneratedPart = (part: string): boolean => {
  if (GENERATED.test(part) || WORDS.has(part)) return true;
  const prefix = PREFIXED.exec(part)?.[1];
  return prefix !== undefined && WORDS.has(prefix);
};

/** Whether every part of an id, at every level of nesting, is generated or a listed word. */
export const isGeneratedId = (value: string): boolean => {
  if (value.length > MAX_CHARS) return false;
  const id = decoded(value);
  return id !== undefined && id.split(":").every(isGeneratedPart);
};
