// @effect-diagnostics nodeBuiltinImport:off - reads server.ts and lays out a database file.
// The poll loop under a test clock, failed polls, the per-poll token and the poller's assembly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { createProject } from "../tasks/tasks.testkit.ts";
import { GitHubRequestTimeout } from "./GitHubSource.ts";
import { HoustonTaskSourcePoller } from "./Poller.ts";
import { HoustonTaskSourceService } from "./SourceService.ts";
import {
  githubIssue,
  issuePages,
  layerSources,
  makeGithubFake,
  makeNotionFake,
  notionPage,
  notionServes,
  notionSettings,
  type GithubFake,
  type SourcesTestOptions,
} from "./taskSources.testkit.ts";

const GITHUB = { enabled: true, githubRepository: "octo-org/project", githubLabel: "import" };

const pageRequests = (fake: GithubFake) =>
  fake.requests.filter((request) => request.url.includes("/repos/octo-org/project/issues")).length;

describe("enabled sources poll every 20 seconds and on sync now", () => {
  it.effect("enabled sources poll every 20 seconds and on sync now", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-sources-poll-" });
      const options: SourcesTestOptions = {
        databaseFile: NodePath.join(dir, "state.sqlite"),
        baseDir: dir,
      };
      const github = makeGithubFake();
      issuePages(github, () => [githubIssue(1)]);
      const [projectId, disabledId] = yield* Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const enabled = yield* createProject("polled", "/work/polled");
        const disabled = yield* createProject("idle", "/work/idle");
        yield* sources.setSettings({
          projectId: enabled,
          provider: "github_issues",
          settings: GITHUB,
        });
        yield* sources.setSettings({
          projectId: disabled,
          provider: "github_issues",
          settings: { ...GITHUB, enabled: false, githubRepository: "octo-org/idle" },
        });
        return [enabled, disabled] as const;
      }).pipe(Effect.provide(layerSources({ ...options, github: makeGithubFake() })));

      yield* Effect.gen(function* () {
        // The loop starts with the layer: a poll at 0, 20 and 40 seconds.
        yield* TestClock.adjust(0);
        assert.strictEqual(pageRequests(github), 1);
        yield* TestClock.adjust(Duration.seconds(19));
        assert.strictEqual(pageRequests(github), 1);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.strictEqual(pageRequests(github), 2);
        yield* TestClock.adjust(Duration.seconds(20));
        assert.strictEqual(pageRequests(github), 3);
        assert.isFalse(github.requests.some((request) => request.url.includes("octo-org/idle")));

        // Sync now polls at once and answers with the poll's result.
        const sources = yield* HoustonTaskSourceService;
        const synced = yield* sources.syncNow({ projectId });
        assert.strictEqual(pageRequests(github), 4);
        assert.deepEqual(Object.keys(synced).toSorted(), ["error", "lastSyncAt", "provider"]);
        assert.strictEqual(synced.provider, "github_issues");
        assert.isNull(synced.error);
        assert.isString(synced.lastSyncAt);

        const idle = yield* createProject("never-enabled", "/work/never");
        const none = yield* Effect.flip(sources.syncNow({ projectId: idle }));
        assert.strictEqual(none.kind, "invalid");
        assert.include(none.message, "no task source is enabled for this project");

        // Sync now on a project whose source is stored but disabled sends nothing.
        const requestsBefore = github.requests.length;
        const disabled = yield* Effect.flip(sources.syncNow({ projectId: disabledId }));
        assert.strictEqual(disabled.kind, "invalid");
        assert.include(disabled.message, "no task source is enabled for this project");
        assert.strictEqual(github.requests.length, requestsBefore);
        assert.isFalse(github.requests.some((request) => request.url.includes("octo-org/idle")));
      }).pipe(Effect.provide(layerSources({ ...options, github })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("a failed poll keeps tasks and names the failure", () => {
  const RESET_SECONDS = 600;
  const failures: ReadonlyArray<{
    readonly name: string;
    readonly answer: () => Response | "stall";
    readonly named: ReadonlyArray<string>;
  }> = [
    { name: "401", answer: () => new Response("{}", { status: 401 }), named: ["HTTP 401"] },
    {
      name: "rate limit",
      answer: () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_SECONDS) },
        }),
      named: ["rate limit", "1970-01-01T00:10:00.000Z"],
    },
    {
      name: "502",
      answer: () => new Response("bad gateway", { status: 502 }),
      named: ["HTTP 502"],
    },
  ];

  it.effect.each(failures)("$name", ({ answer, named }) => {
    const github = makeGithubFake();
    return Effect.gen(function* () {
      const sources = yield* HoustonTaskSourceService;
      const poller = yield* HoustonTaskSourcePoller;
      const sql = yield* SqlClient.SqlClient;
      const projectId = yield* createProject("failing");
      yield* sources.setSettings({ projectId, provider: "github_issues", settings: GITHUB });
      issuePages(github, () => [githubIssue(1), githubIssue(2)]);
      assert.isNull((yield* poller.poll(projectId, "github_issues"))?.error);
      const state = () =>
        Effect.all([
          sql`SELECT id, revision, title, status FROM houston_tasks ORDER BY id`,
          sql`SELECT cursor_json FROM houston_task_source_poll`,
          sql`SELECT snapshot_json FROM houston_task_source_links ORDER BY task_id`,
        ]).pipe(Effect.map((rows) => JSON.stringify(rows)));
      const before = yield* state();

      const healthy = github.respond;
      github.respond = () => answer();
      const failed = yield* poller.poll(projectId, "github_issues");
      assert.include(failed?.error ?? "", "GitHub issue poll of octo-org/project page 1");
      for (const part of named) assert.include(failed?.error ?? "", part);
      assert.strictEqual(yield* state(), before);
      const [github_] = yield* sources.getSettings({ projectId });
      assert.strictEqual(github_?.lastError, failed?.error);

      // The next successful poll clears the error.
      github.respond = healthy;
      yield* TestClock.adjust(Duration.seconds(RESET_SECONDS));
      const recovered = yield* poller.poll(projectId, "github_issues");
      assert.isNull(recovered?.error);
      assert.isNull((yield* sources.getSettings({ projectId }))[0]?.lastError);
    }).pipe(Effect.provide(layerSources({ github })));
  });
});

describe("a stalled response is named by its timeout", () => {
  // The same rule as the table above, on the real clock with a short deadline.
  it.live("a failed poll keeps tasks and names the failure: a stalled response", () => {
    const github = makeGithubFake();
    return Effect.gen(function* () {
      const sources = yield* HoustonTaskSourceService;
      const poller = yield* HoustonTaskSourcePoller;
      const sql = yield* SqlClient.SqlClient;
      const projectId = yield* createProject("stalled");
      yield* sources.setSettings({ projectId, provider: "github_issues", settings: GITHUB });
      issuePages(github, () => [githubIssue(1)]);
      assert.isNull((yield* poller.poll(projectId, "github_issues"))?.error);
      const before = JSON.stringify(
        yield* Effect.all([
          sql`SELECT id, revision FROM houston_tasks`,
          sql`SELECT cursor_json FROM houston_task_source_poll`,
        ]),
      );
      const healthy = github.respond;
      github.respond = () => "stall";
      const failed = yield* poller.poll(projectId, "github_issues");
      assert.include(failed?.error ?? "", "GitHub issue poll of octo-org/project page 1");
      assert.include(failed?.error ?? "", "no response within 0.2 seconds");
      const after = JSON.stringify(
        yield* Effect.all([
          sql`SELECT id, revision FROM houston_tasks`,
          sql`SELECT cursor_json FROM houston_task_source_poll`,
        ]),
      );
      assert.strictEqual(after, before);
      github.respond = healthy;
      assert.isNull((yield* poller.poll(projectId, "github_issues"))?.error);
    }).pipe(
      Effect.provide(layerSources({ github })),
      Effect.provideService(GitHubRequestTimeout, Duration.millis(200)),
    );
  });
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

  it("the server's layer builds it with the OS keychain and upstream's GitHub client", () => {
    const server = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../../server.ts"),
      "utf8",
    );
    const assemblies = server.match(/layerTaskSources\(/g) ?? [];
    assert.lengthOf(assemblies, 1);
    const call = server.slice(
      server.indexOf("layerTaskSources("),
      server.indexOf("layerTaskSources(") + 200,
    );
    assert.include(call, "GitHubRest.layerWithDependencies");
    assert.include(call, "HoustonTaskSourceNotion.layer");
    assert.lengthOf(server.match(/HoustonKeychain\.layerLive/g) ?? [], 1);
  });
});
