import {
  type AuthEnvironmentScope,
  type EnvironmentId,
  PeerLinkError,
} from "@houston-app/contracts";
import { type PeerLinkPairClientResult } from "@houston-app/contracts/houston/peerLinkPairing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { linkedEnvironmentsOffThere } from "../peer/PeerMcpClient.ts";

/** The wording the palette and Settings use for a link's access. */
const accessLabel = (access: string) =>
  access === "full-access"
    ? "full access"
    : access === "read-only"
      ? "read only"
      : access === "approval-required"
        ? "approval required"
        : access;

/**
 * Asks a linked environment for a one-time pairing code for a client of this
 * window. Only a full-access link may: a lower link would gain access it does
 * not hold. The code is returned once and never recorded here.
 */
export class PeerLinkPairing extends Context.Service<
  PeerLinkPairing,
  {
    readonly pairClient: (
      input: { readonly environmentId: EnvironmentId },
      caller: {
        readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
        readonly clientLabel: string;
      },
    ) => Effect.Effect<PeerLinkPairClientResult, PeerLinkError>;
  }
>()("@houston-app/cli/houston/peerLinkPairing") {}

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const issuedAt = yield* Clock.currentTimeMillis;
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId,
    capabilities: new Set(["orchestration"]),
    issuedAt,
    requestNamespace: "internal:peer-link-pairing",
    thread: undefined,
    // Minting a client's code for a full-access link is itself full access here;
    // the linked environment still enforces its own link's access.
    client: {
      sessionId: "internal:peer-link-pairing",
      label: "Houston window",
      access: "full-access",
    },
  };

  const pairClient: PeerLinkPairing["Service"]["pairClient"] = Effect.fn(
    "PeerLinkPairing.pairClient",
  )(function* ({ environmentId: target }, caller) {
    if (!(yield* links.enabled)) {
      return yield* new PeerLinkError({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    const stored = yield* links.get(target);
    if (Option.isNone(stored)) {
      return yield* new PeerLinkError({
        reason: "unknown_link",
        message: `This environment is not linked to ${target}.`,
      });
    }
    const link = stored.value;
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, yield* DateTime.now)) {
      return yield* new PeerLinkError({
        reason: "expired",
        message: `The link to ${link.label} expired. Link it again with a new pairing code from ${link.label}.`,
      });
    }
    if (link.access !== "full-access") {
      return yield* new PeerLinkError({
        reason: "pairing_rejected",
        message: `Pairing a client needs a full-access link. ${link.label}'s link is ${accessLabel(link.access)}.`,
      });
    }
    const issued = yield* forwarding
      .pairClient(scope, target, {
        scopes: [...caller.scopes],
        clientLabel: caller.clientLabel,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new PeerLinkError({
              reason:
                error.message === linkedEnvironmentsOffThere.message
                  ? "disabled"
                  : error.code === "capability_denied"
                    ? "pairing_rejected"
                    : "unreachable",
              message: error.message,
            }),
        ),
      );
    const first = link.urls[0];
    if (first === undefined) {
      return yield* new PeerLinkError({
        reason: "unreachable",
        message: `${link.label} has no address this environment can reach.`,
      });
    }
    return {
      environmentId: target,
      label: link.label,
      urls: [...link.urls],
      host: URL.parse(first)?.host ?? first,
      credential: issued.credential,
      expiresAt: issued.expiresAt,
    };
  });

  return PeerLinkPairing.of({ pairClient });
});

export const layer = Layer.effect(PeerLinkPairing, make);
