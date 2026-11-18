// The one-time import of Houston 1's Notion tracker links as issue-backed task links.
// @effect-diagnostics nodeBuiltinImport:off - builds v1 databases in temporary directories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@houston-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as HoustonTaskV1Import from "../houston/tasks/V1Import.ts";
import { createProject, layerIssueImport } from "../houston/tasks/tasks.testkit.ts";
import { writeV1Database } from "../houston/tasks/v1Fixture.ts";
import { HoustonIssueV1Import } from "./V1Import.ts";
import { v1Settings, v1Snapshot, writeV1TrackerTables } from "./v1TrackerFixture.ts";

const WINDOWS = HostProcess.Platform.defaultValue() === "win32";
const ROOT = WINDOWS ? "C:\\work\\shop" : "/work/shop";
const SOURCE = "0123456789abcdef0123456789abcdef";

interface Dirs {
  readonly baseDir: string;
  readonly source: string;
}

const withChannel = <A, E, R>(body: (dirs: Dirs) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const channel = yield* fs.makeTempDirectoryScoped({ prefix: "houston-v1-issues-" });
    const baseDir = NodePath.join(channel, "v2");
    NodeFS.mkdirSync(baseDir);
    return yield* body({ baseDir, source: NodePath.join(channel, "houston.db") });
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const page = (n: number) => {
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const writeV1 = (source: string) => {
  writeV1Database(source, {
    nextNumber: 4,
    tasks: [1, 2, 3].map((n) => ({
      id: n,
      workspace: ROOT,
      number: n,
      title: `Page ${n}`,
      description: `Body ${n}`,
      status: "todo",
      createdAtMs: 1_700_000_000_000 + n,
    })),
  });
  writeV1TrackerTables(source, {
    settings: [
      v1Settings(ROOT, "notion", {
        notion_data_source_id: SOURCE,
        notion_title_property_id: "title",
        notion_status_property_id: "status",
        notion_description_property_id: "desc",
        notion_pr_url_property_id: "pr",
      }),
    ],
    links: [
      ...[1, 2, 3].map((n) => ({
        taskId: n,
        provider: "notion",
        externalId: page(n === 2 ? 1 : n),
        url: `https://www.notion.so/${page(n === 2 ? 1 : n).replaceAll("-", "")}`,
        snapshot: JSON.stringify(v1Snapshot({ title: `Page ${n}`, status: "todo" })),
      })),
      {
        taskId: 1,
        provider: "github_issues",
        externalId: "octo-org/project#7",
        url: "https://github.com/octo-org/project/issues/7",
        snapshot: JSON.stringify(v1Snapshot({ title: "Issue 7", status: "todo" })),
      },
    ],
    pollState: [{ workspace: ROOT, provider: "notion" }],
  });
};

const services = Effect.gen(function* () {
  return {
    tasks: yield* HoustonTaskV1Import.HoustonTaskV1Import,
    issues: yield* HoustonIssueV1Import,
    sql: yield* SqlClient.SqlClient,
  };
});

describe("Houston 1 Notion links become issue links", () => {
  it.effect("blocked before the Tasks import, available after, imported once", () =>
    withChannel((dirs) => {
      writeV1(dirs.source);
      return Effect.gen(function* () {
        const { tasks, issues } = yield* services;
        yield* createProject("shop", ROOT);
        const before = yield* issues.status;
        assert.strictEqual(before.state, "blocked");
        yield* tasks.run;
        assert.deepEqual(yield* issues.status, {
          state: "available",
          source: dirs.source,
          links: 3,
        });
        const result = yield* issues.run;
        assert.deepEqual(result.imported, { links: 2, skipped: 1 });
        assert.include(result.notes.join("\n"), "1 Notion binding");
        const imported = yield* issues.status;
        assert.strictEqual(imported.state, "imported");
        if (imported.state === "imported") {
          assert.deepEqual(imported.counts, { links: 2, skipped: 1 });
        }
        const refused = yield* Effect.flip(issues.run);
        assert.strictEqual(refused.reason, "failed");
      }).pipe(Effect.provide(layerIssueImport({ baseDir: dirs.baseDir })));
    }),
  );

  it.effect("the project is bound and each page is the task's issue", () =>
    withChannel((dirs) => {
      writeV1(dirs.source);
      return Effect.gen(function* () {
        const { tasks, issues, sql } = yield* services;
        yield* createProject("shop", ROOT);
        yield* tasks.run;
        yield* issues.run;
        const bindings = yield* sql<{
          readonly project_id: string;
          readonly tracker: string;
          readonly scope: string;
          readonly properties_json: string;
        }>`SELECT * FROM issue_tracker_bindings`;
        assert.deepEqual(
          bindings.map((row) => [row.tracker, row.scope]),
          [["notion", SOURCE]],
        );
        assert.include(bindings[0]?.properties_json ?? "", '"title":"title"');
        assert.include(bindings[0]?.properties_json ?? "", '"prUrl":"pr"');
        const links = yield* sql<{
          readonly task_id: number;
          readonly tracker: string;
          readonly key: string;
          readonly title: string;
        }>`SELECT task_id, tracker, key, title FROM houston_task_issues ORDER BY task_id`;
        assert.deepEqual(
          links.map((row) => [row.task_id, row.tracker, row.key, row.title]),
          [
            [1, "notion", page(1).replaceAll("-", ""), "Page 1"],
            [3, "notion", page(3).replaceAll("-", ""), "Page 3"],
          ],
        );
      }).pipe(Effect.provide(layerIssueImport({ baseDir: dirs.baseDir })));
    }),
  );

  it.effect("unavailable without a Houston 1 database beside the base dir", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        const { issues } = yield* services;
        assert.deepEqual(yield* issues.status, { state: "unavailable" });
      }).pipe(Effect.provide(layerIssueImport({ baseDir: dirs.baseDir }))),
    ),
  );
});
