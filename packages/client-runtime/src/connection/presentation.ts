import type { ServerConfig } from "@houston-app/contracts";
import * as Option from "effect/Option";

import {
  isLocalLoopbackHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
} from "@houston-app/shared/hostClassification";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { ConnectionTarget, SupervisorConnectionState } from "./model.ts";
import { connectionRouteId, connectionRoutes, routeHttpBaseUrl } from "./routes.ts";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
}

/**
 * Provider statuses are pushed every few minutes with fresh `checkedAt` stamps, and every root
 * coordinator reads environment presentations. Leaving them out keeps a presentation stable
 * across those pushes; provider readers subscribe to the server's providers atom instead.
 */
export type EnvironmentServerConfig = Omit<ServerConfig, "providers">;

/** How the active connection reaches the server, shown as a security badge. */
export type ConnectionSecurityBadgeKind =
  | "local"
  | "e2ee-transport"
  | "e2ee-app"
  | "tls-tunnel"
  | "unencrypted";

export interface ConnectionSecurityBadge {
  readonly kind: ConnectionSecurityBadgeKind;
}

const isTailscaleUrlHost = (url: URL): boolean =>
  isTailnetHost(url.hostname) || isSharedAddressSpaceHost(url.hostname);

/**
 * Derives the security badge for an environment's active connection. The app
 * layer wins over the transport: a verified E2EE session protects the traffic
 * no matter which transport carries it.
 */
export function connectionSecurityBadge(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly connectedTarget: ConnectionTarget | null;
}): ConnectionSecurityBadge | null {
  const connectedRoute = input.connectedTarget
    ? connectionRoutes(input.entry).find(
        (route) => connectionRouteId(route.target) === connectionRouteId(input.connectedTarget!),
      )
    : undefined;
  const profile = Option.getOrUndefined(connectedRoute?.profile ?? input.entry.profile);
  if (profile?._tag === "BearerConnectionProfile" && profile.serverIdentityKey !== undefined) {
    return { kind: "e2ee-app" };
  }
  const target = input.connectedTarget ?? input.entry.target;
  switch (target._tag) {
    case "SshConnectionTarget":
      return { kind: "e2ee-transport" };
    case "PrimaryConnectionTarget":
    case "BearerConnectionTarget": {
      const httpBaseUrl =
        target._tag === "PrimaryConnectionTarget"
          ? target.httpBaseUrl
          : profile?._tag === "BearerConnectionProfile"
            ? profile.httpBaseUrl
            : null;
      if (httpBaseUrl === null) return null;
      let url: URL;
      try {
        url = new URL(httpBaseUrl);
      } catch {
        return null;
      }
      if (isLocalLoopbackHost(url.hostname)) return { kind: "local" };
      if (isTailscaleUrlHost(url)) return { kind: "e2ee-transport" };
      return url.protocol === "https:" ? { kind: "tls-tunnel" } : { kind: "unencrypted" };
    }
  }
}

export function connectionSecurityBadgeText(badge: ConnectionSecurityBadge): string {
  switch (badge.kind) {
    case "local":
      return "Local";
    case "e2ee-transport":
      return "E2EE (Tailscale / SSH)";
    case "e2ee-app":
      return "E2EE";
    case "tls-tunnel":
      return "TLS only";
    case "unencrypted":
      return "Unencrypted";
  }
}

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: EnvironmentServerConfig | null;
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "unsupported" ? "unsupported" : "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
  }
}

export function connectionStatusText(connection: EnvironmentConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      return connection.error
        ? `Failed to connect. Reconnecting... Reason: ${connection.error}`
        : "Reconnecting...";
    case "connected":
      return "Connected";
    case "unsupported":
      return "Client not supported";
    case "error":
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }
  return connectionStatusText({ ...connection, error: null });
}

/**
 * SSH connections ride a local forward that disappears with the client, so they have no stable
 * address.
 */
export function environmentMcpUrl(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly connectedTarget?: ConnectionTarget | null | undefined;
}): string | null {
  const connectedRouteId = input.connectedTarget ? connectionRouteId(input.connectedTarget) : null;
  const routes = connectionRoutes(input.entry);
  const connectedRoute = routes.find(
    (route) => connectionRouteId(route.target) === connectedRouteId,
  );
  for (const route of connectedRoute ? [connectedRoute, ...routes] : routes) {
    const httpBaseUrl = routeHttpBaseUrl(route);
    const mcpUrl = httpBaseUrl === null ? null : mcpUrlFromBase(httpBaseUrl);
    if (mcpUrl !== null) return mcpUrl;
  }
  return null;
}

function mcpUrlFromBase(httpBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}
