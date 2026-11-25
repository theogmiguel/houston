import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../../config.ts";
import * as Observability from "../../observability/Observability.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import * as HoustonSecrets from "../secrets/HoustonSecrets.ts";

// Split so that no source line holds a credential-shaped literal.
const TOKENS = [
  ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-"),
  ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("_"),
];
const SENSITIVE = [
  ...TOKENS,
  "/home/alice/work/secret-plan.ts",
  "https://internal.example.com/inbox?wsTicket=ticket-value",
  "I will drop the customers table now",
  "SELECT hidden_column FROM private_notes",
];
const SENSITIVE_PARTS = [
  "A1b2C3d4",
  "alice",
  "secret-plan",
  "internal.example.com",
  "ticket-value",
  "customers",
  "hidden_column",
  "private_notes",
];

const BROKEN_STATEMENT = "SELECT status FROM runs WHERE id = ?";

class SettleError extends Schema.TaggedError<SettleError>()("SettleError", {
  detail: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `could not settle ${this.detail}`;
  }
}

const Entry = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeEntry = Schema.decodeUnknownSync(Entry);

const layerCollector = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

/** Runs `program` under the server's own observability layer and reads its error log. */
const errorLogOf = <A, E>(
  program: Effect.Effect<A, E>,
  overrides: Partial<ServerConfig.ServerConfig["Service"]> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const exit = yield* program.pipe(
      Effect.exit,
      Effect.provide(
        Observability.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig.ServerConfig, { ...config, ...overrides }),
              ResourceAttribution.layer,
              HoustonSecrets.layerMemory(),
              layerCollector,
            ),
          ),
        ),
      ),
    );
    const names = (yield* fs.readDirectory(config.logsDir)).filter((name) =>
      name.includes(".errors-"),
    );
    const texts = yield* Effect.forEach(names, (name) =>
      fs.readFileString(path.join(config.logsDir, name)),
    );
    const text = texts.join("");
    return {
      exit,
      names,
      text,
      entries: text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeEntry(line)),
    };
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "houston-error-log-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  );

describe("server error log", () => {
  it.effect.each([
    { logs: "no log export", overrides: {} },
    { logs: "a log export", overrides: { otlpLogsUrl: "http://127.0.0.1:9/v1/logs" } },
  ])("keeps failed spans and errors logged outside a span with $logs", ({ overrides }) =>
    Effect.gen(function* () {
      const { exit, names, entries } = yield* errorLogOf(
        Effect.logError("could not start", { cause: Cause.fail(new RangeError("port")) }).pipe(
          Effect.annotateLogs({ "houston.job.name": "sweep" }),
          Effect.andThen(
            Effect.fail(new SettleError({ detail: "run", cause: "x" })).pipe(
              Effect.withSpan("run.settle", { attributes: { "houston.run.id": "run-1" } }),
            ),
          ),
        ),
        overrides,
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(names, ["server.errors-1970-01-01.ndjson"]);
      assert.deepStrictEqual(
        entries.map(({ kind, level, name, error, attributes }) => ({
          kind,
          level,
          name,
          error,
          attributes,
        })),
        [
          {
            kind: "log",
            level: "Error",
            name: undefined,
            error: "RangeError",
            attributes: { "houston.job.name": "sweep" },
          },
          {
            kind: "span",
            level: undefined,
            name: "run.settle",
            error: "SettleError",
            attributes: { "houston.run.id": "run-1" },
          },
        ],
      );
    }),
  );

  it.effect("writes no path, URL, token, agent text or statement from any field", () =>
    Effect.gen(function* () {
      const { entries, text } = yield* errorLogOf(
        Effect.forEach(
          SENSITIVE,
          (value) => {
            const fields = {
              text: value,
              // Shaped like an id, under a key no allowlist names.
              title: "customers",
              "url.full": value,
              "db.query.text": value,
              "server.address": "internal.example.com",
              "http.route": value,
              // An allowlisted prefix does not make a value safe.
              "houston.job.id": value,
              "rpc.aggregate": value,
            };
            return Effect.logError(`failed for ${value}`, { value, error: new Error(value) }).pipe(
              Effect.annotateLogs(fields),
              Effect.andThen(
                Effect.fail(
                  new SettleError({
                    detail: value,
                    cause: new Error(value, { cause: new Error(`root ${value}`) }),
                  }),
                ).pipe(Effect.withSpan("run.settle", { attributes: fields }), Effect.exit),
              ),
              Effect.andThen(
                Effect.die(new Error(value)).pipe(Effect.withSpan("run.defect"), Effect.exit),
              ),
            );
          },
          { discard: true },
        ),
      );

      assert.lengthOf(entries, SENSITIVE.length * 3);
      for (const part of SENSITIVE_PARTS) assert.notInclude(text, part);
      assert.notInclude(text, "db.query.text");
      assert.notInclude(text, "server.address");
    }),
  );

  it.effect("drops a statement's text even when it holds only placeholders", () =>
    Effect.gen(function* () {
      const { entries, text } = yield* errorLogOf(
        Effect.fail(new SettleError({ detail: "busy", cause: "x" })).pipe(
          Effect.withSpan("sqlite", {
            attributes: { "db.query.text": BROKEN_STATEMENT, "db.operation.name": "SELECT" },
          }),
        ),
      );

      assert.deepStrictEqual(entries[0]?.attributes, { "db.operation.name": "SELECT" });
      assert.notInclude(text, "FROM runs");
    }),
  );

  it.effect("records a failure once and nothing for a success", () =>
    Effect.gen(function* () {
      const { entries } = yield* errorLogOf(
        Effect.void.pipe(
          Effect.withSpan("fine"),
          Effect.andThen(Effect.fail("no").pipe(Effect.withSpan("broken"))),
        ),
      );

      assert.deepStrictEqual(
        entries.map((entry) => entry.name),
        ["broken"],
      );
    }),
  );
});
