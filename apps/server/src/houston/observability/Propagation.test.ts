import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";

import {
  makeRpcInstrumentationLayer,
  RPC_SPANS_UNSAMPLED,
  RpcInstrumentation,
} from "../../observability/RpcInstrumentation.ts";
import * as RecordingTracer from "../../observability/testing/RecordingTracer.ts";
import { WS_RPC_SERVER_OPTIONS } from "../../ws.ts";
import { propagatesTo, withPrivatePropagation } from "./OutgoingTraceContext.ts";
import * as UnsampledSpans from "./UnsampledSpans.ts";

const Ping = Rpc.make("ping", { success: Schema.String });
const Group = RpcGroup.make(Ping).middleware(RpcInstrumentation);

const layerHandlers = Group.toLayer({
  ping: () => Effect.succeed("pong").pipe(Effect.withSpan("Ping.handle")),
});

// The server options ws.ts uses, over an in-memory transport.
const makeClient = Effect.gen(function* () {
  const toClient: { write: (response: never) => Effect.Effect<void> } = {
    write: () => Effect.void,
  };
  const server = yield* RpcServer.makeNoSerialization(Group, {
    ...WS_RPC_SERVER_OPTIONS,
    onFromServer: (response) => toClient.write(response as never),
  });
  const client = yield* RpcClient.makeNoSerialization(Group, {
    supportsAck: true,
    onFromClient: ({ message }) => server.write(0, message),
  });
  toClient.write = client.write as (response: never) => Effect.Effect<void>;
  return client.client as unknown as { readonly ping: () => Effect.Effect<string> };
});

describe("WS RPC trace context", () => {
  it.effect("a client span becomes the parent of the server's ws.rpc span", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      const client = yield* makeClient;
      yield* client.ping().pipe(Effect.withSpan("ui.click"), Effect.withTracer(recording.tracer));

      const clientSpan = recording.named("ping").find((span) => span.kind === "client")!;
      const serverSpan = recording.named("ws.rpc.ping")[0]!;
      assert.isDefined(clientSpan);
      assert.isDefined(serverSpan);
      assert.strictEqual(serverSpan.kind, "server");
      assert.strictEqual(serverSpan.traceId, clientSpan.traceId);
      assert.strictEqual(Option.getOrUndefined(serverSpan.parent)?.spanId, clientSpan.spanId);
      assert.strictEqual(serverSpan.attributes.get("houston.client.kind"), "web");
      assert.strictEqual(serverSpan.attributes.get("rpc.transport"), "websocket");
      const handler = recording.named("Ping.handle")[0]!;
      assert.strictEqual(Option.getOrUndefined(handler.parent)?.spanId, serverSpan.spanId);
      assert.strictEqual(handler.attributes.get("houston.client.kind"), "web");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerHandlers, makeRpcInstrumentationLayer({ clientKind: "web" })),
      ),
    ),
  );

  it.effect("diagnostics calls and everything below them stay unsampled", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      const [name] = [...RPC_SPANS_UNSAMPLED];
      yield* Effect.void.pipe(
        Effect.withSpan("ProcessDiagnostics.read"),
        Effect.withSpan(name!),
        Effect.withTracer(UnsampledSpans.make(recording.tracer, RPC_SPANS_UNSAMPLED)),
      );
      assert.deepStrictEqual(
        recording.ended.map((span) => [span.name, span.sampled]),
        [
          ["ProcessDiagnostics.read", false],
          [name, false],
        ],
      );
    }),
  );
});

describe("outgoing HTTP trace context", () => {
  it("propagates only to this machine and private networks", () => {
    for (const url of [
      "http://localhost:4096/session",
      "http://127.0.0.1:3773/api",
      "http://[::1]:4318/v1/traces",
      "http://192.168.1.20:3773/ws",
      "http://10.0.0.5/",
      "http://172.20.0.1/",
      "http://100.101.102.103:3773/",
      // Unique local (fc00::/7) and link-local (fe80::/10) IPv6, by their first 7 and 10 bits.
      "http://[fc00::1]/",
      "http://[fcde:1::2]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[febf:ffff::1]/",
      "http://[0:0:0:0:0:0:0:1]/",
      // Hosts fetch resolves to loopback through its URL parser.
      "http://0x7f000001:3773/",
      "http://127.1:3773/",
      "http://localhost.:3773/",
    ]) {
      assert.isTrue(propagatesTo(url), url);
    }
    for (const url of [
      "https://api.github.com/repos/a/b",
      "https://slack.com/api/chat.postMessage",
      "https://api.notion.com/v1/pages",
      "https://registry.npmjs.org/houston",
      "https://fd.example.com/",
      "http://172.32.0.1/",
      "not a url",
      // fetch connects to evil.com: a backslash ends the authority, so 127.0.0.1 is not the host.
      "http://evil.com\\@127.0.0.1/x",
      "http://evil.com\\@localhost/x",
      "http://user:pass@evil.com/",
      "http://127.0.0.1.evil.com/",
      "http://localhost.evil.com/",
      "http://[::ffff:8.8.8.8]/",
      // Names are not addresses: Funnel serves tailnet names publicly, and DNS or unicast
      // resolution can send *.localhost and *.local anywhere.
      "https://desk.tail1234.ts.net/",
      "http://studio.local:3773/",
      "http://app.localhost:3773/",
      "http://localhost.local/",
      // A short first hextet is not the prefix: fc::1 is 00fc::1.
      "http://[fc::1]/",
      "http://[fd::1]/",
      "http://[fe8::1]/",
      "http://[fec0::1]/",
      "http://[ff02::1]/",
      "http://[2001:db8::1]/",
      "http://[::2]/",
      "http://fc00/",
      "http://fd.local/",
      // IPv4-mapped loopback is not recognised; missing a private host only drops the headers.
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      assert.isFalse(propagatesTo(url), url);
    }
  });

  it.effect("sends traceparent to a private host and not to GitHub", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      const sent: Array<Record<string, string>> = [];
      const base = HttpClient.make((request) =>
        Effect.sync(() => {
          sent.push({ ...request.headers });
          return HttpClientResponse.fromWeb(request, new Response(""));
        }),
      );
      const client = withPrivatePropagation(base);
      yield* client.get("http://127.0.0.1:4096/session").pipe(Effect.withTracer(recording.tracer));
      yield* client.get("https://api.github.com/user").pipe(Effect.withTracer(recording.tracer));
      yield* client.get("http://evil.com\\@127.0.0.1/x").pipe(Effect.withTracer(recording.tracer));

      assert.property(sent[0], "traceparent");
      for (const headers of sent.slice(1)) {
        assert.notProperty(headers, "traceparent");
        assert.notProperty(headers, "b3");
      }
      assert.lengthOf(sent, 3);
    }),
  );
});
