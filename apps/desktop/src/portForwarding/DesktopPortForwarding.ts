import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { ConnectionCatalogDocument, catalogRoutes } from "@houston-app/client-runtime/platform";
import type { ConnectionProfile } from "@houston-app/client-runtime/connection";
import {
  PORT_FORWARD_TUNNEL_PATH,
  PORT_FORWARD_TUNNEL_PORT_PARAM,
  PORT_FORWARDING_LOCAL_PORT_WINDOW,
  PORT_FORWARDING_MAX_CONNECTIONS_PER_FORWARD,
  PORT_FORWARDING_MAX_FORWARDS,
  PORT_FORWARDING_MAX_FORWARDS_PER_ENVIRONMENT,
  PORT_FORWARDING_MAX_PORT,
  PORT_FORWARDING_MAX_TUNNELS,
  PortForwardingError,
  type PortForward,
  type PortForwardStartInput,
  type PortForwardStopInput,
} from "@houston-app/contracts/houston/portForwarding";
import type { EnvironmentId } from "@houston-app/contracts";
import type { DesktopSshEnvironmentTarget } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import * as NetService from "@houston-app/shared/Net";
import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import { isSshLocalForwardBindFailure as isSshBindFailure } from "@houston-app/ssh/tunnel";

export const PORT_FORWARD_BIND_HOST = "127.0.0.1";
const PORT_FORWARDING_SETTINGS_PATH = "Settings → Connections → Port forwarding";

const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCatalogDocument));

const isSshProfile = (
  profile: ConnectionProfile,
): profile is Extract<ConnectionProfile, { readonly _tag: "SshConnectionProfile" }> =>
  profile._tag === "SshConnectionProfile";

const isBearerProfile = (
  profile: ConnectionProfile,
): profile is Extract<ConnectionProfile, { readonly _tag: "BearerConnectionProfile" }> =>
  profile._tag === "BearerConnectionProfile";

/** Opens the environment side of a forward. The real layer uses the authenticated tunnel. */
export class PortForwardTransportError extends Schema.TaggedError<PortForwardTransportError>()(
  "PortForwardTransportError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The environment's tunnel could not be opened.";
  }
}

export class PortForwardTunnelTransport extends Context.Service<
  PortForwardTunnelTransport,
  {
    readonly connect: (input: {
      readonly url: string;
      readonly token: string;
    }) => Effect.Effect<Socket.Socket, PortForwardTransportError, Scope.Scope>;
  }
>()("@houston-app/desktop/portForwarding/DesktopPortForwarding/PortForwardTunnelTransport") {}

interface ActiveForward {
  readonly record: PortForward;
  readonly scope: Scope.Closeable;
  readonly connections: Ref.Ref<number>;
  readonly sshTargetKey: string | null;
}

export class DesktopPortForwarding extends Context.Service<
  DesktopPortForwarding,
  {
    readonly list: Effect.Effect<ReadonlyArray<PortForward>>;
    readonly changes: Stream.Stream<ReadonlyArray<PortForward>>;
    readonly start: (
      input: PortForwardStartInput,
    ) => Effect.Effect<PortForward, PortForwardingError>;
    readonly stop: (input: PortForwardStopInput) => Effect.Effect<void>;
    readonly stopEnvironment: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly stopSshTarget: (targetKey: string) => Effect.Effect<void>;
    /** Off stops every forward; on lets a user action start a new one. */
    readonly applySettings: (portForwardingEnabled: boolean) => Effect.Effect<void>;
  }
>()("@houston-app/desktop/portForwarding/DesktopPortForwarding") {}

const pump =
  /* Frames move continuously; a span per chunk adds no diagnostic value. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const closeSocket = Effect.fn("desktop.portForwarding.closeSocket")(function* (
  socket: Socket.Socket,
  reason: string,
) {
  const writer = yield* socket.writer;
  yield* writer.write(new Socket.CloseEvent(1000, reason));
});

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const sshTargetKeyOf = (target: DesktopSshEnvironmentTarget): string =>
  `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}`;

const remoteTunnelUrl = (profile: ConnectionProfile, port: number): string | null => {
  if (!isBearerProfile(profile)) return null;
  const origin = URL.parse(profile.wsBaseUrl)?.origin;
  if (origin === undefined) return null;
  const url = new URL(PORT_FORWARD_TUNNEL_PATH, origin);
  url.searchParams.set(PORT_FORWARD_TUNNEL_PORT_PARAM, String(port));
  return url.toString();
};

const localPortWindowEnd = (port: number) =>
  Math.min(PORT_FORWARDING_MAX_PORT, port + PORT_FORWARDING_LOCAL_PORT_WINDOW);

const make = Effect.gen(function* () {
  const settings = yield* DesktopClientSettings.DesktopClientSettings;
  const random = yield* SecureRandom.SecureRandom;
  const catalog = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
  const net = yield* NetService.NetService;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const transport = yield* PortForwardTunnelTransport;

  const forwards = yield* Ref.make<ReadonlyMap<string, ActiveForward>>(new Map());
  const changes = yield* PubSub.unbounded<ReadonlyArray<PortForward>>();
  const lock = yield* Semaphore.make(1);

  const snapshot = Ref.get(forwards).pipe(
    Effect.map((current) => [...current.values()].map((entry) => entry.record)),
  );

  const publish = Effect.gen(function* () {
    const records = yield* snapshot;
    yield* PubSub.publish(changes, records);
    yield* electronWindow
      .sendAll(IpcChannels.PORT_FORWARDS_CHANGED_CHANNEL, records)
      .pipe(Effect.ignoreCause);
  });

  const readCatalog = Effect.gen(function* () {
    const raw = yield* catalog.get.pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(raw)) return null;
    const decoded = decodeCatalog(raw.value);
    return Option.isSome(decoded) ? decoded.value : null;
  });

  const enabled = Effect.gen(function* () {
    const current = yield* settings.get.pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.match(current, {
      onNone: () => true,
      onSome: (value) => value.portForwardingEnabled,
    });
  });

  const forbidden = (reason: PortForwardingError["reason"], message: string) =>
    new PortForwardingError({ reason, message });

  const stopEntry = (entry: ActiveForward) =>
    Scope.close(entry.scope, Exit.void).pipe(Effect.ignoreCause);

  const removeAndStop = Effect.fn("desktop.portForwarding.removeAndStop")(function* (
    predicate: (entry: ActiveForward) => boolean,
  ) {
    const removed = yield* Ref.modify(forwards, (current) => {
      const next = new Map(current);
      const gone: ActiveForward[] = [];
      for (const [id, entry] of current) {
        if (!predicate(entry)) continue;
        next.delete(id);
        gone.push(entry);
      }
      return [gone, next] as const;
    });
    if (removed.length === 0) return;
    yield* Effect.forEach(removed, stopEntry, { concurrency: "unbounded", discard: true });
    yield* publish;
  });

  const stop: DesktopPortForwarding["Service"]["stop"] = (input) =>
    lock.withPermits(1)(removeAndStop((entry) => entry.record.id === input.id).pipe(Effect.asVoid));

  const stopEnvironment: DesktopPortForwarding["Service"]["stopEnvironment"] = (environmentId) =>
    lock.withPermits(1)(
      removeAndStop((entry) => entry.record.environmentId === environmentId).pipe(Effect.asVoid),
    );

  const stopSshTarget: DesktopPortForwarding["Service"]["stopSshTarget"] = (targetKey) =>
    lock.withPermits(1)(
      removeAndStop((entry) => entry.sshTargetKey === targetKey).pipe(Effect.asVoid),
    );

  const applySettings: DesktopPortForwarding["Service"]["applySettings"] = (enabledNow) =>
    enabledNow ? Effect.void : lock.withPermits(1)(removeAndStop(() => true).pipe(Effect.asVoid));

  const recordForwardError = Effect.fn("desktop.portForwarding.recordForwardError")(function* (
    id: string,
    error: string,
  ) {
    yield* Ref.update(forwards, (current) => {
      const entry = current.get(id);
      if (entry === undefined) return current;
      const next = new Map(current);
      next.set(id, { ...entry, record: { ...entry.record, error } });
      return next;
    });
    yield* publish;
  });

  const recordConnectionLimit = (id: string) =>
    recordForwardError(
      id,
      `A browser request was refused: this forward already carries ${PORT_FORWARDING_MAX_CONNECTIONS_PER_FORWARD} connections.`,
    );

  const bindLinkedPort = Effect.fn("desktop.portForwarding.bindLinkedPort")(function* (input: {
    readonly preferredPort: number;
    readonly entry: ActiveForward;
    readonly tunnelUrl: string;
    readonly token: string;
  }) {
    for (
      let candidate = input.preferredPort;
      candidate <= localPortWindowEnd(input.preferredPort);
      candidate += 1
    ) {
      if (!(yield* net.canListenOnHost(candidate, PORT_FORWARD_BIND_HOST))) continue;
      const bound = yield* NodeSocketServer.make({
        host: PORT_FORWARD_BIND_HOST,
        port: candidate,
      }).pipe(Effect.provideService(Scope.Scope, input.entry.scope), Effect.option);
      if (Option.isNone(bound)) continue;
      const server = bound.value;
      yield* server
        .run((client) =>
          Effect.gen(function* () {
            const open = yield* Ref.modify(input.entry.connections, (count) =>
              count >= PORT_FORWARDING_MAX_CONNECTIONS_PER_FORWARD
                ? [false, count]
                : [true, count + 1],
            );
            if (!open) {
              yield* closeSocket(
                client,
                `This forward already carries ${PORT_FORWARDING_MAX_CONNECTIONS_PER_FORWARD} connections.`,
              );
              yield* recordConnectionLimit(input.entry.record.id);
              return;
            }
            yield* Effect.acquireRelease(Effect.void, () =>
              Ref.update(input.entry.connections, (count) => Math.max(0, count - 1)),
            );
            const remote = yield* transport
              .connect({ url: input.tunnelUrl, token: input.token })
              .pipe(Effect.option);
            if (Option.isNone(remote)) {
              yield* closeSocket(client, "The environment refused the forwarded connection.");
              yield* recordForwardError(
                input.entry.record.id,
                `A forwarded connection was refused. The environment may not support port forwarding, or it already holds ${PORT_FORWARDING_MAX_TUNNELS} tunnels.`,
              );
              return;
            }
            const clientWriter = yield* client.writer;
            const remoteWriter = yield* remote.value.writer;
            yield* Effect.raceFirst(
              pump(remote.value, clientWriter),
              pump(client, remoteWriter),
            ).pipe(Effect.ignoreCause);
          }).pipe(Effect.scoped, Effect.ignoreCause),
        )
        .pipe(Effect.forkIn(input.entry.scope));
      return server;
    }
    return null;
  });

  const startSshForward = Effect.fn("desktop.portForwarding.startSshForward")(function* (input: {
    readonly remotePort: number;
    readonly target: DesktopSshEnvironmentTarget;
    readonly entry: ActiveForward;
  }) {
    let failure: unknown = null;
    for (
      let candidate = input.remotePort;
      candidate <= localPortWindowEnd(input.remotePort);
      candidate += 1
    ) {
      const result = yield* ssh
        .forwardPort({
          target: input.target,
          remotePort: input.remotePort,
          localPort: candidate,
        })
        .pipe(Effect.provideService(Scope.Scope, input.entry.scope), Effect.result);
      if (result._tag === "Success") return candidate;
      failure = result.failure;
      if (!isSshBindFailure(result.failure)) break;
    }
    return yield* Effect.fail(failure ?? new Error("SSH port forward failed."));
  });

  const start: DesktopPortForwarding["Service"]["start"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* enabled)) {
          return yield* forbidden(
            "disabled",
            `Port forwarding is off. Turn it on in ${PORT_FORWARDING_SETTINGS_PATH} before forwarding port ${input.remotePort}.`,
          );
        }
        const document = yield* readCatalog;
        if (document === null) {
          return yield* forbidden(
            "unknown-environment",
            `No saved environments could be read, so port ${input.remotePort} cannot be forwarded.`,
          );
        }
        const routes = catalogRoutes(document, input.environmentId);
        if (routes.length === 0) {
          return yield* forbidden(
            "unknown-environment",
            `${input.environmentId} is not a saved remote environment on this device, so port ${input.remotePort} cannot be forwarded.`,
          );
        }
        const active = [...(yield* Ref.get(forwards)).values()];
        const existing = active.find(
          (entry) =>
            entry.record.environmentId === input.environmentId &&
            entry.record.remotePort === input.remotePort,
        );
        if (existing !== undefined) return existing.record;
        if (active.length >= PORT_FORWARDING_MAX_FORWARDS) {
          return yield* forbidden(
            "forward-limit",
            `This device already holds ${PORT_FORWARDING_MAX_FORWARDS} port forwards. Stop one before forwarding port ${input.remotePort}.`,
          );
        }
        const environmentForwards = active.filter(
          (entry) => entry.record.environmentId === input.environmentId,
        );
        if (environmentForwards.length >= PORT_FORWARDING_MAX_FORWARDS_PER_ENVIRONMENT) {
          return yield* forbidden(
            "forward-limit",
            `${environmentForwards[0]?.record.environmentLabel ?? input.environmentId} already has ${PORT_FORWARDING_MAX_FORWARDS_PER_ENVIRONMENT} port forwards. Stop one before forwarding port ${input.remotePort}.`,
          );
        }
        const target = routes[0]!;
        const connectionId =
          target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
            ? target.connectionId
            : null;
        const profile =
          connectionId === null
            ? undefined
            : document.profiles.find((entry) => entry.connectionId === connectionId);
        if (profile === undefined) {
          return yield* forbidden(
            "missing-credential",
            `${target.label} has no saved connection, so port ${input.remotePort} cannot be forwarded. Reconnect the environment.`,
          );
        }
        const entryScope = yield* Scope.make("sequential");
        const connections = yield* Ref.make(0);
        const sshTargetKey = isSshProfile(profile) ? sshTargetKeyOf(profile.target) : null;
        const provisional: ActiveForward = {
          record: {
            id: Hex.encode(yield* random.randomBytes(16)),
            environmentId: input.environmentId,
            environmentLabel: target.label,
            transport: isSshProfile(profile) ? "ssh" : "linked",
            remotePort: input.remotePort,
            localPort: input.remotePort,
            state: "active",
            error: null,
          },
          scope: entryScope,
          connections,
          sshTargetKey,
        };

        let localPort: number | null = null;
        if (isSshProfile(profile)) {
          localPort = yield* startSshForward({
            remotePort: input.remotePort,
            target: profile.target,
            entry: provisional,
          }).pipe(
            Effect.mapError((cause) =>
              forbidden(
                "transport-failed",
                `Could not forward port ${input.remotePort} of ${target.label}: ${errorMessage(cause)}`,
              ),
            ),
            Effect.tapError(() => Scope.close(entryScope, Exit.void).pipe(Effect.ignoreCause)),
          );
        } else if (isBearerProfile(profile)) {
          const credential = document.credentials.find(
            (entry) => entry.connectionId === profile.connectionId,
          );
          const tunnelUrl = remoteTunnelUrl(profile, input.remotePort);
          if (
            credential === undefined ||
            credential.credential._tag !== "BearerConnectionCredential" ||
            tunnelUrl === null
          ) {
            yield* Scope.close(entryScope, Exit.void).pipe(Effect.ignoreCause);
            return yield* forbidden(
              "missing-credential",
              `${target.label} has no saved credential or tunnel address, so port ${input.remotePort} cannot be forwarded. Reconnect the environment.`,
            );
          }
          localPort = yield* bindLinkedPort({
            preferredPort: input.remotePort,
            entry: provisional,
            tunnelUrl,
            token: credential.credential.token,
          }).pipe(
            Effect.map((server) =>
              server === null
                ? null
                : server.address._tag === "InetAddressV4"
                  ? server.address.port
                  : null,
            ),
            Effect.mapError((cause) =>
              forbidden(
                "transport-failed",
                `Could not forward port ${input.remotePort} of ${target.label}: ${errorMessage(cause)}`,
              ),
            ),
          );
          if (localPort === null) {
            yield* Scope.close(entryScope, Exit.void).pipe(Effect.ignoreCause);
            return yield* forbidden(
              "local-port-unavailable",
              `No free local port for remote port ${input.remotePort} of ${target.label}. Tried 127.0.0.1 ports ${input.remotePort}-${localPortWindowEnd(input.remotePort)}.`,
            );
          }
        } else {
          yield* Scope.close(entryScope, Exit.void).pipe(Effect.ignoreCause);
          return yield* forbidden(
            "unsupported-environment",
            `${target.label} does not offer an SSH or linked connection this device can forward through.`,
          );
        }

        const record: PortForward = {
          ...provisional.record,
          localPort: localPort ?? input.remotePort,
        };
        const entry: ActiveForward = { ...provisional, record };
        yield* Ref.update(forwards, (current) => new Map(current).set(record.id, entry));
        yield* publish;
        yield* Effect.logInfo("desktop.portForwarding.started", {
          environmentId: record.environmentId,
          remotePort: record.remotePort,
          localPort: record.localPort,
          transport: record.transport,
        });
        return record;
      }),
    );

  yield* Effect.addFinalizer(() =>
    lock.withPermits(1)(removeAndStop(() => true).pipe(Effect.asVoid, Effect.ignoreCause)),
  );

  return DesktopPortForwarding.of({
    list: snapshot,
    changes: Stream.fromPubSub(changes),
    start,
    stop,
    stopEnvironment,
    stopSshTarget,
    applySettings,
  });
});

export const transportLayer = Layer.effect(
  PortForwardTunnelTransport,
  Effect.gen(function* () {
    const webSocketConstructor = yield* Socket.WebSocketConstructor.pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    );
    return PortForwardTunnelTransport.of({
      connect: Effect.fn("desktop.portForwarding.transport.connect")(function* (input) {
        return yield* Socket.makeWebSocket(input.url, {
          openTimeout: "10 seconds",
          headers: { authorization: `Bearer ${input.token}` },
        }).pipe(
          Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
          Effect.mapError((cause) => new PortForwardTransportError({ cause })),
        );
      }),
    });
  }),
);

export const layer = Layer.effect(DesktopPortForwarding, make);
