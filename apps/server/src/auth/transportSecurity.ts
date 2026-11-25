import type { RemoteTransportPolicy } from "@houston-app/contracts";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";

import {
  isLocalLoopbackHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@houston-app/shared/hostClassification";

/**
 * How a request reached this server. SSH port-forwards present as loopback
 * traffic, so they count as `loopback`; the client labels them separately.
 */
export type RequestTransportKind = "loopback" | "tailscale" | "tunnel" | "lan-or-proxy";

const TUNNEL_HEADERS = ["cf-connecting-ip", "cf-ray"] as const;
const FORWARDED_BRACKETS = /^\[|\]$/g;
const IPV4_MAPPED_PREFIX = /^::ffff:/i;

const firstForwardedFor = (
  headers: HttpServerRequest.HttpServerRequest["headers"],
): string | undefined => {
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return undefined;
  return forwarded.split(",")[0]?.trim().replace(FORWARDED_BRACKETS, "");
};

const isTailscaleAddress = (address: string): boolean =>
  isSharedAddressSpaceHost(address) || isTailnetHost(address);

/**
 * Classifies the request by transport origin. A loopback peer with forwarding
 * headers is a local proxy (Tailscale Serve, cloudflared): the client it
 * forwards for decides the kind, so a tunnel through a local process is still
 * a tunnel.
 */
export const classifyRequestTransport = (
  request: Pick<HttpServerRequest.HttpServerRequest, "remoteAddress" | "headers">,
): RequestTransportKind => {
  const headers = request.headers;
  for (const header of TUNNEL_HEADERS) {
    if (headers[header] !== undefined) return "tunnel";
  }
  const peer = Option.getOrUndefined(request.remoteAddress);
  if (peer === undefined) return "lan-or-proxy";
  const normalizedPeer = peer.replace(IPV4_MAPPED_PREFIX, "");
  if (isTailscaleAddress(normalizedPeer)) return "tailscale";
  if (isLocalLoopbackHost(normalizedPeer)) {
    const forwarded = firstForwardedFor(headers);
    if (forwarded === undefined) return "loopback";
    if (isTailscaleAddress(forwarded)) return "tailscale";
    if (isLocalLoopbackHost(forwarded)) return "loopback";
    return "lan-or-proxy";
  }
  return "lan-or-proxy";
};

/** Transports a `private-e2ee-only` server answers. */
export const isPrivateTransport = (kind: RequestTransportKind): boolean =>
  kind === "loopback" || kind === "tailscale";

export const transportAllowedByPolicy = (
  kind: RequestTransportKind,
  policy: RemoteTransportPolicy,
): boolean => policy === "any" || isPrivateTransport(kind);
