import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import { makeInMemoryStdio } from "./_internal/stdio.ts";
import * as CodexProtocol from "./protocol.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const recordingTracer = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

const firstRequest = (propagate: boolean) =>
  Effect.gen(function* () {
    const { spans, tracer } = recordingTracer();
    const { stdio, output } = yield* makeInMemoryStdio();
    const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });
    yield* transport
      .request("thread/start", {})
      .pipe(
        Effect.provideService(CodexProtocol.PropagateTraceContext, propagate),
        Effect.withTracer(tracer),
        Effect.forkScoped,
      );
    const message = (yield* decodeJson(yield* Queue.take(output))) as {
      readonly trace?: { readonly traceparent: string };
    };
    const span = spans.find((candidate) => candidate.name === "CodexAppServerProtocol.request");
    return { message, span };
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "effect-codex-app-server trace context",
  (it) => {
    it.effect("a request carries the current request span as traceparent while enabled", () =>
      Effect.gen(function* () {
        const { message, span } = yield* firstRequest(true);
        assert.isDefined(span);
        assert.deepStrictEqual(message.trace, {
          traceparent: `00-${span!.traceId.padStart(32, "0")}-${span!.spanId}-01`,
        });
      }),
    );

    it.effect("a request carries no trace context while disabled", () =>
      Effect.gen(function* () {
        const { message } = yield* firstRequest(false);
        assert.isFalse("trace" in message);
      }),
    );
  },
);
