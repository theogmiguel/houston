// @effect-diagnostics nodeBuiltinImport:off - hashes v1 files and holds them open in WAL mode.
// The one-time import of Houston 1's task source connections, after the Tasks import.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { makeMemory } from "../secrets/HoustonKeychain.ts";
import * as HoustonTaskV1Import from "../tasks/V1Import.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { writeV1Database } from "../tasks/v1Fixture.ts";
import { HoustonTaskSourcePoller } from "./Poller.ts";
import { HoustonTaskSourceService } from "./SourceService.ts";
import { HoustonTaskSourceStore } from "./SourceStore.ts";
import {
  githubIssue,
  issuePages,
  layerSources,
  makeGithubFake,
  type SourcesTestOptions,
} from "./taskSources.testkit.ts";
import { HoustonTaskSourceV1Import } from "./V1Import.ts";
import {
  v1Settings,
  v1Snapshot,
  writeV1TrackerTables,
  type V1TrackerFixture,
} from "./v1TrackerFixture.ts";

const WINDOWS = HostProcess.Platform.defaultValue() === "win32";
const ROOT = WINDOWS ? "C:\\work\\shop" : "/work/shop";
const GONE = WINDOWS ? "C:\\work\\gone" : "/work/gone";
const NAMESPACE = "feedfacefeedfacefeedfacefeedface";

interface Dirs {
  readonly channel: string;
  readonly baseDir: string;
  readonly source: string;
}

const withChannel = <A, E, R>(body: (dirs: Dirs) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const channel = yield* fs.makeTempDirectoryScoped({ prefix: "houston-v1-sources-" });
    const baseDir = NodePath.join(channel, "v2");
    NodeFS.mkdirSync(baseDir);
    return yield* body({ channel, baseDir, source: NodePath.join(channel, "houston.db") });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const issueSnapshot = (n: number) =>
  JSON.stringify(v1Snapshot({ title: `Issue ${n}`, description: `Body ${n}`, status: "todo" }));

/** v1 with three imported issues in a matched workspace, plus everything the import drops. */
const writeV1 = (
  source: string,
  tracker: Partial<V1TrackerFixture> = {},
  options: { wal?: boolean } = {},
) => {
  writeV1Database(
    source,
    {
      nextNumber: 5,
      tasks: [1, 2, 3].map((n) => ({
        id: n,
        workspace: ROOT,
        number: n,
        title: `Issue ${n}`,
        description: `Body ${n}`,
        status: "todo",
        createdBy: "tracker:github_issues",
        createdAtMs: 1_700_000_000_000 + n,
      })),
    },
    options,
  );
  writeV1TrackerTables(source, {
    namespace: NAMESPACE,
    settings: [
      v1Settings(ROOT, "github_issues", {
        github_repository: "octo-org/project",
        github_label: "import",
      }),
      v1Settings(ROOT, "notion", {
        enabled: true,
        notion_data_source_id: "0123456789abcdef0123456789abcdef",
        notion_active_status_values: ["Ready"],
      }),
      v1Settings(GONE, "github_issues", { github_repository: "octo-org/gone" }),
    ],
    links: [
      ...[1, 2, 3].map((n) => ({
        taskId: n,
        provider: "github_issues",
        externalId: `octo-org/project#${n}`,
        url: `https://github.com/octo-org/project/issues/${n}`,
        snapshot:
          n === 2
            ? JSON.stringify(
                v1Snapshot(
                  { title: "Issue 2", description: "Body 2", status: "todo" },
                  {
                    conflicts: [
                      { field: "title", base: "Issue 2", local: "Issue 2", remote: "Remote 2" },
                    ],
                    remote: { title: "Remote 2", description: "Body 2", status: "todo" },
                  },
                ),
              )
            : issueSnapshot(n),
        syncState: n === 2 ? '{"state":"diverged"}' : '{"state":"current"}',
      })),
      {
        taskId: 1,
        provider: "slack",
        externalId: "C1/1",
        url: "https://slack.example/1",
        snapshot: issueSnapshot(1),
      },
    ],
    outbox: [{ workspace: ROOT, taskId: 1 }],
    pollState: [{ workspace: ROOT, provider: "github_issues" }],
    refreshCursors: [{ workspace: ROOT, provider: "notion" }],
    ...tracker,
  });
};

const services = Effect.gen(function* () {
  return {
    tasksImport: yield* HoustonTaskV1Import.HoustonTaskV1Import,
    sourcesImport: yield* HoustonTaskSourceV1Import,
    sources: yield* HoustonTaskSourceService,
    store: yield* HoustonTaskSourceStore,
    sql: yield* SqlClient.SqlClient,
  };
});

const sourceCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Record<string, number>>`
    SELECT (SELECT COUNT(*) FROM houston_task_source_settings) AS settings,
      (SELECT COUNT(*) FROM houston_task_source_links) AS links,
      (SELECT COUNT(*) FROM houston_task_source_identity) AS identity,
      (SELECT COUNT(*) FROM houston_task_source_import) AS imports,
      (SELECT COUNT(*) FROM houston_task_source_poll) AS polls,
      (SELECT COUNT(*) FROM houston_task_source_outbox) AS outbox
  `;
  return row;
});

const options = (dirs: Dirs, extra: Partial<SourcesTestOptions> = {}): SourcesTestOptions => ({
  baseDir: dirs.baseDir,
  ...extra,
});

describe("import status names each state", () => {
  it.effect("no source and an unhosted server are unavailable", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        const { sourcesImport } = yield* services;
        assert.deepEqual(yield* sourcesImport.status, { state: "unavailable" });
      }).pipe(Effect.provide(layerSources(options(dirs)))),
    ),
  );

  it.effect("an unhosted server is unavailable beside a v1 database", () =>
    withChannel((dirs) => {
      writeV1(dirs.source);
      return Effect.gen(function* () {
        const { sourcesImport } = yield* services;
        assert.deepEqual(yield* sourcesImport.status, { state: "unavailable" });
      }).pipe(Effect.provide(layerSources(options(dirs, { hosted: false }))));
    }),
  );

  it.effect("blocked before the Tasks import, available after, imported after a run", () =>
    withChannel((dirs) => {
      writeV1(dirs.source);
      return Effect.gen(function* () {
        const { tasksImport, sourcesImport } = yield* services;
        yield* createProject("shop", ROOT);
        const before = yield* sourcesImport.status;
        assert.strictEqual(before.state, "blocked");
        if (before.state === "blocked") assert.include(before.reason, "tasks import");
        yield* tasksImport.run;
        assert.deepEqual(yield* sourcesImport.status, {
          state: "available",
          source: dirs.source,
          settings: 3,
          links: 3,
        });
        const result = yield* sourcesImport.run;
        const after = yield* sourcesImport.status;
        assert.strictEqual(after.state, "imported");
        if (after.state === "imported") assert.deepEqual(after.counts, result.imported);
      }).pipe(Effect.provide(layerSources(options(dirs))));
    }),
  );

  it.effect("present v2 links block the import", () =>
    withChannel((dirs) => {
      writeV1(dirs.source);
      return Effect.gen(function* () {
        const { tasksImport, sourcesImport, sql } = yield* services;
        const projectId = yield* createProject("shop", ROOT);
        yield* tasksImport.run;
        yield* sql`
          INSERT INTO houston_task_source_links (
            task_id, project_id, provider, external_id, source, url, snapshot_json, sync_state_json
          ) VALUES (1, ${projectId}, 'github_issues', 'x/y#1', 'source', 'u', '{}', '{}')
        `;
        const status = yield* sourcesImport.status;
        assert.strictEqual(status.state, "blocked");
        if (status.state === "blocked") assert.include(status.reason, "1 link");
      }).pipe(Effect.provide(layerSources(options(dirs))));
    }),
  );
});

describe("v1 connections arrive disabled with their links", () => {
  it.effect("v1 connections arrive disabled with their links", () =>
    withChannel((dirs) => {
      writeV1(dirs.source);
      return Effect.gen(function* () {
        const { tasksImport, sourcesImport, sources, store, sql } = yield* services;
        const projectId = yield* createProject("shop", ROOT);
        yield* tasksImport.run;
        const result = yield* sourcesImport.run;
        assert.deepEqual(result.imported, { settings: 2, links: 3 });
        const notes = result.notes.join("\n");
        for (const part of [
          "1 task source setting(s) of Houston 1 workspaces that match no project",
          "1 Slack link(s)",
          "1 pending write-back row(s)",
          "1 poll cursor(s)",
          "1 refresh cursor(s)",
        ]) {
          assert.include(notes, part);
        }
        const [github, notion] = yield* sources.getSettings({ projectId });
        assert.deepInclude(github, {
          enabled: false,
          githubRepository: "octo-org/project",
          githubLabel: "import",
          hasCredential: false,
        });
        assert.deepInclude(notion, { enabled: false, hasCredential: false });
        assert.deepEqual(notion?.notionActiveStatusValues, ["Ready"]);
        const links = yield* store.linksOf(2);
        assert.lengthOf(links, 1);
        assert.deepEqual(links[0]?.syncState, { state: "diverged" });
        assert.deepEqual(links[0]?.snapshot.conflicts, [
          { field: "title", base: "Issue 2", local: "Issue 2", remote: "Remote 2" },
        ]);
        assert.deepEqual(yield* sql`SELECT namespace FROM houston_task_source_identity`, [
          { namespace: NAMESPACE },
        ]);
        assert.deepInclude(yield* sourceCounts, { polls: 0, outbox: 0 });
      }).pipe(Effect.provide(layerSources(options(dirs))));
    }),
  );
});

describe("an imported source creates no duplicate task when enabled", () => {
  it.effect("an imported source creates no duplicate task when enabled", () =>
    withChannel((dirs) => {
      writeV1(dirs.source);
      const github = makeGithubFake();
      issuePages(github, () => [githubIssue(1), githubIssue(2), githubIssue(3)]);
      return Effect.gen(function* () {
        const { tasksImport, sourcesImport, sources, sql } = yield* services;
        const projectId = yield* createProject("shop", ROOT);
        yield* tasksImport.run;
        yield* sourcesImport.run;
        assert.deepEqual(github.requests, []);
        const [imported] = yield* sources.getSettings({ projectId });
        yield* sources.setSettings({
          projectId,
          provider: "github_issues",
          expectedRevision: imported?.revision ?? 0,
          settings: { enabled: true, githubRepository: "octo-org/project", githubLabel: "import" },
        });
        const poller = yield* HoustonTaskSourcePoller;
        const polled = yield* poller.poll(projectId, "github_issues");
        assert.isNull(polled?.error);
        assert.isNotEmpty(github.requests);
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM houston_tasks`, [{ n: 3 }]);
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM houston_task_source_links`, [
          { n: 3 },
        ]);
      }).pipe(Effect.provide(layerSources(options(dirs, { github }))));
    }),
  );
});

const digest = (file: string) =>
  NodeFS.existsSync(file)
    ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex")
    : "absent";

describe("the import reads no keychain and never writes v1", () => {
  it.effect("the import reads no keychain and never writes v1", () =>
    withChannel((dirs) => {
      writeV1(dirs.source, {}, { wal: true });
      // Another connection holds v1 open in WAL mode, as a running v1 daemon would.
      const holder = new NodeSqlite.DatabaseSync(dirs.source);
      holder.exec("PRAGMA journal_mode = WAL");
      holder.exec("INSERT INTO settings (key, value) VALUES ('held', 'open')");
      const files = [dirs.source, `${dirs.source}-wal`, `${dirs.source}-shm`];
      const keychain = makeMemory();
      return Effect.gen(function* () {
        const { tasksImport, sourcesImport } = yield* services;
        yield* createProject("shop", ROOT);
        yield* tasksImport.run;
        const before = files.map(digest);
        keychain.calls.length = 0;
        yield* sourcesImport.status;
        yield* sourcesImport.run;
        assert.deepEqual(keychain.calls, []);
        assert.deepEqual(files.map(digest), before);
      }).pipe(
        Effect.provide(layerSources(options(dirs, { keychain }))),
        Effect.ensuring(Effect.sync(() => holder.close())),
      );
    }),
  );
});

describe("a refused or failed import stores nothing", () => {
  it.effect("a second run, present links and a missing Tasks import are refused by name", () =>
    withChannel((dirs) => {
      writeV1(dirs.source);
      return Effect.gen(function* () {
        const { tasksImport, sourcesImport, sql } = yield* services;
        const projectId = yield* createProject("shop", ROOT);
        const early = yield* Effect.flip(sourcesImport.run);
        assert.strictEqual(early.kind, "invalid");
        assert.include(early.message, "tasks import");
        yield* tasksImport.run;
        yield* sql`
          INSERT INTO houston_task_source_links (
            task_id, project_id, provider, external_id, source, url, snapshot_json, sync_state_json
          ) VALUES (1, ${projectId}, 'github_issues', 'x/y#1', 'source', 'u', '{}', '{}')
        `;
        const linked = yield* Effect.flip(sourcesImport.run);
        assert.strictEqual(linked.kind, "invalid");
        assert.include(linked.message, "link");
        yield* sql`DELETE FROM houston_task_source_links`;
        yield* sourcesImport.run;
        const again = yield* Effect.flip(sourcesImport.run);
        assert.strictEqual(again.kind, "invalid");
        assert.include(again.message, "already imported");
      }).pipe(Effect.provide(layerSources(options(dirs))));
    }),
  );

  it.effect("a row that fails to copy leaves every task source table empty", () =>
    withChannel((dirs) => {
      writeV1(dirs.source, {
        links: [
          {
            taskId: 1,
            provider: "github_issues",
            externalId: "octo-org/project#1",
            url: "u1",
            snapshot: issueSnapshot(1),
          },
          {
            taskId: 2,
            provider: "github_issues",
            externalId: "octo-org/project#2",
            url: "u2",
            snapshot: "{not json",
          },
        ],
      });
      return Effect.gen(function* () {
        const { tasksImport, sourcesImport } = yield* services;
        yield* createProject("shop", ROOT);
        yield* tasksImport.run;
        const failed = yield* Effect.flip(sourcesImport.run);
        assert.strictEqual(failed.kind, "unsupported");
        assert.include(failed.message, "octo-org/project#2");
        assert.deepEqual(yield* sourceCounts, {
          settings: 0,
          links: 0,
          identity: 0,
          imports: 0,
          polls: 0,
          outbox: 0,
        });
      }).pipe(Effect.provide(layerSources(options(dirs))));
    }),
  );
});
