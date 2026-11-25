// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as InferenceImageVerdicts from "./InferenceImageVerdicts.ts";

const ADDRESS = "http://rtx.test:8888/v1";
const MODEL = "glm";

describe("InferenceImageVerdicts", () => {
  it.effect("remembers a verdict by server address and model", () =>
    Effect.gen(function* () {
      const verdicts = yield* InferenceImageVerdicts.InferenceImageVerdicts;
      expect((yield* verdicts.forAddress(ADDRESS))(MODEL)).toBeUndefined();
      yield* verdicts.record(ADDRESS, MODEL, true);
      const verdict = (yield* verdicts.forAddress(ADDRESS))(MODEL);
      expect(verdict).toMatchObject({ supported: true, source: "checked" });
      expect(verdict?.checkedAt).toBeTypeOf("string");
      expect((yield* verdicts.forAddress(ADDRESS))("other")).toBeUndefined();
      expect((yield* verdicts.forAddress("http://spark.test:8888/v1"))(MODEL)).toBeUndefined();
    }).pipe(Effect.provide(InferenceImageVerdicts.layerMemory())),
  );

  it.effect("keeps verdicts across a restart", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "houston-image-verdicts-"));
    const dbPath = NodePath.join(directory, "state.sqlite");
    const layer = InferenceImageVerdicts.layer.pipe(
      Layer.provide(
        SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const verdicts = yield* InferenceImageVerdicts.InferenceImageVerdicts;
        yield* verdicts.record(ADDRESS, MODEL, false);
      }).pipe(Effect.provide(Layer.fresh(layer)));
      const verdict = yield* Effect.gen(function* () {
        const verdicts = yield* InferenceImageVerdicts.InferenceImageVerdicts;
        return (yield* verdicts.forAddress(ADDRESS))(MODEL);
      }).pipe(Effect.provide(Layer.fresh(layer)));
      expect(verdict).toMatchObject({ supported: false, source: "checked" });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  });

  it.effect("serializes writes, so an older verdict never lands last", () =>
    Effect.gen(function* () {
      const releaseFirst = yield* Deferred.make<void>();
      const firstStarted = yield* Deferred.make<void>();
      const started = { value: false };
      const stored = new Map<string, boolean>();
      const service = yield* InferenceImageVerdicts.__testing.makeWith(
        new Map(),
        (_address, _model, verdict) =>
          Effect.gen(function* () {
            if (!started.value) {
              started.value = true;
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            stored.set(MODEL, verdict.supported);
          }),
      );
      const first = yield* service
        .record(ADDRESS, MODEL, true)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstStarted);
      const second = yield* service
        .record(ADDRESS, MODEL, false)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(stored.get(MODEL)).toBe(false);
      expect((yield* service.forAddress(ADDRESS))(MODEL)).toMatchObject({ supported: false });
    }),
  );
});
