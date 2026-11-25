// @effect-diagnostics nodeBuiltinImport:off -- The log appends synchronously through node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import {
  ERROR_LOG_MAX_BYTES_PER_DAY,
  ERROR_LOG_MAX_BYTES_PER_ENTRY,
  ERROR_LOG_MAX_ENTRIES_PER_KEY,
  ERROR_LOG_RETAINED_DAYS,
  ERROR_LOG_RETRY_MS,
  type ErrorLogFiles,
  type ErrorLogOptions,
  errorLogger,
  makeErrorLog,
} from "./errorLog.ts";
import * as HostProcess from "./HostProcess.ts";
import { makeLocalFileTracer, makeTraceSink } from "./observability.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = DateTime.toEpochMillis(DateTime.makeUnsafe("2031-03-10T12:00:00Z"));
const LOG_DIR = NodePath.join("state", "logs");
const TODAY = NodePath.join(LOG_DIR, "server.errors-2031-03-10.ndjson");

// Split so that no source line holds a credential-shaped literal.
const TOKEN = ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");
const POSIX_PATH = "/home/alice/work/secret-plan.ts";
const WINDOWS_PATH = "C:\\Users\\alice\\secret-plan.ts";
const URL_TEXT = "https://internal.example.com/inbox?wsTicket=ticket-value";
const AGENT_MESSAGE = "I will drop the customers table now";
const SQL = "SELECT hidden_column FROM private_notes";
const SENSITIVE = [POSIX_PATH, WINDOWS_PATH, URL_TEXT, TOKEN, AGENT_MESSAGE, SQL];
const SENSITIVE_PARTS = [
  "alice",
  "secret-plan",
  "internal.example.com",
  "ticket-value",
  "A1b2C3d4",
  "customers",
  "hidden_column",
  "private_notes",
];
const assertNothingSensitive = (text: string) => {
  for (const part of SENSITIVE_PARTS) assert.notInclude(text, part);
};

class BoomError extends Schema.TaggedError<BoomError>()("BoomError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {
  override get message() {
    return `could not finish ${this.detail}`;
  }
}

const Entry = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeDefect = Schema.decodeUnknownSync(Schema.Defect({ includeStack: true }));
const decodeEntry = Schema.decodeUnknownSync(Entry);
const parse = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeEntry(line));

/** In-memory files that count every call. */
const makeFiles = (initial: Record<string, string> = {}) => {
  const contents = new Map(Object.entries(initial));
  const calls: Array<string> = [];
  let failing = false;
  const call = (name: string) => {
    calls.push(name);
    if (failing) throw new Error("EROFS: read-only file system");
  };
  const files: ErrorLogFiles = {
    prepare: () => call("prepare"),
    append: (filePath, text) => {
      call("append");
      contents.set(filePath, (contents.get(filePath) ?? "") + text);
    },
    list: () => {
      call("list");
      return [...contents.keys()].map((filePath) => NodePath.basename(filePath));
    },
    size: (filePath) => {
      call("size");
      return Buffer.byteLength(contents.get(filePath) ?? "");
    },
    remove: (filePath) => {
      call("remove");
      contents.delete(filePath);
    },
  };
  return {
    files,
    contents,
    calls,
    setFailing: (value: boolean) => {
      failing = value;
    },
    entries: (filePath = TODAY) => parse(contents.get(filePath) ?? ""),
  };
};

const recordEverything = (recorded: Readonly<Record<string, unknown>>) => ({ ...recorded });

/** The tracer and logger as the server and the host compose them. */
const makeHarness = Effect.fnUntraced(function* (
  options: Pick<ErrorLogOptions, "files"> & Partial<ErrorLogOptions>,
) {
  const errorLog = makeErrorLog({
    directory: LOG_DIR,
    process: "server",
    clock: yield* Clock.Clock,
    attributes: recordEverything,
    ...options,
  });
  const tracer = yield* makeLocalFileTracer({
    filePath: "unused",
    maxBytes: 1024,
    maxFiles: 1,
    batchWindowMs: 10_000,
    sink: { filePath: "unused", push: () => {}, flush: Effect.void, close: () => Effect.void },
    onFailure: errorLog.recordSpan,
  });
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.exit(effect).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Tracer.Tracer, tracer),
          Logger.layer([errorLogger(errorLog)], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Info"),
        ),
      ),
    );
  return { errorLog, run };
});

type Failure = Error | { readonly _tag: string };

const fail = (name: string, error: Failure = new BoomError({ detail: "work" })) =>
  Effect.fail(error).pipe(Effect.withSpan(name));

const test = it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer));

test("error log", (it) => {
  const at = (millis: number) => TestClock.setTime(millis);

  describe("contents", () => {
    it.effect("records a failed span with its error tag and code locations", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });

        yield* run(fail("job.settle").pipe(Effect.annotateSpans({ "houston.run.id": "run-1" })));

        const [entry, ...rest] = memory.entries();
        assert.lengthOf(rest, 0);
        assert.strictEqual(entry?.time, "2031-03-10T12:00:00.000Z");
        assert.strictEqual(entry?.kind, "span");
        assert.strictEqual(entry?.name, "job.settle");
        assert.strictEqual(entry?.error, "BoomError");
        assert.isString(entry?.traceId);
        assert.isString(entry?.spanId);
        assert.deepStrictEqual(entry?.attributes, { "houston.run.id": "run-1" });
        const frames = entry?.frames as ReadonlyArray<string>;
        assert.isTrue(
          frames.some((frame) => /errorLog\.test\.ts:\d+:\d+\)?$/.test(frame)),
          JSON.stringify(frames),
        );
        for (const frame of frames) assert.notMatch(frame, /[\\/]/);
      }),
    );

    it.effect("records a defect by the defect's own name", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });

        yield* run(Effect.die(new RangeError("nope")).pipe(Effect.withSpan("job.defect")));

        assert.strictEqual(memory.entries()[0]?.error, "RangeError");
      }),
    );

    it.effect("ignores success and interruption, and keeps the failure beside them", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });

        yield* run(Effect.void.pipe(Effect.withSpan("ok")));
        yield* run(Effect.interrupt.pipe(Effect.withSpan("stopped")));
        yield* run(fail("broken"));

        assert.deepStrictEqual(
          memory.entries().map((entry) => entry.name),
          ["broken"],
        );
      }),
    );

    it.effect("records an error logged outside any span, and no lower level", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });

        yield* run(
          Effect.logWarning("only a warning").pipe(
            Effect.andThen(
              Effect.logError("could not start", {
                cause: Cause.fail(new BoomError({ detail: "start" })),
              }),
            ),
            Effect.annotateLogs({ "houston.job.name": "sweep" }),
          ),
        );

        const [entry, ...rest] = memory.entries();
        assert.lengthOf(rest, 0);
        assert.strictEqual(entry?.kind, "log");
        assert.strictEqual(entry?.level, "Error");
        assert.strictEqual(entry?.error, "BoomError");
        assert.deepStrictEqual(entry?.attributes, { "houston.job.name": "sweep" });
        assert.notProperty(entry, "message");
      }),
    );

    it.effect("describes an error the log annotations carry", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });

        yield* run(
          Effect.logError("could not open").pipe(
            Effect.annotateLogs({ error: new RangeError(POSIX_PATH) }),
          ),
        );

        assert.strictEqual(memory.entries()[0]?.error, "RangeError");
        assertNothingSensitive(memory.contents.get(TODAY) ?? "");
      }),
    );

    it.effect("names the span an error was logged in", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });

        yield* run(Effect.logFatal("gone").pipe(Effect.withSpan("server.start")));

        const [entry] = memory.entries();
        assert.strictEqual(entry?.level, "Fatal");
        assert.strictEqual(entry?.name, "server.start");
        assert.isString(entry?.spanId);
      }),
    );
  });

  describe("privacy", () => {
    it.effect("a failed span's message, causes, stack and attributes leave nothing behind", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });

        for (const text of SENSITIVE) {
          const nested = new Error(`inner ${text}`, { cause: new Error(`root ${text}`) });
          yield* run(
            fail("job.private", new BoomError({ detail: text, cause: nested })).pipe(
              // Only a process's own allowlist can tell a token from an id; its wiring test does.
              Effect.annotateSpans(
                text === TOKEN
                  ? {}
                  : {
                      path: text,
                      "url.full": text,
                      "db.query.text": text,
                      nested: { text },
                      list: [text],
                    },
              ),
            ),
          );
          yield* run(Effect.die(new Error(text)).pipe(Effect.withSpan("job.defect")));
        }

        assert.lengthOf(memory.entries(), SENSITIVE.length * 2);
        assertNothingSensitive(memory.contents.get(TODAY) ?? "");
      }),
    );

    it.effect("a log record's message, fields, annotations and cause leave nothing behind", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files, attributes: () => ({}) });

        for (const text of SENSITIVE) {
          yield* run(
            Effect.logError(
              `failed for ${text}`,
              { text, error: new Error(text) },
              Cause.fail(new BoomError({ detail: text })),
            ).pipe(Effect.annotateLogs({ text })),
          );
        }

        assert.lengthOf(memory.entries(), SENSITIVE.length);
        assertNothingSensitive(memory.contents.get(TODAY) ?? "");
      }),
    );

    const withStack = (message: string, lines: ReadonlyArray<string>) => {
      const error = new Error(message);
      error.stack = [`Error: ${message}`, ...lines.map((line) => `    at ${line}`)].join("\n");
      return error;
    };

    it.effect("frames keep only the application's own code, by basename, and Node built-ins", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({
          files: memory.files,
          program: { root: "/opt/My App (x86)/dist", file: "/opt/My App (x86)/dist/bin.mjs" },
        });

        yield* run(
          fail(
            "job.frames",
            withStack("boom", [
              "settle (file:///opt/My%20App%20(x86)/dist/bin.mjs:10:2)",
              "async Worker.run (/opt/My App (x86)/dist/chunks/chunk-1.js:11:3)",
              `Object.${AGENT_MESSAGE} (/opt/My App (x86)/dist/bin.mjs:13:5)`,
              "nextTick (node:internal/process/task_queues:15:7)",
              "readFile (node:fs:16:8)",
            ]),
          ),
        );
        yield* run(
          fail(
            "job.foreign",
            withStack("boom", [
              "customers (/home/alice/secret-plan.js:1:1)",
              "customers (secret-plan.ts:1:2)",
              "customers (/opt/My App (x86)/dist-secret-plan/a.js:1:2)",
              "customers (/opt/My App (x86)/dist/../../secret-plan.ts:1:2)",
              "customers (/opt/My App (x86)/dist/bin.mjs?/secret-plan.ts:1:2)",
              "customers (/opt/My App (x86)/dist/secret-plan.txt:1:2)",
              "customers (node:secret-plan:1:2)",
              "customers (eval at run (/opt/My App (x86)/dist/secret-plan.js:1:2), <anonymous>:1:1)",
              "customers (<anonymous>)",
              "own (/opt/My App (x86)/dist/bin.mjs:2:3)",
            ]),
          ),
        );

        const [own, foreign] = memory.entries();
        assert.deepStrictEqual(own?.frames, [
          "settle (bin.mjs:10:2)",
          "Worker.run (chunk-1.js:11:3)",
          "bin.mjs:13:5",
          "nextTick (node:internal)",
          "readFile (node:fs:16:8)",
        ]);
        assert.notProperty(own, "droppedFrames");
        assert.deepStrictEqual(foreign?.frames, ["own (bin.mjs:2:3)"]);
        assert.strictEqual(foreign?.droppedFrames, 9);
        assertNothingSensitive(memory.contents.get(TODAY) ?? "");
      }),
    );

    it.effect("frames of a Windows path match its file URL and either slash", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({
          files: memory.files,
          program: {
            root: "C:\\Program Files\\Houston\\dist",
            file: "C:\\Program Files\\Houston\\dist\\main.cjs",
          },
        });

        yield* run(
          fail(
            "job.windows",
            withStack("boom", [
              "open (C:\\Program Files\\Houston\\dist\\main.cjs:1:2)",
              "read (file:///c:/Program%20Files/Houston/dist/bin.mjs:3:4)",
              "customers (C:\\Users\\alice\\secret-plan.js:5:6)",
            ]),
          ),
        );

        const [entry] = memory.entries();
        assert.deepStrictEqual(entry?.frames, ["open (main.cjs:1:2)", "read (bin.mjs:3:4)"]);
        assert.strictEqual(entry?.droppedFrames, 1);
      }),
    );

    it.effect("a program that is one executable keeps its own frames and no neighbour's", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({
          files: memory.files,
          program: { root: undefined, file: "/home/alice/bin/houston" },
        });

        yield* run(
          fail(
            "job.executable",
            withStack("boom", [
              "settle (file:///home/alice/bin/houston:7:8)",
              "customers (/home/alice/bin/secret-plan.js:1:1)",
            ]),
          ),
        );

        const [entry] = memory.entries();
        assert.deepStrictEqual(entry?.frames, ["settle (houston:7:8)"]);
        assert.strictEqual(entry?.droppedFrames, 1);
      }),
    );

    it.effect(
      "a stack decoded from another process, and one whose message was replaced, add nothing",
      () =>
        Effect.gen(function* () {
          yield* at(START);
          const memory = makeFiles();
          const { run } = yield* makeHarness({ files: memory.files });
          const decoded = decodeDefect({
            name: "Error",
            message: "remote",
            stack: "Error: remote\n    at customers (secret-plan.ts:1:2)",
          }) as Error;
          const replaced = new Error("first\n    at customers (secret-plan.ts:1:2)");
          assert.include(replaced.stack, "secret-plan");
          replaced.message = "second";
          assert.include(decoded.stack, "secret-plan");

          yield* run(fail("job.decoded", decoded));
          yield* run(fail("job.replaced", replaced));
          yield* run(
            fail(
              "job.quoted",
              withStack("child failed\n    at customers (/home/alice/secret-plan.js:1:1)", []),
            ),
          );

          assert.deepStrictEqual(
            memory.entries().map((entry) => entry.name),
            ["job.decoded", "job.replaced", "job.quoted"],
          );
          assertNothingSensitive(memory.contents.get(TODAY) ?? "");
        }),
    );

    it.effect("a span or error name that is not a code name is replaced", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });
        const named = new Error("boom");
        named.name = WINDOWS_PATH.replaceAll("\\", "/");

        yield* run(fail(AGENT_MESSAGE, named));
        yield* run(fail(POSIX_PATH, { _tag: POSIX_PATH }));
        yield* run(fail("http.client GET"));
        yield* run(fail("ssh/tunnel.start"));

        assert.deepStrictEqual(
          memory.entries().map((entry) => [entry.name, entry.error]),
          [
            ["[unnamed]", "Error"],
            ["[unnamed]", "TaggedError"],
            ["http.client GET", "BoomError"],
            ["ssh/tunnel.start", "BoomError"],
          ],
        );
      }),
    );
  });

  describe("values that cannot be read", () => {
    const revoked = () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    };
    const unreadable: ReadonlyArray<readonly [string, () => unknown, string]> = [
      [
        "a non-string message",
        () => Object.assign(new RangeError("x"), { message: { text: AGENT_MESSAGE } }),
        "RangeError",
      ],
      [
        "a throwing stack getter",
        () =>
          Object.defineProperty(new RangeError("x"), "stack", {
            get: () => {
              throw new Error(AGENT_MESSAGE);
            },
          }),
        "UnknownError",
      ],
      ["a revoked proxy", revoked, "UnknownError"],
    ];

    it.effect.each(unreadable)("%s is recorded and pauses nothing", ([, make, error]) =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });

        yield* run(Effect.die(make()).pipe(Effect.withSpan("job.unreadable")));
        yield* run(Effect.logError("odd", { error: make() }));
        yield* run(fail("job.next"));

        assert.deepStrictEqual(
          memory.entries().map((entry) => [entry.kind, entry.name, entry.error]),
          [
            ["span", "job.unreadable", error],
            ["log", undefined, error],
            ["span", "job.next", "BoomError"],
          ],
        );
        assertNothingSensitive(memory.contents.get(TODAY) ?? "");
      }),
    );

    it.effect("descends into plain objects and arrays only, and not far", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });
        class Holder {
          readonly inner = new RangeError("x");
        }
        const wide = Object.fromEntries(
          Array.from({ length: 5_000 }, (_, index) => [`k${index}`, index]),
        );
        const deep = { a: { b: { c: { d: { e: new RangeError("x") } } } } };

        yield* run(Effect.logError({ nested: [{ error: new RangeError("x") }] }));
        yield* run(Effect.logError(new Holder()));
        yield* run(Effect.logError(new Map([["error", new RangeError("x")]])));
        yield* run(Effect.logError(new Set([new RangeError("x")])));
        yield* run(Effect.logError({ ...wide, last: new RangeError("x") }));
        yield* run(Effect.logError(deep));
        yield* run(Effect.logError({ file: Buffer.from(AGENT_MESSAGE) }));

        assert.deepStrictEqual(
          memory.entries().map((entry) => [entry.error, entry.value]),
          [
            ["RangeError", undefined],
            [undefined, "Holder"],
            [undefined, "Map"],
            [undefined, "Set"],
            [undefined, undefined],
            [undefined, undefined],
            [undefined, "Buffer"],
          ],
        );
        assertNothingSensitive(memory.contents.get(TODAY) ?? "");
      }),
    );

    it.effect("a large typed array is named and never read", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });
        const bytes = new Uint8Array(5 * 1024 * 1024);
        const reads: Array<string> = [];
        const watched = new Proxy(new Uint8Array(8), {
          ownKeys: (target) => {
            reads.push("ownKeys");
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor: (target, key) => {
            reads.push(String(key));
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        });

        yield* run(Effect.logError(bytes));
        yield* run(Effect.logError({ bytes }));
        yield* run(Effect.logError(watched));

        assert.deepStrictEqual(reads, []);
        assert.deepStrictEqual(
          memory.entries().map((entry) => entry.value),
          ["Uint8Array", "Uint8Array", "Uint8Array"],
        );
      }),
    );

    it.effect("a span that cannot be read is recorded and pauses nothing", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { errorLog, run } = yield* makeHarness({ files: memory.files });
        const { proxy, revoke } = Proxy.revocable(
          new Tracer.NativeSpan({
            name: "gone",
            parent: Option.none(),
            annotations: Context.empty(),
            links: [],
            startTime: 0n,
            kind: "internal",
            sampled: true,
          }),
          {},
        );
        revoke();

        errorLog.recordSpan(proxy, Cause.fail(new BoomError({ detail: "work" })));
        yield* run(fail("job.next"));

        assert.deepStrictEqual(
          memory.entries().map((entry) => [entry.name, entry.error]),
          [
            [undefined, "UnknownError"],
            ["job.next", "BoomError"],
          ],
        );
      }),
    );
  });

  describe("bounds", () => {
    it.effect(
      "removes only its own files older than the retention, at start and on a new day",
      () =>
        Effect.gen(function* () {
          yield* at(START);
          const file = (name: string) => NodePath.join(LOG_DIR, name);
          const kept = [
            file("server.errors-2031-03-03.ndjson"),
            file("desktop.errors-2031-01-01.ndjson"),
            file("server.trace.ndjson.3"),
            file("server.errors-2031-01-01.ndjson.bak"),
          ];
          const memory = makeFiles({
            [file("server.errors-2031-03-02.ndjson")]: "old\n",
            ...Object.fromEntries(kept.map((name) => [name, "kept\n"])),
          });
          const { run } = yield* makeHarness({ files: memory.files });
          assert.sameMembers([...memory.contents.keys()], kept);

          yield* TestClock.adjust(DAY_MS);
          yield* run(fail("tomorrow"));
          assert.sameMembers(
            [...memory.contents.keys()],
            [...kept.slice(1), file("server.errors-2031-03-11.ndjson")],
          );
          assert.strictEqual(ERROR_LOG_RETAINED_DAYS, 8);
        }),
    );

    it.effect("caps one failure per day, names the limit, and starts again the next day", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });

        for (let index = 0; index < ERROR_LOG_MAX_ENTRIES_PER_KEY + 20; index++) {
          yield* run(fail("storm"));
        }
        yield* run(fail("storm", { _tag: "OtherError" }));
        yield* run(fail("rare"));

        const entries = memory.entries();
        assert.lengthOf(entries, ERROR_LOG_MAX_ENTRIES_PER_KEY + 3);
        assert.deepStrictEqual(entries[ERROR_LOG_MAX_ENTRIES_PER_KEY], {
          time: "2031-03-10T12:00:00.000Z",
          kind: "limit",
          limit: "ERROR_LOG_MAX_ENTRIES_PER_KEY",
          maximum: ERROR_LOG_MAX_ENTRIES_PER_KEY,
          actual: ERROR_LOG_MAX_ENTRIES_PER_KEY + 1,
          name: "storm",
          error: "BoomError",
        });
        assert.strictEqual(entries.at(-1)?.name, "rare");

        yield* TestClock.adjust(DAY_MS);
        yield* run(fail("storm"));
        const tomorrow = memory.entries(NodePath.join(LOG_DIR, "server.errors-2031-03-11.ndjson"));
        assert.deepStrictEqual(
          tomorrow.map((entry) => entry.name),
          ["storm"],
        );
      }),
    );

    it.effect("a storm of different failures stays under the daily size and names the limit", () =>
      Effect.gen(function* () {
        yield* at(START);
        const yesterday = NodePath.join(LOG_DIR, "server.errors-2031-03-09.ndjson");
        const memory = makeFiles({ [yesterday]: '{"kind":"span"}\n' });
        const { run } = yield* makeHarness({ files: memory.files });
        const attributes = { filler: "x".repeat(120) };

        for (let index = 0; index < 4_500; index++) {
          yield* run(fail(`storm.${index}`).pipe(Effect.annotateSpans(attributes)));
        }

        const text = memory.contents.get(TODAY) ?? "";
        assert.isAtMost(Buffer.byteLength(text), ERROR_LOG_MAX_BYTES_PER_DAY);
        const last = memory.entries().at(-1);
        assert.strictEqual(last?.kind, "limit");
        assert.strictEqual(last?.limit, "ERROR_LOG_MAX_BYTES_PER_DAY");
        assert.strictEqual(last?.maximum, ERROR_LOG_MAX_BYTES_PER_DAY);
        assert.isAbove(last?.actual as number, ERROR_LOG_MAX_BYTES_PER_DAY);
        assert.strictEqual(memory.contents.get(yesterday), '{"kind":"span"}\n');
        // Past the limit the rest of the day reaches no file.
        const calls = memory.calls.length;
        yield* run(fail("after"));
        assert.lengthOf(memory.calls, calls);
      }),
    );

    it.effect("counts what an earlier process wrote today", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles({ [TODAY]: "x".repeat(ERROR_LOG_MAX_BYTES_PER_DAY) });
        const { run } = yield* makeHarness({ files: memory.files });

        yield* run(fail("late"));
        assert.strictEqual(memory.contents.get(TODAY)?.length, ERROR_LOG_MAX_BYTES_PER_DAY);

        yield* TestClock.adjust(DAY_MS);
        yield* run(fail("late"));
        assert.lengthOf(
          memory.entries(NodePath.join(LOG_DIR, "server.errors-2031-03-11.ndjson")),
          1,
        );
      }),
    );

    it.effect("an entry over its size keeps its names and says which limit cut it", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });
        const attributes = Object.fromEntries(
          Array.from({ length: 60 }, (_, index) => [`houston.k${index}`, "y".repeat(120)]),
        );

        yield* run(fail("wide").pipe(Effect.annotateSpans(attributes)));

        const [entry] = memory.entries();
        assert.isAtMost(
          Buffer.byteLength(memory.contents.get(TODAY) ?? ""),
          ERROR_LOG_MAX_BYTES_PER_ENTRY,
        );
        assert.strictEqual(entry?.name, "wide");
        assert.strictEqual(entry?.error, "BoomError");
        assert.strictEqual(entry?.limit, "ERROR_LOG_MAX_BYTES_PER_ENTRY");
        assert.strictEqual(entry?.maximum, ERROR_LOG_MAX_BYTES_PER_ENTRY);
        assert.isAbove(entry?.actual as number, ERROR_LOG_MAX_BYTES_PER_ENTRY);
        assert.notProperty(entry, "attributes");
      }),
    );
  });

  describe("file system", () => {
    it.effect("a failing append never reaches the span, and is not retried in a loop", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });
        memory.setFailing(true);
        const atStart = memory.calls.length;

        const exits = [];
        for (let index = 0; index < 30; index++) exits.push(yield* run(fail(`disk.${index}`)));
        yield* run(Effect.logError("still running"));

        for (const exit of exits) {
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            assert.strictEqual(
              (Cause.squash(exit.cause) as { readonly _tag: string })._tag,
              "BoomError",
            );
          }
        }
        const attempted = memory.calls.length - atStart;
        assert.isAtLeast(attempted, 1);
        assert.isAtMost(attempted, 3, memory.calls.join());

        memory.setFailing(false);
        yield* TestClock.adjust(ERROR_LOG_RETRY_MS);
        yield* run(fail("recovered"));
        assert.deepStrictEqual(
          memory.entries().map((entry) => entry.name),
          ["recovered"],
        );
      }),
    );

    it.effect("an expired file that cannot be removed does not stop the log", () =>
      Effect.gen(function* () {
        yield* at(START);
        const expired = NodePath.join(LOG_DIR, "server.errors-2031-01-01.ndjson");
        const memory = makeFiles({ [expired]: "held open\n" });
        const { run } = yield* makeHarness({
          files: {
            ...memory.files,
            remove: () => {
              throw new Error("EBUSY: resource busy or locked");
            },
          },
        });

        yield* run(fail("after"));

        assert.strictEqual(memory.entries()[0]?.name, "after");
      }),
    );

    it.effect("a successful span, sampled or not, makes no file-system call", () =>
      Effect.gen(function* () {
        yield* at(START);
        const memory = makeFiles();
        const { run } = yield* makeHarness({ files: memory.files });
        const atStart = memory.calls.length;

        yield* run(Effect.void.pipe(Effect.withSpan("sampled")));
        yield* run(Effect.void.pipe(Effect.withSpan("unsampled", { sampled: false })));
        yield* run(fail("unsampled.failure").pipe(Effect.withSpan("parent", { sampled: false })));
        yield* run(Effect.logInfo("fine"));
        yield* TestClock.adjust(DAY_MS);
        yield* run(Effect.void.pipe(Effect.withSpan("sampled.tomorrow")));
        assert.strictEqual(memory.calls.length - atStart, 0, memory.calls.join());

        yield* run(fail("sampled.failure"));
        assert.isAbove(memory.calls.length, atStart);
      }),
    );

    const tempDirectory = Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "houston-error-log-"))),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );

    it.effect("survives rotation of the trace file beside it", () =>
      Effect.gen(function* () {
        yield* at(START);
        const directory = yield* tempDirectory;
        const errorLog = makeErrorLog({
          directory,
          process: "server",
          clock: yield* Clock.Clock,
          attributes: () => ({}),
        });
        const filePath = NodePath.join(directory, "server.trace.ndjson");
        const sink = yield* makeTraceSink({
          filePath,
          maxBytes: 1024,
          maxFiles: 1,
          batchWindowMs: 10_000,
        });
        const tracer = yield* makeLocalFileTracer({
          filePath,
          maxBytes: 1024,
          maxFiles: 1,
          batchWindowMs: 10_000,
          sink,
          onFailure: errorLog.recordSpan,
        });
        const traced = Effect.provideService(Tracer.Tracer, tracer);

        yield* fail("the.failure").pipe(traced, Effect.exit);
        yield* sink.flush;
        for (let index = 0; index < 30; index++) {
          yield* Effect.void.pipe(Effect.withSpan(`noise.${index}`), traced);
          yield* sink.flush;
        }

        const traces = NodeFS.readdirSync(directory).filter((name) => name.includes("trace"));
        assert.sameMembers(traces, ["server.trace.ndjson", "server.trace.ndjson.1"]);
        for (const name of traces) {
          assert.notInclude(
            NodeFS.readFileSync(NodePath.join(directory, name), "utf8"),
            "the.failure",
          );
        }
        assert.deepStrictEqual(
          parse(
            NodeFS.readFileSync(
              NodePath.join(directory, "server.errors-2031-03-10.ndjson"),
              "utf8",
            ),
          ).map((entry) => entry.name),
          ["the.failure"],
        );
      }).pipe(Effect.scoped),
    );

    // Windows has no POSIX mode bits; the state directory's own access list applies there.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "creates the file for its owner only",
      () =>
        Effect.gen(function* () {
          yield* at(START);
          const directory = NodePath.join(yield* tempDirectory, "logs");
          const { run } = yield* makeHarness({ directory });

          yield* run(fail("private"));

          const { mode } = NodeFS.statSync(
            NodePath.join(directory, "server.errors-2031-03-10.ndjson"),
          );
          assert.strictEqual(mode & 0o777, 0o600);
        }).pipe(Effect.scoped),
    );

    it.effect("a path that cannot be a directory never throws", () =>
      Effect.gen(function* () {
        yield* at(START);
        const blocked = NodePath.join(yield* tempDirectory, "file");
        NodeFS.writeFileSync(blocked, "");
        const { run } = yield* makeHarness({ directory: NodePath.join(blocked, "logs") });

        const exit = yield* run(fail("blocked"));

        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(NodeFS.readFileSync(blocked, "utf8"), "");
        const open = yield* tempDirectory;
        const { run: runOpen } = yield* makeHarness({ directory: open });
        yield* runOpen(fail("open"));
        assert.lengthOf(NodeFS.readdirSync(open), 1);
      }).pipe(Effect.scoped),
    );
  });
});
