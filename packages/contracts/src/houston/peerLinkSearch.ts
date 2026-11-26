import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { OrchestrationSearchThreadsInput } from "../threadSearch.ts";

/**
 * Most matches kept per linked machine. The palette shows a short list, so a machine with a long
 * tail of weak matches must not crowd out the others; the machine's own ranking decides the order.
 */
export const PEER_LINK_SEARCH_MAX_MATCHES = 10;

/** Longest title or excerpt kept from a linked machine: one palette row holds about this much. */
export const PEER_LINK_SEARCH_MAX_TEXT_LENGTH = 160;

/**
 * How long one linked machine may take before it counts as slow. A tailnet route to a machine
 * that is waking up takes a few seconds, while a search that takes longer than this is not worth
 * holding a palette line for; Retry asks again.
 */
export const PEER_LINK_SEARCH_TIMEOUT_MS = 8_000;

/** The search sent to every linked machine, or to the named ones. */
export const PeerLinkSearchInput = Schema.Struct({
  query: OrchestrationSearchThreadsInput.fields.query,
  /** Only these linked machines: a retry for the ones that did not answer. */
  environmentIds: Schema.optionalKey(Schema.Array(EnvironmentId)),
});
export type PeerLinkSearchInput = typeof PeerLinkSearchInput.Type;

/** A bound that cut a machine's answer short: which one, its value, what the machine sent. */
export const PeerLinkSearchLimitHit = Schema.Struct({
  limit: Schema.Literals(["matches", "textLength", "timeoutMs"]),
  max: Schema.Int,
  actual: Schema.Int,
  /** In words: what was asked and what the bound did about it. */
  detail: Schema.String,
});
export type PeerLinkSearchLimitHit = typeof PeerLinkSearchLimitHit.Type;

/** One matching thread on a linked machine. All text is the other machine's, untrusted. */
export const PeerLinkSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  source: Schema.Literals(["title", "user", "assistant"]),
  snippet: Schema.optionalKey(Schema.String),
  messageCreatedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
});
export type PeerLinkSearchMatch = typeof PeerLinkSearchMatch.Type;

export const PeerLinkSearchMachineStatus = Schema.Literals([
  "ok",
  "unreachable",
  "timed_out",
  "expired",
  "off",
]);
export type PeerLinkSearchMachineStatus = typeof PeerLinkSearchMachineStatus.Type;

export const PeerLinkSearchMachine = Schema.Struct({
  environmentId: EnvironmentId,
  /** The name this machine was linked under, as Settings lists it. */
  label: TrimmedNonEmptyString,
  /** `off` means the linked machine has Linked environments off. */
  status: PeerLinkSearchMachineStatus,
  matches: Schema.Array(PeerLinkSearchMatch),
  /** Why a machine did not answer, in words for the footer. Absent when it answered. */
  message: Schema.optionalKey(Schema.String),
  /** Bounds that trimmed this machine's answer or ended its wait. */
  limits: Schema.Array(PeerLinkSearchLimitHit),
});
export type PeerLinkSearchMachine = typeof PeerLinkSearchMachine.Type;

/**
 * What the search streams: first which machines it asks (none while Linked environments is off
 * here, when nothing is sent to any machine), then one answer per machine as it arrives, so a slow
 * machine never holds back a fast one.
 */
export const PeerLinkSearchEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("started"),
    enabled: Schema.Boolean,
    machines: Schema.Array(
      Schema.Struct({ environmentId: EnvironmentId, label: TrimmedNonEmptyString }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("machine"), machine: PeerLinkSearchMachine }),
]);
export type PeerLinkSearchEvent = typeof PeerLinkSearchEvent.Type;
