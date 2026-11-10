import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import { makeLocalFileTracer, type TraceRecord } from "@houston-app/shared/observability";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import type * as OtlpTracer from "effect/observability/OtlpTracer";

import * as RecordingTracer from "../../observability/testing/RecordingTracer.ts";
import * as ExportLogger from "./ExportLogger.ts";
import { exportedResource, exportedTraceData } from "./ExportRedaction.ts";
import * as ExportTracer from "./ExportTracer.ts";

class ReadFailed extends Data.TaggedError("ReadFailed")<{ readonly message: string }> {}

const PRIVATE_PATH = "/home/alice/work/payroll";

// The production stack: the local file tracer records everything and delegates to the exporter.
const makeStack = Effect.fnUntraced(function* () {
  const exported = RecordingTracer.make();
  const local: Array<TraceRecord> = [];
  const tracer = yield* makeLocalFileTracer({
    filePath: "unused",
    maxBytes: 1_000_000,
    maxFiles: 1,
    batchWindowMs: 1_000,
    sink: {
      filePath: "unused",
      push: (record) => local.push(record),
      flush: Effect.void,
      close: () => Effect.void,
    },
    delegate: ExportTracer.make(exported.tracer),
  });
  return { tracer, exported, local };
});

const failingWork = Effect.fail(
  new ReadFailed({ message: `cannot read ${PRIVATE_PATH}/a.ts` }),
).pipe(
  Effect.withSpan("Files.read", {
    attributes: {
      "git.cwd": PRIVATE_PATH,
      "url.full": "https://user:pw@api.github.com/repos/alice/payroll?token=x",
      "houston.thread.id": "thread-1",
      "rpc.method": "houston.files.read",
      "db.query.text": `SELECT * FROM t WHERE id = ?${" ".repeat(3000)}`,
      "code.stacktrace": `at read (${PRIVATE_PATH}/a.ts:1:1)`,
    },
  }),
);

describe("ExportTracer", () => {
  it.effect("exports a log span event as 'log' without the interpolated error text", () =>
    Effect.gen(function* () {
      const { tracer, exported } = yield* makeStack();
      yield* Effect.logError(`x failed: ${new Error("git: /rel/secret-branch")}`).pipe(
        Effect.withSpan("Git.push"),
        Effect.withTracer(tracer),
        Effect.provide(Logger.layer([Logger.tracerLogger])),
      );
      const span = exported.named("Git.push")[0]!;
      assert.deepStrictEqual(
        span.events.map(([name]) => name),
        ["log"],
      );
      assert.notInclude(
        JSON.stringify(span.events.map(([name, , attributes]) => [name, attributes])),
        "secret-branch",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("filters the attributes of links given when a span starts", () =>
    Effect.gen(function* () {
      const { tracer, exported } = yield* makeStack();
      const linked = yield* Effect.makeSpan("Linked").pipe(Effect.withTracer(tracer));
      yield* Effect.void.pipe(
        Effect.withSpan("Linking", {
          links: [{ span: linked, attributes: { "git.cwd": PRIVATE_PATH, "houston.run.id": "r" } }],
        }),
        Effect.withTracer(tracer),
      );
      assert.deepStrictEqual(
        exported.named("Linking")[0]!.links.map((link) => link.attributes),
        [{ "houston.run.id": "r" }],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("exports only allowlisted attributes while the local file keeps all", () =>
    Effect.gen(function* () {
      const { tracer, exported, local } = yield* makeStack();
      yield* failingWork.pipe(Effect.exit, Effect.withTracer(tracer));

      const [span] = exported.named("Files.read");
      assert.isDefined(span);
      const attributes = Object.fromEntries(span!.attributes);
      assert.deepStrictEqual(Object.keys(attributes).toSorted(), [
        "db.query.text",
        "houston.error.tag",
        "houston.outcome",
        "houston.thread.id",
        "rpc.method",
        "server.address",
        "url.scheme",
      ]);
      assert.strictEqual(attributes["server.address"], "api.github.com");
      assert.strictEqual(attributes["url.scheme"], "https");
      assert.strictEqual((attributes["db.query.text"] as string).length, 2048);
      assert.strictEqual(attributes["houston.outcome"], "failure");
      assert.strictEqual(attributes["houston.error.tag"], "ReadFailed");
      assert.notInclude(JSON.stringify(attributes), PRIVATE_PATH);

      const record = JSON.stringify(local);
      assert.include(record, PRIVATE_PATH);
      assert.include(record, "git.cwd");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("exports a failure as its error tag without its message or stack", () =>
    Effect.gen(function* () {
      const { tracer, exported } = yield* makeStack();
      yield* failingWork.pipe(Effect.exit, Effect.withTracer(tracer));

      const status = exported.named("Files.read")[0]!.status;
      assert.strictEqual(status._tag, "Ended");
      if (status._tag !== "Ended" || Exit.isSuccess(status.exit)) return assert.fail("not failed");
      // The OTLP exporter builds exception events and the status message from these errors.
      const errors = Cause.prettyErrors(status.exit.cause, { includeCauseInStack: true });
      assert.strictEqual(errors[0]?.name, "ReadFailed");
      assert.strictEqual(errors[0]?.message, "ReadFailed");
      assert.notInclude(JSON.stringify(errors.map((error) => error.stack)), PRIVATE_PATH);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("names log events by kind and records success outcomes", () =>
    Effect.gen(function* () {
      const { tracer, exported } = yield* makeStack();
      yield* Effect.logInfo(`opened ${PRIVATE_PATH}`).pipe(
        Effect.annotateLogs({ "houston.project.id": "project-1", "git.branch": "alice/raise" }),
        Effect.withSpan("Files.open"),
        Effect.withTracer(tracer),
        Effect.provide(Logger.layer([Logger.tracerLogger])),
      );

      const span = exported.named("Files.open")[0]!;
      assert.strictEqual(span.attributes.get("houston.outcome"), "success");
      assert.isFalse(span.attributes.has("houston.error.tag"));
      const [name, , attributes] = span.events[0]!;
      assert.strictEqual(name, "log");
      assert.deepStrictEqual(attributes, {
        "houston.project.id": "project-1",
        "effect.logLevel": "INFO",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("ExportLogger", () => {
  it.effect("exports no message text, allowlisted annotations and the error tag", () =>
    Effect.gen(function* () {
      const seen: Array<{ message: unknown; annotations: unknown; cause: Cause.Cause<unknown> }> =
        [];
      const capture = Logger.make((options) => {
        seen.push({
          message: options.message,
          annotations: options.fiber.getRef(References.CurrentLogAnnotations),
          cause: options.cause,
        });
      });
      yield* Effect.logError(
        `failed to read ${PRIVATE_PATH}/a.ts from https://api.github.com/x token=abcdef123456`,
        { body: "user text" },
        Cause.fail(new ReadFailed({ message: PRIVATE_PATH })),
      ).pipe(
        Effect.annotateLogs({ "houston.thread.id": "thread-1", "terminal.cwd": PRIVATE_PATH }),
        Effect.provide(Logger.layer([ExportLogger.redacting(capture)])),
      );

      const [entry] = seen;
      assert.isDefined(entry);
      assert.strictEqual(entry!.message, "log");
      assert.deepStrictEqual(entry!.annotations, { "houston.thread.id": "thread-1" });
      assert.notInclude(Cause.pretty(entry!.cause), PRIVATE_PATH);
    }),
  );

  it.effect("exports an interruption as a fixed Interrupted without its interruptor stack", () =>
    Effect.gen(function* () {
      const causes: Array<Cause.Cause<unknown>> = [];
      const capture = Logger.make((options) => {
        causes.push(options.cause);
      });
      yield* Effect.logWarning("stopped", Cause.interrupt(1)).pipe(
        Effect.provide(Logger.layer([ExportLogger.redacting(capture)])),
      );
      const errors = Cause.prettyErrors(causes[0]!, { includeCauseInStack: true });
      assert.deepStrictEqual(
        errors.map((error) => [error.name, error.message, error.stack]),
        [["Interrupted", "Interrupted", "Interrupted: Interrupted"]],
      );
    }),
  );
});

describe("exportedTraceData", () => {
  it("filters browser span attributes, event names and status messages", () => {
    const data = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "houston-web" } },
              { key: "host.name", value: { stringValue: "alice-laptop" } },
              { key: "user.email", value: { stringValue: "alice@example.com" } },
            ],
            droppedAttributesCount: 0,
          },
          scopeSpans: [
            {
              scope: { name: "houston-web" },
              spans: [
                {
                  traceId: "t",
                  spanId: "s",
                  name: "ui.open",
                  kind: 1,
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                  attributes: [
                    { key: "houston.thread.id", value: { stringValue: "thread-1" } },
                    { key: "file.path", value: { stringValue: PRIVATE_PATH } },
                    { key: "url.full", value: { stringValue: "http://localhost:3773/a?b=c" } },
                  ],
                  droppedAttributesCount: 0,
                  events: [
                    {
                      name: `opened ${PRIVATE_PATH}`,
                      timeUnixNano: "1",
                      attributes: [
                        { key: "exception.message", value: { stringValue: PRIVATE_PATH } },
                      ],
                      droppedAttributesCount: 0,
                    },
                    {
                      name: "exception",
                      timeUnixNano: "2",
                      attributes: [
                        { key: "exception.type", value: { stringValue: "TypeError" } },
                        { key: "exception.message", value: { stringValue: PRIVATE_PATH } },
                      ],
                      droppedAttributesCount: 0,
                    },
                  ],
                  droppedEventsCount: 0,
                  status: { code: 2, message: PRIVATE_PATH },
                  links: [],
                  droppedLinksCount: 0,
                },
              ],
            },
          ],
        },
      ],
    } as unknown as OtlpTracer.TraceData;

    const exported = exportedTraceData(data);
    const text = JSON.stringify(exported);
    assert.notInclude(text, PRIVATE_PATH);
    assert.notInclude(text, "b=c");
    const span = exported.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    assert.deepStrictEqual(
      span.attributes.map((attribute) => attribute.key),
      ["houston.thread.id", "url.scheme", "server.address"],
    );
    // Same naming rule as server span events: an arbitrary name is a log message.
    assert.deepStrictEqual(
      span.events.map((event) => event.name),
      ["log", "exception"],
    );
    assert.deepStrictEqual(
      exported.resourceSpans[0]!.resource.attributes.map((attribute) => attribute.key),
      ["service.name"],
    );
    assert.notInclude(text, "alice");
    assert.strictEqual(span.status.code, 2);
  });
});

describe("exportedResource", () => {
  it("keeps the service, channel and runtime and drops the machine", () => {
    assert.deepStrictEqual(
      exportedResource<{ serviceName: string; attributes: Record<string, unknown> }>({
        serviceName: "houston-server",
        attributes: {
          "service.instance.id": "abc",
          "houston.release.channel": "dev",
          "deployment.environment.name": "development",
          "process.runtime.name": "nodejs",
          "host.name": "alice-laptop",
          "os.description": "Windows 11",
        },
      }),
      {
        serviceName: "houston-server",
        attributes: {
          "service.instance.id": "abc",
          "houston.release.channel": "dev",
          "deployment.environment.name": "development",
          "process.runtime.name": "nodejs",
        },
      },
    );
  });
});

describe("ExportTracer SQLite spans", () => {
  const exportedNames = (exported: ReturnType<typeof RecordingTracer.make>) =>
    exported.ended.map((span) => span.name);
  const localNames = (local: ReadonlyArray<TraceRecord>) => local.map((record) => record.name);
  const transaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.withSpan(Effect.withSpan(Effect.void, "BEGIN"), "sql.transaction").pipe(
      Effect.andThen(body),
      Effect.tap(Effect.withSpan(Effect.void, "COMMIT")),
      Effect.withSpan("sql.transaction"),
    );

  it.effect("keeps fast successful SQLite spans local and exports their parent", () =>
    Effect.gen(function* () {
      const { tracer, exported, local } = yield* makeStack();
      yield* Effect.withSpan(Effect.void, "sqlite").pipe(
        Effect.withSpan("Projection.read"),
        Effect.withTracer(tracer),
      );
      assert.deepStrictEqual(exportedNames(exported), ["Projection.read"]);
      assert.deepStrictEqual(localNames(local), ["sqlite", "Projection.read"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("exports a slow SQLite span with every SQLite ancestor", () =>
    Effect.gen(function* () {
      const { tracer, exported, local } = yield* makeStack();
      yield* Effect.withSpan(Effect.void, "sqlite").pipe(
        Effect.andThen(Effect.withSpan(TestClock.adjust("5 millis"), "sqlite")),
        Effect.withSpan("sql.transaction"),
        Effect.withSpan("EventSink.write"),
        Effect.withTracer(tracer),
      );
      assert.deepStrictEqual(exportedNames(exported), [
        "sqlite",
        "sql.transaction",
        "EventSink.write",
      ]);
      assert.strictEqual(local.length, 4);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("exports a failed SQLite span with its ancestors and outcome", () =>
    Effect.gen(function* () {
      const { tracer, exported } = yield* makeStack();
      yield* Effect.fail(new ReadFailed({ message: "SQLITE_BUSY" })).pipe(
        Effect.withSpan("COMMIT"),
        Effect.withSpan("sql.transaction"),
        Effect.withTracer(tracer),
        Effect.exit,
      );
      assert.deepStrictEqual(exportedNames(exported), ["COMMIT", "sql.transaction"]);
      assert.strictEqual(exported.named("COMMIT")[0]!.attributes.get("houston.outcome"), "failure");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("exports a transaction that contains an exported span, without its fast controls", () =>
    Effect.gen(function* () {
      const { tracer, exported, local } = yield* makeStack();
      yield* transaction(Effect.withSpan(Effect.void, "EventStore.append")).pipe(
        Effect.withTracer(tracer),
      );
      assert.deepStrictEqual(exportedNames(exported), ["EventStore.append", "sql.transaction"]);
      assert.deepStrictEqual(localNames(local).toSorted(), [
        "BEGIN",
        "COMMIT",
        "EventStore.append",
        "sql.transaction",
        "sql.transaction",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps every span of a fast transaction through the SQLite client local", () =>
    Effect.gen(function* () {
      const { tracer, exported, local } = yield* makeStack();
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE t (id INTEGER PRIMARY KEY)`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO t (id) VALUES (1)`;
            yield* sql.withTransaction(sql`INSERT INTO t (id) VALUES (2)`);
          }),
        );
        yield* sql
          .withTransaction(Effect.fail(new ReadFailed({ message: "rolled back" })))
          .pipe(Effect.exit);
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
        Effect.withSpan("Store.write"),
        Effect.withTracer(tracer),
        // The statements' own clock: a CI stall must not turn a statement into a slow one.
        Effect.provide(TestClock.layer()),
      );
      const clientNames = ["sqlite", "sql.transaction", "BEGIN", "COMMIT", "SAVEPOINT", "ROLLBACK"];
      const recorded = new Set(localNames(local));
      for (const name of clientNames) assert.isTrue(recorded.has(name), `${name} recorded locally`);
      // Of the client's spans, only the failed transaction leaves; its fast ROLLBACK stays local.
      const names = exportedNames(exported);
      assert.include(names, "Store.write");
      assert.deepStrictEqual(
        names.filter((name) => clientNames.includes(name)),
        ["sql.transaction"],
      );
      assert.strictEqual(
        exported.named("sql.transaction")[0]!.attributes.get("houston.outcome"),
        "failure",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
