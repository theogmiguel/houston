import type { DesktopLocalServerStatus, HostBridge } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __setPrimaryHttpRunnerForTests } from "../../lib/runtime";
import { __resetDesktopPrimaryAuthForTests } from "./desktopAuth";

const WINDOW_ORIGIN = "http://tauri.localhost";
const SERVER_ORIGIN = "http://127.0.0.1:3773";
const NOT_RUNNING = "the v2 server is not running yet";
const REJECTED = "the v2 server rejected the desktop credential";

const DESKTOP_AUTH = {
  policy: "desktop-managed-local",
  bootstrapMethods: ["desktop-bootstrap"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "houston_session",
} as const;

/** The Tauri host as the renderer sees it while its local server starts. */
function installStartingHost(
  initialState: DesktopLocalServerStatus["state"] = "starting",
  {
    bearerRefused = false,
    bootstrapPublished = true,
  }: { bearerRefused?: boolean; bootstrapPublished?: boolean } = {},
) {
  let state = initialState;
  let published = bootstrapPublished;
  const listeners = new Set<(status: DesktopLocalServerStatus) => void>();
  const bridge = {
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () =>
      state === "ready" && published
        ? [
            {
              id: "primary",
              label: "Local",
              httpBaseUrl: SERVER_ORIGIN,
              wsBaseUrl: "ws://127.0.0.1:3773",
              bootstrapToken: "desktop-bootstrap-token",
            },
          ]
        : [],
    getLocalEnvironmentBearerToken: vi.fn(async () => {
      if (state !== "ready") throw NOT_RUNNING;
      if (bearerRefused) throw REJECTED;
      return "desktop-bearer";
    }),
    invalidateLocalEnvironmentBearerToken: vi.fn(async () => undefined),
    getServerStatus: vi.fn(async () => ({ state })),
    onServerStatus: (listener: (status: DesktopLocalServerStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const location = new URL(`${WINDOW_ORIGIN}/`);
  vi.stubGlobal("window", {
    location,
    history: { state: null, replaceState: () => undefined },
    hostBridge: bridge as unknown as HostBridge,
  });
  vi.stubGlobal("document", { title: "Houston" });

  const setState = (next: DesktopLocalServerStatus["state"]) => {
    state = next;
    for (const listener of listeners) listener({ state: next });
  };
  const publishBootstrap = () => {
    published = true;
  };
  return { bridge, setState, publishBootstrap, listenerCount: () => listeners.size };
}

function installServer() {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, authorization: request.headers.get("authorization") });
    if (!request.url.startsWith(SERVER_ORIGIN)) {
      return new Response("not the server", { status: 404 });
    }
    return Response.json({
      authenticated: true,
      auth: DESKTOP_AUTH,
      sessionMethod: "bearer-access-token",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
}

describe("desktop cold start", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    __setPrimaryHttpRunnerForTests();
    __resetDesktopPrimaryAuthForTests();
    const { __resetServerAuthBootstrapForTests } = await import("./auth");
    __resetServerAuthBootstrapForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits for a starting server and authenticates without a reload", async () => {
    const host = installStartingHost();
    const requests = installServer();
    const { resolveInitialServerAuthGateState } = await import("./auth");

    const gate = resolveInitialServerAuthGateState();
    // The first attempt failed and the bootstrap now waits for the server.
    await vi.waitFor(() => expect(host.listenerCount()).toBe(1));
    host.setState("ready");

    await expect(gate).resolves.toEqual({ status: "authenticated" });
    expect(requests.map((request) => new URL(request.url).origin)).not.toContain(WINDOW_ORIGIN);
    expect(requests.at(-1)).toEqual({
      url: `${SERVER_ORIGIN}/api/auth/session`,
      authorization: "Bearer desktop-bearer",
    });
  });

  it("retries as soon as the host reports the server ready", async () => {
    // Timers of a second or more never fire, so only the status event can end the wait.
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((handler: () => void, delay?: number) =>
      realSetTimeout(
        (delay ?? 0) >= 1_000 ? () => undefined : handler,
        delay,
      )) as typeof setTimeout);
    const host = installStartingHost();
    installServer();
    const { resolveInitialServerAuthGateState } = await import("./auth");

    const gate = resolveInitialServerAuthGateState();
    await vi.waitFor(() => expect(host.listenerCount()).toBe(1));
    host.setState("ready");
    await expect(gate).resolves.toEqual({ status: "authenticated" });
  });

  it("retries at once when the server is already ready, without waiting for an event", async () => {
    // The ready event can fire before the bridge's listener subscribes; only state reads remain.
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((handler: () => void, delay?: number) =>
      realSetTimeout(
        (delay ?? 0) >= 1_000 ? () => undefined : handler,
        delay,
      )) as typeof setTimeout);
    const host = installStartingHost("ready", { bootstrapPublished: false });
    installServer();
    const { resolveInitialServerAuthGateState } = await import("./auth");

    const gate = resolveInitialServerAuthGateState();
    await vi.waitFor(() => expect(host.bridge.getServerStatus).toHaveBeenCalled());
    host.publishBootstrap();
    await expect(gate).resolves.toEqual({ status: "authenticated" });
  }, 5_000);

  it("gives up quickly when a ready server keeps refusing the credential", async () => {
    // The host refuses with the same error when the running server rejects its credential.
    const host = installStartingHost("ready", { bearerRefused: true });
    installServer();
    const { resolveInitialServerAuthGateState } = await import("./auth");

    const startedAt = Date.now();
    await expect(resolveInitialServerAuthGateState()).rejects.toMatchObject({
      _tag: "PrimaryEnvironmentRequestError",
    });
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(host.bridge.getLocalEnvironmentBearerToken.mock.calls.length).toBeLessThan(20);
  }, 12_000);

  it("gives up quickly when a ready host never publishes this window's bootstrap", async () => {
    // A secondary webview whose bootstrap global the host does not refresh.
    installStartingHost("ready", { bootstrapPublished: false });
    installServer();
    const { resolveInitialServerAuthGateState } = await import("./auth");

    const startedAt = Date.now();
    await expect(resolveInitialServerAuthGateState()).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  }, 12_000);

  it("recovers on Try again after a failed start, without a reload", async () => {
    const host = installStartingHost("error");
    const requests = installServer();
    const { resolveInitialServerAuthGateState } = await import("./auth");

    await expect(resolveInitialServerAuthGateState()).rejects.toMatchObject({
      _tag: "PrimaryEnvironmentRequestError",
    });

    host.setState("ready");
    // "Try again" re-runs the root route's beforeLoad, which asks for the gate state again.
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(requests.map((request) => new URL(request.url).origin)).not.toContain(WINDOW_ORIGIN);
  });
});
