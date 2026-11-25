import { EnvironmentId } from "@houston-app/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  SshConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  connectionSecurityBadge,
  connectionSecurityBadgeText,
  environmentMcpUrl,
  presentConnectionState,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
  enabled: true,
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("copies the MCP address of the route this device is connected over", () => {
    const route = (connectionId: string, httpBaseUrl: string): ConnectionRoute => {
      const target = new BearerConnectionTarget({ ...TARGET, connectionId });
      return {
        target,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId,
            environmentId: TARGET.environmentId,
            label: TARGET.label,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
          }),
        ),
      };
    };
    const lan = route("lan", "http://192.168.4.53:3773/");
    const tailnet = route("tailnet", "http://100.115.1.44:3773/");
    const serve = route("serve", "https://machine.tailnet.ts.net/");
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: lan.target,
      profile: lan.profile,
      alternateRoutes: [tailnet, serve],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: tailnet.target })).toBe(
      "http://100.115.1.44:3773/mcp",
    );
    expect(environmentMcpUrl({ entry })).toBe("http://192.168.4.53:3773/mcp");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentConnectionState(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });
});

describe("connectionSecurityBadge", () => {
  const entryFor = (httpBaseUrl: string, serverIdentityKey?: string): ConnectionCatalogEntry => ({
    ...ENTRY,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: TARGET.connectionId,
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
        ...(serverIdentityKey ? { serverIdentityKey } : {}),
      }),
    ),
  });

  it("marks loopback origins as local", () => {
    for (const url of ["http://127.0.0.1:3773", "http://localhost:3773"]) {
      expect(connectionSecurityBadge({ entry: entryFor(url), connectedTarget: null })).toEqual({
        kind: "local",
      });
    }
  });

  it("marks tailnet origins as end-to-end-encrypted transports", () => {
    for (const url of ["http://100.72.10.4:3773", "https://host.tail-scale.ts.net"]) {
      expect(connectionSecurityBadge({ entry: entryFor(url), connectedTarget: null })).toEqual({
        kind: "e2ee-transport",
      });
    }
  });

  it("marks plain LAN origins as unencrypted and https ones as TLS only", () => {
    expect(
      connectionSecurityBadge({
        entry: entryFor("http://192.168.1.20:3773"),
        connectedTarget: null,
      }),
    ).toEqual({ kind: "unencrypted" });
    expect(
      connectionSecurityBadge({
        entry: entryFor("https://192.168.1.20:3773"),
        connectedTarget: null,
      }),
    ).toEqual({ kind: "tls-tunnel" });
  });

  it("the pinned app layer wins over the transport badge", () => {
    const badge = connectionSecurityBadge({
      entry: entryFor("http://192.168.1.20:3773", "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw"),
      connectedTarget: null,
    });
    expect(badge).toEqual({ kind: "e2ee-app" });
    expect(connectionSecurityBadgeText(badge!)).toBe("E2EE");
  });

  it("marks SSH routes as end-to-end-encrypted transports", () => {
    const target = new SshConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      connectionId: "ssh-1",
    });
    const entry: ConnectionCatalogEntry = { ...ENTRY, target, profile: Option.none() };
    expect(connectionSecurityBadge({ entry, connectedTarget: null })).toEqual({
      kind: "e2ee-transport",
    });
  });
});
