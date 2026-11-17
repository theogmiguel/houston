// @effect-diagnostics nodeBuiltinImport:off - reads server.ts and lays out a database file.
// The poll loop under a test clock, failed polls, the per-poll token and the poller's assembly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { createProject } from "../tasks/tasks.testkit.ts";
import { HoustonTaskSourcePoller } from "./Poller.ts";
import { HoustonTaskSourceService } from "./SourceService.ts";
import {
  layerSources,
  makeNotionFake,
  notionPage,
  notionServes,
  notionSettings,
  type NotionFake,
} from "./taskSources.testkit.ts";

const pageQueries = (fake: NotionFake) =>
  fake.requests.filter((request) => request.method === "POST" && request.path.endsWith("/query"))
    .length;

describe("enabled sources poll every 20 seconds and on sync now", () => {
  it.effect("enabled sources poll and sync now polls at once", () =>
    Effect.gen(function* () {
      const notion = yield* makeNotionFake;
      notionServes(notion, () => [notionPage(1)]);
      yield* Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const poller = yield* HoustonTaskSourcePoller;
        const projectId = yield* createProject("polled", "/work/polled");
        const disabledId = yield* createProject("idle", "/work/idle");
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make("ntn_polled"),
        });
        yield* sources.setSettings({
          projectId,
          provider: "notion",
          settings: notionSettings(),
        });
        yield* sources.setSettings({
          projectId: disabledId,
          provider: "notion",
          settings: notionSettings({ enabled: false }),
        });
        yield* poller.pollAll;
        assert.strictEqual(pageQueries(notion), 1);
        yield* poller.pollAll;
        assert.strictEqual(pageQueries(notion), 2);

        // Sync now polls at once and answers with the poll's result.
        const synced = yield* sources.syncNow({ projectId });
        assert.strictEqual(pageQueries(notion), 3);
        assert.deepEqual(Object.keys(synced).toSorted(), ["error", "lastSyncAt", "provider"]);
        assert.strictEqual(synced.provider, "notion");
        assert.isNull(synced.error);
        assert.isString(synced.lastSyncAt);

        const idle = yield* createProject("never-enabled", "/work/never");
        const none = yield* Effect.flip(sources.syncNow({ projectId: idle }));
        assert.strictEqual(none.kind, "invalid");
        assert.include(none.message, "no task source is enabled for this project");

        // Sync now on a project whose source is stored but disabled sends nothing.
        const before = pageQueries(notion);
        const disabled = yield* Effect.flip(sources.syncNow({ projectId: disabledId }));
        assert.strictEqual(disabled.kind, "invalid");
        assert.include(disabled.message, "no task source is enabled for this project");
        assert.strictEqual(pageQueries(notion), before);
      }).pipe(Effect.provide(layerSources({ notionOrigin: notion.origin })));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

describe("a failed poll keeps tasks and names the failure", () => {
  const failures: ReadonlyArray<{
    readonly name: string;
    readonly status: number;
    readonly named: ReadonlyArray<string>;
  }> = [
    { name: "401", status: 401, named: ["HTTP 401"] },
    { name: "502", status: 502, named: ["HTTP 502"] },
  ];

  it.effect.each(failures)("$name", ({ status, named }) =>
    makeNotionFake.pipe(
      Effect.flatMap((notion) => {
        let failing = false;
        notionServes(notion, () => [notionPage(1), notionPage(2)], {
          extra: (request) =>
            failing && request.method === "POST" && request.path.endsWith("/query")
              ? { status, body: { object: "error" } }
              : null,
        });
        return Effect.gen(function* () {
          const sources = yield* HoustonTaskSourceService;
          const poller = yield* HoustonTaskSourcePoller;
          const sql = yield* SqlClient.SqlClient;
          const projectId = yield* createProject("failing");
          yield* sources.setCredential({
            projectId,
            provider: "notion",
            token: Redacted.make("ntn_failing"),
          });
          yield* sources.setSettings({ projectId, provider: "notion", settings: notionSettings() });
          assert.isNull((yield* poller.poll(projectId, "notion"))?.error);
          const state = () =>
            Effect.all([
              sql`SELECT id, revision, title, status FROM houston_tasks ORDER BY id`,
              sql`SELECT cursor_json FROM houston_task_source_poll`,
              sql`SELECT snapshot_json FROM houston_task_source_links ORDER BY task_id`,
            ]).pipe(Effect.map((rows) => JSON.stringify(rows)));
          const before = yield* state();

          failing = true;
          const failed = yield* poller.poll(projectId, "notion");
          assert.include(failed?.error ?? "", "Notion request to v1/data_sources/");
          for (const part of named) assert.include(failed?.error ?? "", `${part}`);
          assert.strictEqual(yield* state(), before);
          const [notionSettingsAfter] = yield* sources.getSettings({ projectId });
          assert.strictEqual(notionSettingsAfter?.lastError, failed?.error);

          // The next successful poll clears the error.
          failing = false;
          const recovered = yield* poller.poll(projectId, "notion");
          assert.isNull(recovered?.error);
          assert.isNull((yield* sources.getSettings({ projectId }))[0]?.lastError);
        }).pipe(Effect.provide(layerSources({ notionOrigin: notion.origin })));
      }),
      Effect.scoped,
    ),
  );
});

describe("each poll reads the current token", () => {
  it.effect("each poll reads the current token", () =>
    Effect.gen(function* () {
      const notion = yield* makeNotionFake;
      notionServes(notion, () => [notionPage(1)]);
      yield* Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const poller = yield* HoustonTaskSourcePoller;
        const projectId = yield* createProject("rotating");
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make("ntn_first"),
        });
        yield* sources.setSettings({ projectId, provider: "notion", settings: notionSettings() });
        notion.requests.length = 0;
        yield* poller.poll(projectId, "notion");
        assert.isNotEmpty(notion.requests);
        assert.isTrue(
          notion.requests.every((request) => request.authorization === "Bearer ntn_first"),
        );
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make("ntn_second"),
        });
        notion.requests.length = 0;
        yield* poller.poll(projectId, "notion");
        assert.isNotEmpty(notion.requests);
        assert.isTrue(
          notion.requests.every((request) => request.authorization === "Bearer ntn_second"),
        );
      }).pipe(Effect.provide(layerSources({ notionOrigin: notion.origin })));
    }).pipe(Effect.scoped),
  );
});

describe("the server and the harness start one poller", () => {
  it.effect("the server and the harness start one poller", () =>
    Effect.gen(function* () {
      const poller = yield* HoustonTaskSourcePoller;
      assert.strictEqual(yield* poller.loopsStarted, 1);
    }).pipe(Effect.provide(layerSources())),
  );

  it("the server's layer builds it with the secret store and the Notion client", () => {
    const server = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../../server.ts"),
      "utf8",
    );
    const assemblies = server.match(/layerTaskSources\(/g) ?? [];
    assert.lengthOf(assemblies, 1);
    const call = server.slice(
      server.indexOf("layerTaskSources("),
      server.indexOf("layerTaskSources(") + 120,
    );
    assert.include(call, "HoustonTaskSourceNotion.layer");
    assert.notInclude(call, "GitHubRest");
    assert.lengthOf(server.match(/HoustonSecrets\.layer\b/g) ?? [], 1);
  });
});
