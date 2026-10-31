import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerConfig from "../config.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import * as HoustonAnalytics from "./analytics.ts";

it.layer(NodeServices.layer)("houston analytics", (it) => {
  it.effect("the analytics service sends and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const requests: Array<string> = [];
      const failingClient = HttpClient.make((request) =>
        Effect.sync(() => requests.push(request.url)).pipe(
          Effect.andThen(Effect.die(new Error(`unexpected request to ${request.url}`))),
        ),
      );
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "houston-analytics-cwd-" });
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "houston-analytics-base-" });

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService;
        // Past upstream's flush batch size of 20.
        for (let index = 0; index < 25; index += 1) {
          yield* analytics.record("houston.test.event", { index });
        }
        yield* analytics.recordOwners([{ source: "claude", ownerId: "owner" }], "server");
        yield* analytics.flush;
        const config = yield* ServerConfig.ServerConfig;
        expect(yield* fs.exists(config.anonymousIdPath)).toBe(false);
      }).pipe(
        Effect.provide(
          HoustonAnalytics.layer.pipe(
            Layer.provideMerge(ServerConfig.ServerConfig.layerTest(cwd, base)),
            Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, failingClient)),
          ),
        ),
      );

      expect(requests).toEqual([]);
    }),
  );
});
