// Settings, credentials and project deletion through the service over the real project service,
// the memory keychain and a loopback Notion fake.
import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import { makeMemory, type MemoryKeychain } from "../secrets/HoustonKeychain.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import { createProject, deleteProject } from "../tasks/tasks.testkit.ts";
import { HoustonTaskSourcePoller, TOKEN_MISSING, TOKEN_UNAVAILABLE } from "./Poller.ts";
import { HoustonTaskSourceService } from "./SourceService.ts";
import { HoustonTaskSourceStore, sweep } from "./SourceStore.ts";
import {
  NOTION_PROJECTS,
  NOTION_SOURCE,
  layerSources,
  makeNotionFake,
  notionSchema,
  notionServes,
  notionSettings,
  type NotionFake,
} from "./taskSources.testkit.ts";

const TOKEN = "ntn_service_test_token_31a7";

const withSources = <A, E>(
  body: (
    fake: NotionFake,
    keychain: MemoryKeychain,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerSources>>>,
) =>
  Effect.gen(function* () {
    const fake = yield* makeNotionFake;
    const keychain = makeMemory();
    notionServes(fake, () => []);
    return yield* body(fake, keychain).pipe(
      Effect.provide(layerSources({ keychain, notionOrigin: fake.origin })),
    );
  }).pipe(Effect.scoped);

const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect);

describe("settings return one entry per provider with current values", () => {
  it.effect("settings return one entry per provider with current values", () =>
    withSources(() =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const projectId = yield* createProject("settings-get");
        const unset = yield* sources.getSettings({ projectId });
        assert.deepEqual(
          unset.map((entry) => [entry.provider, entry.enabled, entry.revision]),
          [
            ["github_issues", false, 0],
            ["notion", false, 0],
          ],
        );
        assert.isTrue(
          unset.every(
            (entry) =>
              entry.githubRepository === null &&
              entry.notionActiveStatusValues.length === 0 &&
              !entry.hasCredential &&
              entry.lastSyncAt === null &&
              entry.lastError === null,
          ),
        );
        yield* sources.setSettings({
          projectId,
          provider: "github_issues",
          expectedRevision: 0,
          settings: { enabled: true, githubRepository: "octo-org/project", githubLabel: "import" },
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO houston_task_source_poll (project_id, provider, cursor_json, last_sync_at, last_error)
          VALUES (${projectId}, 'github_issues', '{}', '2026-10-01T00:00:00.000Z', 'boom')
        `;
        const [github, notion] = yield* sources.getSettings({ projectId });
        assert.deepInclude(github, {
          provider: "github_issues",
          enabled: true,
          revision: 1,
          githubRepository: "octo-org/project",
          githubLabel: "import",
          hasCredential: false,
          lastSyncAt: "2026-10-01T00:00:00.000Z",
          lastError: "boom",
        });
        assert.strictEqual(notion?.revision, 0);
      }),
    ),
  );
});

describe("a refused setting stores nothing", () => {
  it.effect("a refused setting stores nothing", () =>
    withSources(() =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const projectId = yield* createProject("refused");
        for (const settings of [
          { enabled: true, githubRepository: "octo-org/project" },
          { enabled: true, githubRepository: "evil.example/path?token=x", githubLabel: "import" },
          { enabled: true, githubRepository: "a/b/c", githubLabel: "import" },
        ]) {
          const error = yield* failure(
            sources.setSettings({ projectId, provider: "github_issues", settings }),
          );
          assert.strictEqual(error.kind, "invalid");
        }
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT * FROM houston_task_source_settings`, []);
      }),
    ),
  );
});

describe("enabling notion needs a stored credential", () => {
  it.effect("enabling notion needs a stored credential", () =>
    withSources((fake) =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const projectId = yield* createProject("needs-token");
        const error = yield* failure(
          sources.setSettings({ projectId, provider: "notion", settings: notionSettings() }),
        );
        assert.strictEqual(error.kind, "credential_missing");
        assert.deepEqual(fake.requests, []);
        // Disabled settings need no token and are stored.
        const saved = yield* sources.setSettings({
          projectId,
          provider: "notion",
          settings: notionSettings({ enabled: false }),
        });
        assert.isFalse(saved.enabled);
      }),
    ),
  );
});

describe("notion settings are checked against the live schema", () => {
  it.effect("notion settings are checked against the live schema", () =>
    withSources((fake) =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const projectId = yield* createProject("schema");
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make(TOKEN),
        });
        const serveSchema = (schema: unknown, status = 200) => {
          fake.respond = (request) =>
            request.path === `/v1/data_sources/${NOTION_SOURCE}`
              ? { status, body: schema }
              : { status: 404, body: {} };
        };
        const set = (patch: Record<string, unknown> = {}) =>
          sources.setSettings({ projectId, provider: "notion", settings: notionSettings(patch) });

        serveSchema(
          notionSchema(NOTION_SOURCE, {
            Name: { id: "title", name: "Name", type: "rich_text", rich_text: {} },
          }),
        );
        const typed = yield* failure(set());
        assert.strictEqual(typed.kind, "invalid");
        assert.match(typed.message, /title/);
        assert.include(typed.message, "rich_text");

        serveSchema(notionSchema(NOTION_SOURCE));
        const missing = yield* failure(set({ notionAssigneePropertyId: "nope" }));
        assert.strictEqual(missing.kind, "invalid");
        assert.include(missing.message, '"nope"');

        const option = yield* failure(set({ notionActiveStatusValues: ["Ready", "Blocked"] }));
        assert.strictEqual(option.kind, "invalid");
        assert.include(option.message, '"Blocked"');

        serveSchema({}, 401);
        const remote = yield* failure(set());
        assert.strictEqual(remote.kind, "remote");
        assert.include(remote.message, "401");
        assert.notInclude(remote.message, TOKEN);

        serveSchema(notionSchema(NOTION_SOURCE));
        const stored = yield* set();
        assert.isTrue(stored.enabled);
        assert.isTrue(stored.hasCredential);
        assert.isTrue(
          fake.requests.every((request) => request.authorization === `Bearer ${TOKEN}`),
        );

        // A projects source is read too, and its relation must point at it.
        notionServes(fake, () => [], {
          extra: (request) =>
            request.path === `/v1/data_sources/${NOTION_SOURCE}`
              ? {
                  body: notionSchema(NOTION_SOURCE, {
                    Project: {
                      id: "rel",
                      name: "Project",
                      type: "relation",
                      relation: { data_source_id: NOTION_PROJECTS },
                    },
                  }),
                }
              : request.path === `/v1/data_sources/${NOTION_PROJECTS}`
                ? {
                    body: notionSchema(NOTION_PROJECTS, {
                      Name: { id: "ptitle", name: "Name", type: "title", title: {} },
                    }),
                  }
                : null,
        });
        const withProjects = yield* set({
          notionProjectsDataSourceId: NOTION_PROJECTS,
          notionProjectRelationPropertyId: "rel",
          notionProjectTitlePropertyId: "ptitle",
        });
        assert.strictEqual(withProjects.notionProjectsDataSourceId, NOTION_PROJECTS);
      }),
    ),
  );
});

describe("a stale settings revision is refused", () => {
  it.effect("a stale settings revision is refused", () =>
    withSources(() =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const projectId = yield* createProject("stale");
        const settings = { enabled: false, githubRepository: "octo-org/project" };
        const first = yield* sources.setSettings({
          projectId,
          provider: "github_issues",
          expectedRevision: 0,
          settings,
        });
        assert.strictEqual(first.revision, 1);
        const second = yield* sources.setSettings({
          projectId,
          provider: "github_issues",
          expectedRevision: 1,
          settings: { ...settings, githubLabel: "import" },
        });
        assert.strictEqual(second.revision, 2);
        const stale = yield* failure(
          sources.setSettings({
            projectId,
            provider: "github_issues",
            expectedRevision: 1,
            settings: { ...settings, githubLabel: "other" },
          }),
        );
        assert.deepInclude(stale, { kind: "conflict", expected: 1, actual: 2 });
        const [after] = yield* sources.getSettings({ projectId });
        assert.strictEqual(after?.githubLabel, "import");
        assert.strictEqual(after?.revision, 2);
      }),
    ),
  );
});

describe("a notion token goes to the keychain only", () => {
  it.effect("a notion token goes to the keychain only", () =>
    withSources((_fake, keychain) =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const store = yield* HoustonTaskSourceStore;
        const projectId = yield* createProject("token");
        const result = yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make(`  ${TOKEN}  `),
        });
        assert.deepEqual(result, { hasCredential: true });
        const service = store.tokenService(projectId, "notion");
        assert.match(service, /^houston-v2-tracker-notion-[0-9a-f]{16}$/);
        assert.deepEqual([...keychain.entries], [[`${service}\u0000integration-token`, TOKEN]]);

        const blank = yield* failure(
          sources.setCredential({ projectId, provider: "notion", token: Redacted.make("   ") }),
        );
        assert.strictEqual(blank.kind, "invalid");
        const fits = yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make("x".repeat(2_048)),
        });
        assert.isTrue(fits.hasCredential);
        // Windows Credential Manager holds about 2,560 bytes per secret: one bound everywhere.
        const over = yield* failure(
          sources.setCredential({
            projectId,
            provider: "notion",
            token: Redacted.make("x".repeat(2_049)),
          }),
        );
        assert.deepInclude(over, {
          kind: "limit",
          limit: 2_048,
          actual: 2_049,
          operation: "houston.taskSources.credential.set",
        });
        assert.include(over.message, "houston.taskSources.credential.set");
        assert.include(over.message, "2049 bytes");
        assert.include(over.message, "2048 bytes");
        assert.include(over.message, "Notion integration token");
        assert.strictEqual(
          keychain.entries.get(`${service}\u0000integration-token`),
          "x".repeat(2_048),
        );
        const github = yield* failure(
          sources.setCredential({
            projectId,
            provider: "github_issues",
            token: Redacted.make(TOKEN),
          }),
        );
        assert.strictEqual(github.kind, "unsupported");
        assert.include(github.message, "Settings ▸ Source Control");
        assert.notInclude(github.message, TOKEN);
        const sql = yield* SqlClient.SqlClient;
        const dump = JSON.stringify([
          yield* sql`SELECT * FROM houston_task_source_settings`,
          yield* sql`SELECT * FROM houston_task_source_poll`,
        ]);
        assert.notInclude(dump, TOKEN);
      }),
    ),
  );
});

describe("an unreachable keychain is refused by name", () => {
  it.effect("an unreachable keychain is refused by name", () =>
    withSources((fake, keychain) =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const poller = yield* HoustonTaskSourcePoller;
        const projectId = yield* createProject("no-keychain");
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make(TOKEN),
        });
        yield* sources.setSettings({ projectId, provider: "notion", settings: notionSettings() });
        fake.requests.length = 0;
        keychain.failWith = "org.freedesktop.secrets was not provided by any .service files";
        keychain.entries.clear();
        const refused = yield* failure(
          sources.setCredential({ projectId, provider: "notion", token: Redacted.make(TOKEN) }),
        );
        assert.strictEqual(refused.kind, "keychain_unavailable");
        assert.include(refused.message, "org.freedesktop.secrets was not provided");
        assert.notInclude(refused.message, TOKEN);
        assert.strictEqual(keychain.entries.size, 0);
        const [, notion] = yield* sources.getSettings({ projectId });
        assert.isFalse(notion?.hasCredential);
        const polled = yield* poller.poll(projectId, "notion");
        assert.strictEqual(polled?.error, TOKEN_UNAVAILABLE);
        assert.deepEqual(fake.requests, []);
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        assert.strictEqual((yield* tasks.listInitiatives({ projectId })).length, 0);
      }),
    ),
  );
});

describe("clearing the token stops the next poll", () => {
  it.effect("clearing the token stops the next poll", () =>
    withSources((fake, keychain) =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const poller = yield* HoustonTaskSourcePoller;
        const projectId = yield* createProject("clear");
        yield* sources.setCredential({
          projectId,
          provider: "notion",
          token: Redacted.make(TOKEN),
        });
        yield* sources.setSettings({ projectId, provider: "notion", settings: notionSettings() });
        assert.deepEqual(yield* sources.clearCredential({ projectId, provider: "notion" }), {
          hasCredential: false,
        });
        assert.strictEqual(keychain.entries.size, 0);
        yield* sources.clearCredential({ projectId, provider: "notion" });
        const [, notion] = yield* sources.getSettings({ projectId });
        assert.isFalse(notion?.hasCredential);
        fake.requests.length = 0;
        const polled = yield* poller.poll(projectId, "notion");
        assert.strictEqual(polled?.error, TOKEN_MISSING);
        assert.deepEqual(fake.requests, []);
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM houston_tasks`, [{ n: 0 }]);
      }),
    ),
  );
});

describe("deleting a project removes its sources and token", () => {
  it.effect("deleting a project removes its sources and token", () =>
    withSources((_fake, keychain) =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const store = yield* HoustonTaskSourceStore;
        const sql = yield* SqlClient.SqlClient;
        const doomed = yield* createProject("doomed");
        const kept = yield* createProject("kept");
        for (const projectId of [doomed, kept] as Array<ProjectId>) {
          yield* sources.setCredential({
            projectId,
            provider: "notion",
            token: Redacted.make(TOKEN),
          });
          yield* sources.setSettings({
            projectId,
            provider: "github_issues",
            settings: {
              enabled: false,
              githubRepository: "octo-org/project",
              githubLabel: "import",
            },
          });
          yield* sql`
            INSERT INTO houston_task_source_poll (project_id, provider, cursor_json)
            VALUES (${projectId}, 'github_issues', '{}')
          `;
        }
        const tasks = yield* HoustonTaskService.HoustonTaskService;
        const task = yield* tasks.save({ patch: { title: "linked", projectId: doomed } });
        yield* sql`
          INSERT INTO houston_task_source_links (
            task_id, project_id, provider, external_id, source, url, snapshot_json, sync_state_json
          ) VALUES (
            ${task.id}, ${doomed}, 'github_issues', 'octo-org/project#1', 'source', 'u',
            '{"base":{},"local":{},"remote":{},"conflicts":[],"revision":1,"projectExternalId":null,"project":null}',
            '{"state":"current"}'
          )
        `;
        yield* deleteProject(doomed);
        const left = (yield* sql<{ readonly project_id: string }>`
          SELECT project_id FROM houston_task_source_settings
          UNION ALL SELECT project_id FROM houston_task_source_poll
        `).map((row) => row.project_id);
        assert.deepEqual(left, [kept, kept]);
        const keychainOf = (projectId: string) =>
          keychain.entries.has(`${store.tokenService(projectId, "notion")}\u0000integration-token`);
        assert.isFalse(keychainOf(doomed));
        assert.isTrue(keychainOf(kept));
        assert.strictEqual((yield* store.linksOf(task.id)).length, 1);
      }),
    ),
  );

  it.effect("deleting a project removes a token set before any settings", () =>
    withSources((_fake, keychain) =>
      Effect.gen(function* () {
        const sources = yield* HoustonTaskSourceService;
        const store = yield* HoustonTaskSourceStore;
        const sql = yield* SqlClient.SqlClient;
        const entry = (projectId: string) =>
          `${store.tokenService(projectId, "notion")}\u0000integration-token`;
        const early = yield* createProject("token-only");
        const live = yield* createProject("token-live");
        for (const projectId of [early, live] as Array<ProjectId>) {
          yield* sources.setCredential({
            projectId,
            provider: "notion",
            token: Redacted.make(TOKEN),
          });
        }
        // The record of each entry set holds the project and provider, never the token.
        const records = yield* sql`
          SELECT * FROM houston_task_source_credentials ORDER BY project_id
        `;
        assert.deepEqual(records, [
          { project_id: live, provider: "notion" },
          { project_id: early, provider: "notion" },
        ]);
        assert.notInclude(JSON.stringify(records), TOKEN);
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM houston_task_source_settings`, [
          { n: 0 },
        ]);

        // Through the server: the deletion hook removes the entry and its record.
        yield* deleteProject(early);
        assert.isFalse(keychain.entries.has(entry(early)));
        assert.isTrue(keychain.entries.has(entry(live)));
        assert.deepEqual(yield* sql`SELECT project_id FROM houston_task_source_credentials`, [
          { project_id: live },
        ]);

        // Outside the server (`houston project` deletes without the hook): the startup sweep removes it.
        keychain.entries.set(entry(early), TOKEN);
        yield* sql`
          INSERT INTO houston_task_source_credentials (project_id, provider)
          VALUES (${early}, 'notion')
        `;
        yield* sweep;
        assert.isFalse(keychain.entries.has(entry(early)));
        assert.isTrue(keychain.entries.has(entry(live)));
        assert.deepEqual(yield* sql`SELECT project_id FROM houston_task_source_credentials`, [
          { project_id: live },
        ]);

        // Clearing a token drops its record too.
        yield* sources.clearCredential({ projectId: live, provider: "notion" });
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM houston_task_source_credentials`, [
          { n: 0 },
        ]);
      }),
    ),
  );
});
