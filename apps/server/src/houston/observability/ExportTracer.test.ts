import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { makeLocalFileTracer, type TraceRecord } from "@houston-app/shared/observability";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import type * as OtlpTracer from "effect/observability/OtlpTracer";

import * as RecordingTracer from "../../observability/testing/RecordingTracer.ts";
import * as ExportLogger from "./ExportLogger.ts";
import { exportedTraceData } from "./ExportRedaction.ts";
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
  it.effect("exports a scrubbed message, allowlisted annotations and the error tag", () =>
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
      assert.strictEqual(entry!.message, "failed to read a.ts from [url] token=[redacted]");
      assert.deepStrictEqual(entry!.annotations, { "houston.thread.id": "thread-1" });
      assert.notInclude(Cause.pretty(entry!.cause), PRIVATE_PATH);
    }),
  );
});

describe("exportedTraceData", () => {
  it("filters browser span attributes, event names and status messages", () => {
    const data = {
      resourceSpans: [
        {
          resource: { attributes: [], droppedAttributesCount: 0 },
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
    assert.strictEqual(span.events[0]!.name, "log");
    assert.strictEqual(span.status.code, 2);
  });
});
