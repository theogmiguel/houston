import * as Schema from "effect/Schema";

import { IsoDateTime, ProviderThreadId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * MCP servers name themselves, so the name is bounded before it reaches a notice or a prompt.
 * 256 matches the longest server key the provider configs accept in practice.
 */
export const HOUSTON_MCP_SERVER_NAME_MAX_LENGTH = 256;
export const HoustonMcpServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(HOUSTON_MCP_SERVER_NAME_MAX_LENGTH),
);

/** The sign-in page is opened by clients, so a `javascript:` URL would run as the client. */
const HoustonMcpSignInUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(16_384),
  Schema.isPattern(/^https?:\/\//i),
);

/** One of an agent's MCP servers, in the thread whose live session reported it. */
export const HoustonMcpSignInStartInput = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  server: HoustonMcpServerName,
});
export type HoustonMcpSignInStartInput = typeof HoustonMcpSignInStartInput.Type;

export const HoustonMcpSignInStartResult = Schema.Struct({
  /** The page to approve the sign-in on; null when the server needs none any more. */
  authorizationUrl: Schema.NullOr(HoustonMcpSignInUrl),
  /** Set, with a null page, when the server was already signed in. */
  signedInAt: Schema.NullOr(IsoDateTime),
});
export type HoustonMcpSignInStartResult = typeof HoustonMcpSignInStartResult.Type;

export const HoustonMcpSignInCompleteInput = Schema.Struct({
  ...HoustonMcpSignInStartInput.fields,
  /** The address the browser ended on after approving, usually a dead `127.0.0.1` page. */
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type HoustonMcpSignInCompleteInput = typeof HoustonMcpSignInCompleteInput.Type;

export const HoustonMcpSignInCompleteResult = Schema.Struct({
  signedInAt: IsoDateTime,
});
export type HoustonMcpSignInCompleteResult = typeof HoustonMcpSignInCompleteResult.Type;

export const HoustonMcpSignInErrorKind = Schema.Literals([
  /** The thread has no live provider session (ended, or never started). */
  "session-ended",
  /** The thread's provider does not support MCP sign-in; `message` names it. */
  "unsupported-provider",
  /** The pasted address does not belong to the current sign-in. */
  "callback-rejected",
  /** The provider failed or timed out; the cause is dropped because it can echo the address. */
  "failed",
]);
export type HoustonMcpSignInErrorKind = typeof HoustonMcpSignInErrorKind.Type;

/** Safe to show: never carries the callback address, a code, a token or a cause. */
export class HoustonMcpSignInError extends Schema.TaggedError<HoustonMcpSignInError>()(
  "HoustonMcpSignInError",
  {
    kind: HoustonMcpSignInErrorKind,
    server: Schema.String,
    message: Schema.String,
  },
) {}
