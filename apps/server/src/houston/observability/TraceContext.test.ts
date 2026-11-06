import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  makeRpcInstrumentationLayer,
  RpcInstrumentation,
} from "../../observability/RpcInstrumentation.ts";
import * as RecordingTracer from "../../observability/testing/RecordingTracer.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as TraceContext from "./TraceContext.ts";

const COMMAND = {
  commandId: "command-1",
  commandType: "thread.turn.start",
  threadId: "thread-1",
} as const;

const EXPECTED = {
  "houston.command.id": "command-1",
  "houston.command.type": "thread.turn.start",
  "houston.thread.id": "thread-1",
};

const contextOf = (attributes: ReadonlyMap<string, unknown>) =>
  Object.fromEntries([...attributes].filter(([key]) => key.startsWith("houston.")));

describe("TraceContext", () => {
  it.effect("reaches the current span, child spans, forked fibers, SQL spans and logs", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      const logged: Array<unknown> = [];
      const sql = yield* SqlClient.SqlClient;

      yield* Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.withSpan("Child.work"));
        const forked = yield* Effect.forkChild(Effect.void.pipe(Effect.withSpan("Forked.work")));
        yield* Fiber.join(forked);
        yield* sql`SELECT 1`;
        yield* Effect.logInfo("dispatched");
      }).pipe(
        TraceContext.withTraceContext(COMMAND),
        Effect.withSpan("ws.rpc.dispatch"),
        Effect.withTracer(recording.tracer),
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              logged.push(options.fiber.getRef(References.CurrentLogAnnotations));
            }),
          ]),
        ),
      );

      const names = recording.ended.map((span) => span.name);
      assert.includeMembers(names, ["ws.rpc.dispatch", "Child.work", "Forked.work"]);
      const sqlSpans = recording.ended.filter((span) => span.attributes.has("db.query.text"));
      assert.isAbove(sqlSpans.length, 0);
      for (const span of recording.ended) {
        assert.deepStrictEqual(contextOf(span.attributes), EXPECTED, span.name);
      }
      assert.deepStrictEqual(logged, [EXPECTED]);
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("withinTraceContext leaves the enclosing span untouched", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      yield* Effect.void.pipe(
        Effect.withSpan("OrchestrationEffectExecutorV2.execute"),
        TraceContext.withinTraceContext({
          threadId: "thread-1",
          effectType: "provider-turn.start",
        }),
        Effect.withSpan("EffectWorker.drain"),
        Effect.withTracer(recording.tracer),
      );
      assert.deepStrictEqual(contextOf(recording.named("EffectWorker.drain")[0]!.attributes), {});
      assert.deepStrictEqual(
        contextOf(recording.named("OrchestrationEffectExecutorV2.execute")[0]!.attributes),
        { "houston.thread.id": "thread-1", "houston.effect.type": "provider-turn.start" },
      );
    }),
  );

  it.effect("withoutTurnContext keeps only the provider and no links for a fork", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      const logged: Array<unknown> = [];
      yield* Effect.gen(function* () {
        const session = yield* Effect.logInfo("session").pipe(
          Effect.withSpan("Session.read"),
          TraceContext.withoutTurnContext,
          Effect.forkChild,
        );
        yield* Fiber.join(session);
      }).pipe(
        TraceContext.withTraceContext({
          ...COMMAND,
          runId: "run-1",
          turnId: "turn-1",
          effectType: "provider-turn.start",
          projectId: "project-1",
          model: "gpt-5",
          provider: "codex",
          clientKind: "desktop",
          clientId: 7,
          jobName: "scheduled-task",
          jobId: "job-1",
          delegated: true,
          subagent: false,
        }),
        Effect.linkSpans(Tracer.externalSpan({ traceId: "a".repeat(32), spanId: "b".repeat(16) })),
        Effect.withTracer(recording.tracer),
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              logged.push(options.fiber.getRef(References.CurrentLogAnnotations));
            }),
          ]),
        ),
      );
      const expected = { "houston.provider": "codex" };
      const span = recording.named("Session.read")[0]!;
      assert.deepStrictEqual(contextOf(span.attributes), expected);
      assert.deepStrictEqual(span.links, []);
      assert.deepStrictEqual(logged, [expected]);
    }),
  );

  it.effect("withoutTurnContext starts a fork's spans in a trace of their own", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      yield* Effect.gen(function* () {
        const session = yield* Effect.void.pipe(
          Effect.withSpan("Session.read"),
          TraceContext.withoutTurnContext,
          Effect.forkChild,
        );
        yield* Fiber.join(session);
      }).pipe(Effect.withSpan("Turn1.root"), Effect.withTracer(recording.tracer));
      const root = recording.named("Turn1.root")[0]!;
      const session = recording.named("Session.read")[0]!;
      assert.isTrue(Option.isNone(session.parent));
      assert.notStrictEqual(session.traceId, root.traceId);
    }),
  );

  it.effect("currentThreadContext reads the thread's fields and nothing of the turn", () =>
    Effect.gen(function* () {
      const context = yield* TraceContext.currentThreadContext.pipe(
        TraceContext.withTraceContext({
          ...COMMAND,
          runId: "run-1",
          projectId: "project-1",
          model: "gpt-5",
          provider: "codex",
          delegated: true,
        }),
      );
      assert.deepStrictEqual(context, {
        threadId: "thread-1",
        projectId: "project-1",
        model: "gpt-5",
        delegated: true,
      });
      assert.deepStrictEqual(yield* TraceContext.currentThreadContext, {});
    }),
  );

  it("forTurn names the turn's run, thread, project and model family", () => {
    assert.deepStrictEqual(
      TraceContext.forTurn({
        runId: "run-1",
        threadId: "thread-1",
        appThread: { projectId: "project-1" },
        modelSelection: { model: "claude-opus-4-1" },
      }),
      {
        runId: "run-1",
        threadId: "thread-1",
        projectId: "project-1",
        model: "claude",
      },
    );
  });

  it("takes the run id from an outbox request that has one", () => {
    assert.deepStrictEqual(
      TraceContext.forOutboxEffect({
        commandId: "command-1",
        threadId: "thread-1",
        request: { type: "provider-turn.start", runId: "run-1" } as { readonly type: string },
      }),
      {
        commandId: "command-1",
        threadId: "thread-1",
        effectType: "provider-turn.start",
        runId: "run-1",
      },
    );
    assert.deepStrictEqual(
      TraceContext.forThread({
        projectId: "project-1",
        modelSelection: { model: "my private model" },
      }),
      { projectId: "project-1", model: "other" },
    );
  });

  it("accepts only typed context fields", () => {
    // @ts-expect-error a path is not a context field
    TraceContext.toAttributes({ cwd: "/home/alice" });
    // @ts-expect-error a title is not a context field
    TraceContext.toAttributes({ threadTitle: "payroll" });
    assert.deepStrictEqual(TraceContext.toAttributes({ delegated: true }), {
      "houston.delegated": true,
    });
  });

  it.effect("RPC calls carry the connecting client's kind on the root span and below", () =>
    Effect.gen(function* () {
      const recording = RecordingTracer.make();
      const middleware = yield* Effect.provide(
        RpcInstrumentation,
        makeRpcInstrumentationLayer({ clientKind: "desktop" }),
      );
      const options = { rpc: { _tag: "server.getConfig" } } as unknown as Parameters<
        typeof middleware
      >[1];
      const handler = Effect.void.pipe(
        Effect.withSpan("ServerConfig.get"),
      ) as unknown as Parameters<typeof middleware>[0];
      yield* middleware(handler, options).pipe(Effect.withTracer(recording.tracer));
      for (const name of ["ws.rpc.server.getConfig", "ServerConfig.get"]) {
        assert.strictEqual(
          recording.named(name)[0]?.attributes.get("houston.client.kind"),
          "desktop",
          name,
        );
      }
    }),
  );
});
