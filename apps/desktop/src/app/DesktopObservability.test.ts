import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

// Split so that no source line holds a credential-shaped literal.
const SENSITIVE = [
  ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-"),
  ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("_"),
  "/home/alice/work/secret-plan.ts",
  "C:\\Users\\alice\\secret-plan.ts",
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

class WindowError extends Schema.TaggedError<WindowError>()("WindowError", {
  detail: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `could not open ${this.detail}`;
  }
}

const decodeEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Runs `program` under the host's own observability layer and reads its error log. */
const errorLogOf = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "houston-desktop-error-log-" });
    const layerEnvironment = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: home,
      platform: "linux",
      processArch: "x64",
      appVersion: "1.2.3",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/repo/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          DesktopConfig.layerTest({ HOUSTON_HOME: home }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      assert.isTrue(environment.logDir.startsWith(home), environment.logDir);
      const exit = yield* program.pipe(
        Effect.exit,
        Effect.provide(DesktopObservability.layer.pipe(Layer.provide(NodeHttpClient.layerFetch))),
      );
      const names = (yield* fs.readDirectory(environment.logDir)).filter((name) =>
        name.includes(".errors-"),
      );
      const texts = yield* Effect.forEach(names, (name) =>
        fs.readFileString(environment.path.join(environment.logDir, name)),
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
    }).pipe(Effect.provide(layerEnvironment));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped);

describe("desktop error log", () => {
  it.effect("keeps failed spans and errors logged outside a span", () =>
    Effect.gen(function* () {
      const logger = DesktopObservability.makeComponentLogger("desktop-window");
      const { exit, names, entries } = yield* errorLogOf(
        logger
          .logError("could not open", { cause: Cause.fail(new RangeError("size")), path: "/x" })
          .pipe(
            Effect.annotateLogs({ runId: "0123456789ab" }),
            Effect.andThen(
              Effect.die(new TypeError("gone")).pipe(
                Effect.withSpan("desktop.ipc.invoke", {
                  attributes: { channel: "desktop:get-server-status" },
                }),
              ),
            ),
          ),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(names, ["desktop.errors-1970-01-01.ndjson"]);
      assert.deepStrictEqual(
        entries.map(({ kind, name, error, attributes }) => ({ kind, name, error, attributes })),
        [
          {
            kind: "log",
            name: undefined,
            error: "RangeError",
            attributes: { component: "desktop-window", runId: "0123456789ab" },
          },
          {
            kind: "span",
            name: "desktop.ipc.invoke",
            error: "TypeError",
            attributes: { channel: "desktop:get-server-status" },
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
              "houston.job.id": value,
              // An allowlisted key does not make a value safe.
              component: value,
              channel: value,
              runId: value,
            };
            return Effect.logError(`failed for ${value}`, { value, error: new Error(value) }).pipe(
              Effect.annotateLogs(fields),
              Effect.andThen(
                Effect.fail(
                  new WindowError({
                    detail: value,
                    cause: new Error(value, { cause: new Error(`root ${value}`) }),
                  }),
                ).pipe(Effect.withSpan("window.open", { attributes: fields }), Effect.exit),
              ),
              Effect.andThen(
                Effect.die(new Error(value)).pipe(Effect.withSpan("window.defect"), Effect.exit),
              ),
            );
          },
          { discard: true },
        ),
      );

      assert.lengthOf(entries, SENSITIVE.length * 3);
      for (const part of SENSITIVE_PARTS) assert.notInclude(text, part);
      assert.notInclude(text, "db.query.text");
    }),
  );
});
