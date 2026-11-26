import { type PeerLink, type PeerLinkError } from "@houston-app/contracts";
import {
  PEER_LINK_SEARCH_MAX_MATCHES,
  PEER_LINK_SEARCH_MAX_TEXT_LENGTH,
  PEER_LINK_SEARCH_TIMEOUT_MS,
  type PeerLinkSearchEvent,
  type PeerLinkSearchInput,
  type PeerLinkSearchLimitHit,
  type PeerLinkSearchMachine,
} from "@houston-app/contracts/houston/peerLinkSearch";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { linkedEnvironmentsOffThere } from "../peer/PeerMcpClient.ts";

export interface PeerLinkSearchOptions {
  /** Overrides `PEER_LINK_SEARCH_TIMEOUT_MS`, which tests shorten to keep a bound observable. */
  readonly timeoutMs?: number;
}

/**
 * Searches the threads of every linked environment through the link itself:
 * only the typed query leaves this machine, one call per machine, with the
 * link's existing token. While the beta is off no call is made at all.
 */
export class PeerLinkSearch extends Context.Service<
  PeerLinkSearch,
  {
    readonly search: (
      input: PeerLinkSearchInput,
    ) => Stream.Stream<PeerLinkSearchEvent, PeerLinkError>;
  }
>()("@houston-app/cli/houston/peerLinkSearch") {}

const clip = (text: string, max: number) => text.slice(0, max);

const machineEvent = (
  link: PeerLink,
  answer: Omit<PeerLinkSearchMachine, "environmentId" | "label" | "access" | "host">,
): PeerLinkSearchEvent => ({
  type: "machine",
  machine: {
    environmentId: link.environmentId,
    label: link.label,
    access: link.access,
    host:
      (link.urls[0] !== undefined ? URL.parse(link.urls[0])?.host : undefined) ??
      link.urls[0] ??
      link.label,
    ...answer,
  },
});

const make = Effect.fn("PeerLinkSearch.make")(function* (options?: PeerLinkSearchOptions) {
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const timeoutMs = Math.max(1, options?.timeoutMs ?? PEER_LINK_SEARCH_TIMEOUT_MS);
  const environmentId = yield* environment.getEnvironmentId;
  const issuedAt = yield* Clock.currentTimeMillis;
  // A search reads: the peer sees a read-only caller, so it can never widen the
  // link's own access, and nothing here mints a credential.
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId,
    capabilities: new Set(["orchestration"]),
    issuedAt,
    requestNamespace: "internal:peer-link-search",
    thread: undefined,
    client: {
      sessionId: "internal:peer-link-search",
      label: "Houston thread search",
      access: "read-only",
    },
  };

  const answerFor = Effect.fn("PeerLinkSearch.answerFor")(function* (
    link: PeerLink,
    query: string,
  ): Effect.fn.Return<PeerLinkSearchEvent> {
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, yield* DateTime.now)) {
      return machineEvent(link, {
        status: "expired",
        matches: [],
        message: `The link to ${link.label} expired. Link it again with a new pairing code from ${link.label}.`,
        limits: [],
      });
    }
    const result = yield* forwarding
      .searchThreads(scope, link.environmentId, {
        query,
        limit: PEER_LINK_SEARCH_MAX_MATCHES,
      })
      .pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.result);
    if (Result.isFailure(result)) {
      const off = result.failure.message === linkedEnvironmentsOffThere.message;
      return machineEvent(link, {
        status: off ? "off" : "unreachable",
        matches: [],
        message: off
          ? `${link.label} has Linked environments turned off. Turn it on there in Settings → Labs.`
          : result.failure.message,
        limits: [],
      });
    }
    if (Option.isNone(result.success)) {
      return machineEvent(link, {
        status: "timed_out",
        matches: [],
        message: `${link.label} did not answer within ${timeoutMs} ms.`,
        limits: [
          {
            limit: "timeoutMs",
            max: timeoutMs,
            actual: timeoutMs,
            detail: `Searching ${link.label} for "${query}" took longer than ${timeoutMs} ms; it is still searching there.`,
          },
        ],
      });
    }

    const received = result.success.value.matches;
    const kept = received.slice(0, PEER_LINK_SEARCH_MAX_MATCHES);
    const matches = kept.map((match) => ({
      ...match,
      title: clip(match.title, PEER_LINK_SEARCH_MAX_TEXT_LENGTH),
      ...(match.snippet === undefined
        ? {}
        : { snippet: clip(match.snippet, PEER_LINK_SEARCH_MAX_TEXT_LENGTH) }),
    }));
    const limits: Array<PeerLinkSearchLimitHit> = [];
    if (received.length > PEER_LINK_SEARCH_MAX_MATCHES) {
      limits.push({
        limit: "matches",
        max: PEER_LINK_SEARCH_MAX_MATCHES,
        actual: received.length,
        detail: `Searching ${link.label} for "${query}" returned ${received.length} matches; kept the first ${PEER_LINK_SEARCH_MAX_MATCHES}.`,
      });
    }
    const longest = Math.max(
      0,
      ...kept.map((match) => Math.max(match.title.length, match.snippet?.length ?? 0)),
    );
    if (longest > PEER_LINK_SEARCH_MAX_TEXT_LENGTH) {
      limits.push({
        limit: "textLength",
        max: PEER_LINK_SEARCH_MAX_TEXT_LENGTH,
        actual: longest,
        detail: `Searching ${link.label} for "${query}" returned text ${longest} characters long; cut it to ${PEER_LINK_SEARCH_MAX_TEXT_LENGTH}.`,
      });
    }
    return machineEvent(link, { status: "ok", matches, limits });
  });

  const search: PeerLinkSearch["Service"]["search"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const enabled = yield* links.enabled;
        if (!enabled) {
          return Stream.make({
            type: "started",
            enabled: false,
            machines: [],
          } satisfies PeerLinkSearchEvent);
        }
        const all = yield* links.stored;
        const wanted = input.environmentIds;
        const selected =
          wanted === undefined ? all : all.filter((link) => wanted.includes(link.environmentId));
        const started = {
          type: "started",
          enabled: true,
          machines: selected.map((link) => ({
            environmentId: link.environmentId,
            label: link.label,
          })),
        } satisfies PeerLinkSearchEvent;
        // Each machine answers on its own stream, so a slow one never holds back a fast one.
        const answers = Stream.fromIterable(selected).pipe(
          Stream.flatMap((link) => Stream.fromEffect(answerFor(link, input.query)), {
            concurrency: "unbounded",
          }),
        );
        return Stream.concat(Stream.make(started), answers);
      }),
    );

  return PeerLinkSearch.of({ search });
});

export const layerWith = (options?: PeerLinkSearchOptions) =>
  Layer.effect(PeerLinkSearch, make(options));

export const layer = layerWith();
