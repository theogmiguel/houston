import * as Schema from "effect/Schema";

import { ProviderTurnId, TrimmedNonEmptyString } from "../baseSchemas.ts";

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
