// @effect-diagnostics nodeBuiltinImport:off -- the forwards are tested over real loopback sockets.
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics globalErrorInEffectFailure:off
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import { expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ConnectionCatalogDocument } from "@houston-app/client-runtime/platform";
import type { EnvironmentId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts";
import { PORT_FORWARDING_MAX_FORWARDS_PER_ENVIRONMENT } from "@houston-app/contracts/houston/portForwarding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NetService from "@houston-app/shared/Net";

import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopPortForwarding from "./DesktopPortForwarding.ts";

const decodeEnvironmentId = Schema.decodeSync(Schema.String);
const environmentId = (value: string): EnvironmentId =>
  decodeEnvironmentId(value) as EnvironmentId;

const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));
const decodeCatalog = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const catalogJson = (plain: unknown): string =>
  encodeCatalog(decodeCatalog(plain));

const sshCatalog = (): string =>
  catalogJson({
    schemaVersion: 1,
    targets: [
      {
        _tag: "SshConnectionTarget",
        environmentId: environmentId("env-ssh"),
        label: "Build box",
        connectionId: "ssh-conn",
      },
    ],
    profiles: [
      {
        _tag: "SshConnectionProfile",
        connectionId: "ssh-conn",
        environmentId: environmentId("env-ssh"),
        label: "Build box",
        target: { alias: "buildbox", hostname: "buildbox.test", username: null, port: null },
      },
    ],
    credentials: [],
    disabledEnvironmentIds: [],
  });

const linkedCatalog = (wsOrigin: string): string =>
  catalogJson({
    schemaVersion: 1,
    targets: [
      {
        _tag: "BearerConnectionTarget",
        environmentId: environmentId("env-linked"),
        label: "Linked box",
        connectionId: "linked-conn",
      },
    ],
    profiles: [
      {
        _tag: "BearerConnectionProfile",
        connectionId: "linked-conn",
        environmentId: environmentId("env-linked"),
        label: "Linked box",
        httpBaseUrl: wsOrigin.replace(/^ws/, "http"),
        wsBaseUrl: wsOrigin,
      },
    ],
    credentials: [
      {
        connectionId: "linked-conn",
        credential: { _tag: "BearerConnectionCredential", token: "secret-token" },
      },
    ],
    disabledEnvironmentIds: [],
  });

const settingsLayer = (initial: boolean) =>
  Layer.effect(
    DesktopClientSettings.DesktopClientSettings,
    Effect.gen(function* () {
      const state = yield* Ref.make(initial);
      return DesktopClientSettings.DesktopClientSettings.of({
        get: Ref.get(state).pipe(
          Effect.map((enabled) =>
            Option.some({ ...DEFAULT_CLIENT_SETTINGS, portForwardingEnabled: enabled }),
          ),
        ),
        set: (value) => Ref.set(state, value.portForwardingEnabled),
      });
    }),
  );

const catalogLayer = (catalog: string) =>
  Layer.succeed(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {
    get: Effect.succeedSome(catalog),
    set: () => Effect.succeed(true),
  } as DesktopConnectionCatalogStore.DesktopConnectionCatalogStore["Service"]);

const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
  sendAll: () => Effect.void,
} as unknown as ElectronWindow.ElectronWindow["Service"]);

const transportLayer = (input: {
  readonly echoPort: number;
  readonly seen: Array<{ readonly url: string; readonly token: string }>;
}) =>
  Layer.succeed(DesktopPortForwarding.PortForwardTunnelTransport, {
    connect: (request: { readonly url: string; readonly token: string }) =>
      Effect.gen(function* () {
        input.seen.push(request);
        return yield* NodeSocket.makeNet({ host: "127.0.0.1", port: input.echoPort });
      }),
  });

const sshLayer = (onForward?: (localPort: number) => void) =>
  Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {
    forwardPort: (input: { readonly localPort: number }) =>
      Effect.sync(() => {
        onForward?.(input.localPort);
        return { localPort: input.localPort, stop: Effect.void };
      }),
  });

const serviceLayer = (input: {
  readonly enabled: boolean;
  readonly catalog: string;
}) =>
  DesktopPortForwarding.layer.pipe(
    Layer.provideMerge(settingsLayer(input.enabled)),
    Layer.provide(catalogLayer(input.catalog)),
    Layer.provide(sshLayer()),
    Layer.provide(transportLayer({ echoPort: 1, seen: [] })),
    Layer.provide(windowLayer),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
  );

it.live("refuses every forward while the setting is off", () =>
  Effect.gen(function* () {
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    const result = yield* Effect.flip(
      forwarding.start({ environmentId: environmentId("env-ssh"), remotePort: 5432 }),
    );
    expect(result.reason).toBe("disabled");
    expect(result.message).toContain("Settings → Connections → Port forwarding");
    expect(yield* forwarding.list).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(serviceLayer({ enabled: false, catalog: sshCatalog() }))),
);

it.live("forwards through an SSH connection and stops on request", () =>
  Effect.gen(function* () {
    const forwarded: number[] = [];
    const layer = DesktopPortForwarding.layer.pipe(
      Layer.provide(settingsLayer(true)),
      Layer.provide(catalogLayer(sshCatalog())),
      Layer.provide(sshLayer((port) => forwarded.push(port))),
      Layer.provide(transportLayer({ echoPort: 1, seen: [] })),
      Layer.provide(windowLayer),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
    );
    yield* Effect.gen(function* () {
      const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
      const forward = yield* forwarding.start({
        environmentId: environmentId("env-ssh"),
        remotePort: 5432,
      });
      expect(forward.transport).toBe("ssh");
      expect(forward.localPort).toBe(5432);
      expect(forwarded).toEqual([5432]);
      yield* forwarding.stop({ id: forward.id });
      expect(yield* forwarding.list).toEqual([]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.live("chooses the next free local port and binds loopback only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const echo = yield* tcpEchoServer();
      const occupied = yield* occupyPort();
      const seen: Array<{ readonly url: string; readonly token: string }> = [];
      const layer = DesktopPortForwarding.layer.pipe(
        Layer.provide(settingsLayer(true)),
        Layer.provide(catalogLayer(linkedCatalog("ws://127.0.0.1:1"))),
        Layer.provide(sshLayer()),
        Layer.provide(transportLayer({ echoPort: echo.port, seen })),
        Layer.provide(windowLayer),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
      );
      yield* Effect.gen(function* () {
        const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
        const forward = yield* forwarding.start({
          environmentId: environmentId("env-linked"),
          remotePort: occupied,
        });
        expect(forward.localPort).toBeGreaterThan(occupied);
        expect(yield* tcpRoundTrip(forward.localPort, "hello")).toBe("hello");
        expect(seen).toEqual([
          { url: expect.stringContaining(`port=${occupied}`), token: "secret-token" },
        ]);

        const interfaces = NodeOS.networkInterfaces();
        const external = Object.values(interfaces)
          .flat()
          .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
        if (external !== undefined) {
          expect(yield* tcpRefused(forward.localPort, external.address)).toBe(true);
        }
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.live("reuses the forward already held for the same remote port", () =>
  Effect.gen(function* () {
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    const first = yield* forwarding.start({
      environmentId: environmentId("env-ssh"),
      remotePort: 5432,
    });
    const second = yield* forwarding.start({
      environmentId: environmentId("env-ssh"),
      remotePort: 5432,
    });
    expect(second.id).toBe(first.id);
    expect(yield* forwarding.list).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(serviceLayer({ enabled: true, catalog: sshCatalog() }))),
);

it.live("closes a forward with its environment", () =>
  Effect.gen(function* () {
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    yield* forwarding.start({ environmentId: environmentId("env-ssh"), remotePort: 5432 });
    yield* forwarding.stopEnvironment(environmentId("env-ssh"));
    expect(yield* forwarding.list).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(serviceLayer({ enabled: true, catalog: sshCatalog() }))),
);

it.live("names the per-environment limit", () =>
  Effect.gen(function* () {
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    for (let index = 0; index < PORT_FORWARDING_MAX_FORWARDS_PER_ENVIRONMENT; index += 1) {
      yield* forwarding.start({
        environmentId: environmentId("env-ssh"),
        remotePort: 5000 + index,
      });
    }
    const refused = yield* Effect.flip(
      forwarding.start({ environmentId: environmentId("env-ssh"), remotePort: 6000 }),
    );
    expect(refused.reason).toBe("forward-limit");
    expect(refused.message).toContain(
      `${PORT_FORWARDING_MAX_FORWARDS_PER_ENVIRONMENT} port forwards`,
    );
  }).pipe(Effect.scoped, Effect.provide(serviceLayer({ enabled: true, catalog: sshCatalog() }))),
);

it.live("turning the setting off stops every forward", () =>
  Effect.gen(function* () {
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    const settings = yield* DesktopClientSettings.DesktopClientSettings;
    yield* forwarding.start({ environmentId: environmentId("env-ssh"), remotePort: 5432 });
    yield* settings.set({ ...DEFAULT_CLIENT_SETTINGS, portForwardingEnabled: false });
    yield* forwarding.applySettings(false);
    expect(yield* forwarding.list).toEqual([]);
    const refused = yield* Effect.flip(
      forwarding.start({ environmentId: environmentId("env-ssh"), remotePort: 5432 }),
    );
    expect(refused.reason).toBe("disabled");
  }).pipe(Effect.scoped, Effect.provide(serviceLayer({ enabled: true, catalog: sshCatalog() }))),
);

const tcpEchoServer = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly port: number }>((resume) => {
      const server = NodeNet.createServer((socket) => socket.pipe(socket));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed({
            port: address !== null && typeof address !== "string" ? address.port : 0,
          }),
        );
      });
      return Effect.sync(() => server.close());
    }),
    () => Effect.void,
  );

const occupyPort = () =>
  Effect.callback<number>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resume(Effect.succeed(address !== null && typeof address !== "string" ? address.port : 0));
    });
    return Effect.sync(() => server.close());
  });

const tcpRoundTrip = (port: number, text: string) =>
  Effect.callback<string, Error>((resume) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resume(Effect.fail(new Error("timed out waiting for the forwarded service")));
    }, 5_000);
    socket.once("connect", () => socket.write(text));
    socket.once("data", (data) => {
      clearTimeout(timer);
      socket.destroy();
      resume(Effect.succeed(String(data)));
    });
    socket.once("error", (cause) => {
      clearTimeout(timer);
      resume(Effect.fail(cause));
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      socket.destroy();
    });
  });

const tcpRefused = (port: number, host: string) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection({ host, port });
    const settle = (refused: boolean) => {
      socket.destroy();
      resume(Effect.succeed(refused));
    };
    socket.once("connect", () => settle(false));
    socket.once("error", () => settle(true));
    socket.setTimeout(500, () => settle(true));
    return Effect.sync(() => socket.destroy());
  });

