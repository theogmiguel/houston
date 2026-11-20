import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  PORT_FORWARD_TUNNEL_PATH,
  PORT_FORWARD_TUNNEL_PORT_PARAM,
  PORT_FORWARDING_MAX_PORT,
  PORT_FORWARDING_MAX_TUNNELS,
  PORT_FORWARDING_MIN_PORT,
} from "@houston-app/contracts/houston/portForwarding";
import { AuthPreviewOperateScope } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Socket from "effect/socket/Socket";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../../auth/http.ts";
import { requestUrl } from "../../requestUrl.ts";

const TUNNEL_OPEN_TIMEOUT = "10 seconds";
const TUNNEL_UNAVAILABLE_CLOSE_CODE = 1013;
const TUNNEL_NORMAL_CLOSE_CODE = 1000;

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const readPort = (searchParams: URLSearchParams): Option.Option<number> => {
  const raw = searchParams.get(PORT_FORWARD_TUNNEL_PORT_PARAM) ?? "";
  if (!/^\d{1,5}$/u.test(raw)) return Option.none();
  const port = Number.parseInt(raw, 10);
  return port >= PORT_FORWARDING_MIN_PORT && port <= PORT_FORWARDING_MAX_PORT
    ? Option.some(port)
    : Option.none();
};

const pump = /* Frames move continuously; a span per chunk adds no diagnostic value. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const closeWith = (writer: Socket.Writer, code: number, reason: string) =>
  writer.write(new Socket.CloseEvent(code, reason)).pipe(Effect.ignore);

const connectedTunnel = Effect.fnUntraced(function* (input: {
  readonly port: number;
  readonly client: Socket.Socket;
}) {
  const target = yield* NodeSocket.makeNet({
    host: "127.0.0.1",
    port: input.port,
    openTimeout: TUNNEL_OPEN_TIMEOUT,
  });
  const clientWriter = yield* input.client.writer;
  const targetWriter = yield* target.writer;
  yield* Effect.raceFirst(pump(target, clientWriter), pump(input.client, targetWriter)).pipe(
    Effect.catchCause(() =>
      closeWith(clientWriter, TUNNEL_UNAVAILABLE_CLOSE_CODE, "service closed"),
    ),
    Effect.ensuring(closeWith(clientWriter, TUNNEL_NORMAL_CLOSE_CODE, "closed")),
  );
});

const makeHandler = (input: {
  readonly openTunnels: Ref.Ref<number>;
  readonly maxTunnels: number;
}) =>
  Effect.fnUntraced(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!isWebSocketUpgrade(request)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const url = requestUrl(request);
    const port = Option.isSome(url)
      ? readPort(url.value.searchParams)
      : Option.none<number>();
    if (Option.isNone(port)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    yield* authenticateMediaRequest(AuthPreviewOperateScope);
    const admitted = yield* Ref.modify(input.openTunnels, (open) =>
      open >= input.maxTunnels ? [false, open] : [true, open + 1],
    );
    if (!admitted) {
      return HttpServerResponse.text(
        `This environment already carries ${input.maxTunnels} forwarded connections.`,
        { status: 429 },
      );
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Ref.update(input.openTunnels, (open) => Math.max(0, open - 1)),
        );
        const client = yield* request.upgrade;
        yield* connectedTunnel({ port: port.value, client });
        return HttpServerResponse.empty();
      }),
    );
  });

export const makeRouteLayer = (options: { readonly maxTunnels?: number } = {}) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const openTunnels = yield* Ref.make(0);
      yield* router.add(
        "GET",
        PORT_FORWARD_TUNNEL_PATH,
        makeHandler({
          openTunnels,
          maxTunnels: options.maxTunnels ?? PORT_FORWARDING_MAX_TUNNELS,
        }),
      );
    }),
  );

export const routeLayer = makeRouteLayer();
