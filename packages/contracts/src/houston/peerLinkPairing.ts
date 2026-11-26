import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes } from "../auth.ts";
import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "../baseSchemas.ts";

/** The MCP tool a linked environment answers to mint a client's pairing credential. */
export const PEER_LINK_CLIENT_PAIRING_TOOL = "houston_peer_link_client_pairing";

/**
 * What the environment that links asks the linked one for: the scopes its client
 * holds here, which the linked environment intersects with what a client may be
 * granted, and the name the linked environment's Connections shows.
 */
export const PeerLinkClientPairingToolInput = Schema.Struct({
  scopes: AuthEnvironmentScopes,
  clientLabel: TrimmedNonEmptyString,
});
export type PeerLinkClientPairingToolInput = typeof PeerLinkClientPairingToolInput.Type;

/** A one-time code the client redeems at the linked environment; it grants only `scopes`. */
export const PeerLinkClientPairingToolResult = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type PeerLinkClientPairingToolResult = typeof PeerLinkClientPairingToolResult.Type;

/** Asks the environment this one links to for a one-time client pairing. */
export const PeerLinkPairClientInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkPairClientInput = typeof PeerLinkPairClientInput.Type;

/**
 * A pairing code for a client of this window to connect to the linked
 * environment itself. It travels only in this result: never logged, traced or
 * recorded, and absent from every error.
 */
export const PeerLinkPairClientResult = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  urls: Schema.Array(TrimmedNonEmptyString),
  /** The first address, as an add-environment host (`host:port`). */
  host: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type PeerLinkPairClientResult = typeof PeerLinkPairClientResult.Type;
