// @effect-diagnostics nodeBuiltinImport:off -- the tunnel test drives a real loopback TCP service.
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeNet from "node:net";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@houston-app/contracts";
import { PORT_FORWARD_TUNNEL_PATH } from "@houston-app/contracts/houston/portForwarding";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { makeRouteLayer } from "./PortForwardTunnel.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const makeAuth = (scopes: ReadonlyArray<AuthEnvironmentScope>) => {
  const uses: string[] = [];
  const layer = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateWebSocketUpgrade: (_request, use) => {
      uses.push(use);
      return Effect.succeed({
        sessionId: AuthSessionId.make("tunnel-test"),
        subject: "tunnel-test",
        method: "bearer-access-token",
        scopes,
      });
    },
  });
  return { layer, uses };
};

const echoServer = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly sockets: Set<NodeNet.Socket> }>((resume) => {
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.pipe(socket);
      });
      server.once("error", (cause) => resume(Effect.die(cause)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.die(new Error("expected an IPv4 listener")));
          return;
        }
        resume(Effect.succeed({ port: address.port, sockets }));
      });
      return Effect.sync(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
      });
    }),
    (value) => Effect.sync(() => value.sockets.clear()),
  );

const serveTunnel = (auth: ReturnType<typeof makeAuth>, maxTunnels?: number) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(makeRouteLayer(maxTunnels === undefined ? {} : { maxTunnels }).pipe(Layer.provide(platformLayer)), {
        disableListenLog: true,
      }).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(auth.layer)),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    return { origin: HttpServer.formatAddress(server.address).replace(/^http/, "ws") };
  });

const openSocket = (origin: string, path: string) =>
  Effect.callback<WebSocket, Error>((resume) => {
    const socket = new WebSocket(`${origin}${path}`);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      socket.close();
      resume(Effect.fail(new Error(`timed out opening ${path}`)));
    }, 5_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resume(Effect.succeed(socket));
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        socket.close();
        resume(Effect.fail(new Error(`failed to open ${path}`)));
      },
      { once: true },
    );
    return Effect.sync(() => {
      clearTimeout(timer);
      socket.close();
    });
  });

const echoRoundTrip = (socket: WebSocket, payload: Uint8Array) =>
  Effect.callback<Uint8Array, Error>((resume) => {
    const timer = setTimeout(() => {
      socket.close();
      resume(Effect.fail(new Error("timed out waiting for the echo")));
    }, 5_000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        if (event.data instanceof ArrayBuffer) {
          resume(Effect.succeed(new Uint8Array(event.data)));
          return;
        }
        resume(Effect.fail(new Error("expected binary echo data")));
      },
      { once: true },
    );
    socket.send(payload);
    return Effect.sync(() => clearTimeout(timer));
  });

it.live("carries bytes to a service on the environment's loopback", () =>
  Effect.gen(function* () {
    const auth = makeAuth([AuthOrchestrationOperateScope, AuthPreviewOperateScope]);
    const tunnel = yield* serveTunnel(auth);
    const service = yield* echoServer();
    const socket = yield* Effect.acquireRelease(
      openSocket(
        tunnel.origin,
        `${PORT_FORWARD_TUNNEL_PATH}?port=${service.port}`,
      ),
      (socket) => Effect.sync(() => socket.close()),
    );
    const echoed = yield* echoRoundTrip(socket, new Uint8Array([1, 2, 3, 4]));
    expect([...echoed]).toEqual([1, 2, 3, 4]);
    expect(auth.uses).toEqual(["media"]);
  }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
);

it.live("refuses a forward without the preview operate scope", () =>
  Effect.gen(function* () {
    const auth = makeAuth([AuthOrchestrationOperateScope]);
    const tunnel = yield* serveTunnel(auth);
    const service = yield* echoServer();
    const opened = yield* Effect.exit(
      openSocket(tunnel.origin, `${PORT_FORWARD_TUNNEL_PATH}?port=${service.port}`),
    );
    expect(opened._tag).toBe("Failure");
  }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
);

it.live("closes a tunnel whose service is not listening", () =>
  Effect.gen(function* () {
    const auth = makeAuth([AuthPreviewOperateScope]);
    const tunnel = yield* serveTunnel(auth);
    const closed = yield* Effect.callback<number | null>((resume) => {
      const socket = new WebSocket(
        `${tunnel.origin}${PORT_FORWARD_TUNNEL_PATH}?port=1`,
      );
      socket.addEventListener("close", (event) => resume(Effect.succeed(event.code)), {
        once: true,
      });
      socket.addEventListener("error", () => resume(Effect.succeed(null)), { once: true });
      return Effect.sync(() => socket.close());
    });
    expect(closed).not.toBeNull();
  }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
);

it.live("bounds the tunnels one environment carries", () =>
  Effect.gen(function* () {
    const auth = makeAuth([AuthPreviewOperateScope]);
    const tunnel = yield* serveTunnel(auth, 1);
    const service = yield* echoServer();
    const sockets = yield* Effect.forEach(
      Array.from({ length: 1 }, () =>
        openSocket(tunnel.origin, `${PORT_FORWARD_TUNNEL_PATH}?port=${service.port}`),
      ),
      (effect) => Effect.acquireRelease(effect, (socket) => Effect.sync(() => socket.close())),
    );
    expect(sockets).toHaveLength(1);
    const refused = yield* Effect.exit(
      openSocket(tunnel.origin, `${PORT_FORWARD_TUNNEL_PATH}?port=${service.port}`),
    );
    expect(refused._tag).toBe("Failure");
  }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
);
