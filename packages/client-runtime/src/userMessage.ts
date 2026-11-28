import {
  type OrchestrationV2Actor,
  type OrchestrationV2CompactionReason,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  ScheduledTaskId,
  type WakeCompactionSource,
  wakeCompactionSource,
} from "@houston-app/contracts";
import { formatTokens } from "@houston-app/shared/usageFormat";
import { isAttachmentOnlyBootstrapPrompt } from "@houston-app/shared/composerContextReferences";

/** The working row while Houston's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** The finished compaction's own reason, with the size it held before compacting. */
export const COMPACTION_REASON_TITLES = {
  beforeCacheExpires: "Compacted before the cache expired",
  onReturn: "Compacted when you returned",
  onRequest: "Compacted on request",
} as const;

/** What woke a stale thread that Houston compacted before its turn could start. */
export const WAKE_COMPACTION_TITLES = {
  agentMessage: "Compacted before an agent message",
  delegatedResult: "Compacted before a delegated result",
  limitResume: "Compacted before resuming after a usage limit",
  backgroundCompletion: "Compacted before a background completion",
  restartNote: "Compacted before a restart note",
  manualContinuation: "Compacted before your continuation",
  userMessage: "Compacted before your message",
  pullRequestWatch: "Compacted before a pull request update",
  cardAnswer: "Compacted before a card answer",
  childQuestionAnswer: "Compacted before a child question answer",
  scheduledTask: "Compacted before a scheduled task",
  taskRun: "Compacted before a task run",
  slackAnswer: "Compacted before a Slack answer",
  mergeQueueNote: "Compacted before a merge-queue update",
} satisfies Record<WakeCompactionSource, string>;

export function compactionReasonTitle(
  reason: OrchestrationV2CompactionReason,
  beforeTokenCount: number | undefined,
): string {
  const source = wakeCompactionSource(reason);
  const title =
    source === null
      ? COMPACTION_REASON_TITLES[reason as keyof typeof COMPACTION_REASON_TITLES]
      : WAKE_COMPACTION_TITLES[source];
  return beforeTokenCount === undefined ? title : `${title}: ${formatTokens(beforeTokenCount)}`;
}

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
}): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "houston" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    // The agent needs words to start a turn; people sent only the attachments.
    text: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "houston"
          : "agent",
    scheduledTaskId: undefined,
  };
}
