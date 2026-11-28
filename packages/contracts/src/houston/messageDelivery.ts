import * as Schema from "effect/Schema";

import { ProviderTurnId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { RuntimeMode } from "../providerPolicy.ts";

/** Why a queued message cannot start; the queue holds it until the reason is cleared. */
export const MessageDeliveryQueueHoldReasonKind = Schema.Literals([
  "disabled_instance",
  "usage_limit",
  "runtime_mode_ceiling",
  "provider_switch_failed",
  "workspace_preparation",
  "background_work",
  "context_compaction",
  "stopped_thread",
]);
export type MessageDeliveryQueueHoldReasonKind = typeof MessageDeliveryQueueHoldReasonKind.Type;

export const MessageDeliveryQueueHoldReason = Schema.Struct({
  kind: MessageDeliveryQueueHoldReasonKind,
  /** What blocks the start, naming the value, and what the user can do about it. */
  message: TrimmedNonEmptyString,
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  maxRuntimeMode: Schema.optionalKey(RuntimeMode),
  /** When a limits hold is expected to release; absent when the provider reported no reset. */
  releaseAt: Schema.optionalKey(TrimmedNonEmptyString),
  /** A limits hold that outlived its expected release. */
  overdue: Schema.optionalKey(Schema.Boolean),
});
export type MessageDeliveryQueueHoldReason = typeof MessageDeliveryQueueHoldReason.Type;

/** What the provider reported as reading the message; `turnStarted` is the message's own turn. */
export const MessageDeliveryEvidence = Schema.Literals([
  "turnStarted",
  "claude.commandStarted",
  "claude.promptEcho",
  "codex.userMessage",
  "opencode.inboxDelivered",
  "opencode.replyParent",
]);
export type MessageDeliveryEvidence = typeof MessageDeliveryEvidence.Type;

/** Evidence an adapter reports in a `message.delivery` provider event. */
export const MessageDeliveryReportEvidence = Schema.Literals([
  "claude.commandStarted",
  "claude.promptEcho",
  "codex.userMessage",
  "opencode.inboxDelivered",
  "opencode.replyParent",
]);
export type MessageDeliveryReportEvidence = typeof MessageDeliveryReportEvidence.Type;

const deliveryFields = {
  intent: Schema.Literals(["queue", "steer", "interrupt"]),
  /** `ownTurn`: the message starts a turn of its own instead of entering the running one. */
  route: Schema.Literals(["activeTurn", "ownTurn"]),
  rerouted: Schema.optionalKey(Schema.Literals(["turnEnded", "turnBusy"])),
  promotedFrom: Schema.optionalKey(Schema.Literal("queue")),
  state: Schema.Literals(["accepted", "delivered", "adopted", "unconfirmed", "dropped"]),
  /** Whether this provider says when it reads the message; null until delivered. */
  adoption: Schema.NullOr(Schema.Literals(["reported", "notReported"])),
  evidence: Schema.NullOr(MessageDeliveryEvidence),
  reason: Schema.optionalKey(Schema.Literals(["cancelled", "providerCancelled", "failed"])),
  // The same limit as a turn's provider failure, whose text a failed delivery carries.
  message: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  /** Why the queue holds this message instead of starting it; absent when it can start. */
  queueHeldReason: Schema.optionalKey(Schema.NullOr(MessageDeliveryQueueHoldReason)),
  providerTurnId: Schema.NullOr(ProviderTurnId),
} as const;

/** Where a queued, steered or interrupting message is between the composer and the agent. */
export const MessageDelivery = Schema.Struct({ ...deliveryFields, at: Schema.DateTimeUtc });
export type MessageDelivery = typeof MessageDelivery.Type;

/** The stored and wire form of `MessageDelivery`. */
export const MessageDeliveryJson = Schema.Struct({
  ...deliveryFields,
  at: Schema.DateTimeUtcFromString,
});
export type MessageDeliveryJson = typeof MessageDeliveryJson.Type;
