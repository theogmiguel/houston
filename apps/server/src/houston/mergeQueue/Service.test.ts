// @effect-diagnostics nodeBuiltinImport:off - writes a v1 database file and the GitLab fixture.
// houston.mergeQueue.* writes over the real project service, Tasks tables, git and the GitHub fake.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import type { HoustonMergeQueueError } from "@t3tools/contracts/houston/mergeQueue";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  createProject,
  deleteProject,
  git,
  layerMergeQueueTest,
  makeGitHub,
  makeRepos,
  openPull,
  pullUrl,
  pushBranch,
  type FakeGitHub,
  type MergeQueueTestOptions,
} from "./mergeQueue.testkit.ts";
import { HoustonMergeQueueService } from "./Service.ts";
import { HoustonMergeQueueStore } from "./Store.ts";

const withQueue = <A, E>(
  body: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerMergeQueueTest>>>,
  options: MergeQueueTestOptions = {},
) => body.pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ loops: false, ...options }))));

const failure = <A, R>(effect: Effect.Effect<A, HoustonMergeQueueError, R>) => Effect.flip(effect);

/** A project whose checkout has a GitHub origin and open pull requests on pushed branches. */
const githubProject = (name: string, github: FakeGitHub, numbers: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    for (const number of numbers) {
      pushBranch(github.repos!, `houston/${number}`, { [`f${number}.txt`]: `${number}\n` });
      openPull(github, number);
    }
    return yield* createProject(name, github.repos!.checkout);
  });

const numbersOf = (entries: ReadonlyArray<{ readonly number: number }>) =>
  entries.map((entry) => entry.number);

describe("enqueue reads fresh and appends at the tail", () => {
  it.live("enqueue reads fresh and appends at the tail", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* githubProject("enqueue", github, [11, 12, 14]);
        yield* queue.enqueue({ projectId, pullRequest: 11 });
        yield* queue.enqueue({ projectId, pullRequest: 14 });
        github.requests.length = 0;

        const entry = yield* queue.enqueue({ projectId, pullRequest: pullUrl(12), dependsOn: 14 });
        // One fresh read: detail, activity and checks through PullRequestService, and one facts query.
        assert.deepEqual(
          github.requests
            .map((request) => `${request.via} ${request.method} ${request.path}`)
            .sort(),
          [
            "pullRequestService GET activity/12",
            "pullRequestService GET checks/12",
            "pullRequestService GET detail/12",
            "rest POST /graphql",
          ],
        );
        assert.strictEqual(entry.number, 12);
        assert.strictEqual(entry.headRef, "houston/12");
        assert.strictEqual(entry.headSha, git(github.repos!.bare, ["rev-parse", "houston/12"]));
        assert.strictEqual(entry.baseRef, "main");
        assert.strictEqual(entry.title, "PR 12");
        assert.strictEqual(entry.dependsOn, 14);
        assert.strictEqual(entry.position, 3);
        assert.strictEqual(entry.status, "ready");
        assert.isNull(entry.reason);
        assert.deepEqual(
          entry.gates.map((gate) => gate.kind),
          ["mergeable", "reviewThreads", "reviewer", "verification"],
        );
        const first = yield* queue.get({ projectId });
        assert.deepEqual(numbersOf(first.entries), [11, 14, 12]);

        // Re-enqueueing keeps the place and replaces the dependency.
        yield* queue.enqueue({ projectId, pullRequest: 12, dependsOn: null });
        yield* queue.enqueue({ projectId, pullRequest: 11, dependsOn: 12 });
        const second = yield* queue.get({ projectId });
        assert.deepEqual(numbersOf(second.entries), [14, 12, 11]);
        assert.strictEqual(second.entries.find((value) => value.number === 12)?.dependsOn, null);
        assert.strictEqual(second.entries.find((value) => value.number === 11)?.dependsOn, 12);
        const store = yield* HoustonMergeQueueStore;
        const rows = yield* store.rows(projectId);
        assert.deepEqual(
          rows.map((row) => [row.number, row.position]),
          [
            [11, 1],
            [14, 2],
            [12, 3],
          ],
        );
      }),
      { github },
    );
  });
});

describe("enqueue refuses what cannot join, by name", () => {
  it.live("enqueue refuses what cannot join, by name", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* githubProject("refuse", github, [3, 4, 5, 6, 9]);
        github.pulls.get(9)!.state = "closed";
        github.pulls.get(4)!.repository = "other/repo";
        github.pulls.get(5)!.headRepository = "someone/r";
        github.pulls.get(6)!.headRef = "";

        const gitlab = makeRepos("houston-mq-gitlab-");
        git(gitlab.checkout, ["remote", "set-url", "origin", "https://gitlab.com/o/r.git"]);
        const gitlabProject = yield* createProject("gitlab", gitlab.checkout);

        const CASES: ReadonlyArray<
          readonly [string, ProjectId, number | string, string, ReadonlyArray<string>]
        > = [
          [
            "closed",
            projectId,
            9,
            "invalid",
            ["PR #9 is closed; only an open pull request joins the merge queue"],
          ],
          [
            "a URL in another repository",
            projectId,
            pullUrl(3, "other/repo"),
            "invalid",
            ["other/repo", "o/r"],
          ],
          [
            "GitHub answers from another repository",
            projectId,
            4,
            "invalid",
            ["other/repo", "o/r"],
          ],
          ["a fork's branch", projectId, 5, "invalid", ["someone/r"]],
          ["no head branch", projectId, 6, "invalid", ["PR #6 has no head branch"]],
          [
            "a GitLab remote",
            gitlabProject,
            3,
            "unsupported",
            ["the merge queue needs a GitHub remote"],
          ],
        ];
        for (const [name, project, pullRequest, kind, named] of CASES) {
          const refused = yield* failure(queue.enqueue({ projectId: project, pullRequest }));
          assert.strictEqual(refused.kind, kind, name);
          for (const text of named) assert.include(refused.message, text, name);
        }
        assert.deepEqual((yield* queue.get({ projectId })).entries, []);
        const store = yield* HoustonMergeQueueStore;
        assert.deepEqual(yield* store.rows(gitlabProject), []);
      }),
      { github },
    );
  });
});

describe("entry refusals send no GitHub request", () => {
  it.live("entry refusals send no GitHub request", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const numbers = Array.from({ length: 32 }, (_, index) => index + 1);
        // Heads GitHub reports without branches on the remote: nothing here pushes or verifies.
        for (const number of [...numbers, 33]) {
          openPull(github, number, { headSha: number.toString(16).padStart(40, "0") });
        }
        const projectId = yield* createProject("full", github.repos!.checkout);
        for (const number of numbers) yield* queue.enqueue({ projectId, pullRequest: number });
        yield* queue.enqueue({ projectId, pullRequest: 12, dependsOn: 14 });
        github.requests.length = 0;
        const limit = yield* failure(queue.enqueue({ projectId, pullRequest: 33 }));
        assert.strictEqual(limit.kind, "limit");
        assert.include(
          limit.message,
          "holds 32 entries and its limit is 32; refusing to enqueue PR #33",
        );
        const self = yield* failure(queue.enqueue({ projectId, pullRequest: 7, dependsOn: 7 }));
        assert.strictEqual(self.kind, "invalid");
        const unknown = yield* failure(queue.enqueue({ projectId, pullRequest: 7, dependsOn: 99 }));
        assert.include(unknown.message, "enqueue #99 first");
        const cycle = yield* failure(queue.enqueue({ projectId, pullRequest: 14, dependsOn: 12 }));
        assert.include(cycle.message, "#14 → #12 → #14");
        assert.deepEqual(github.requests, []);
        assert.strictEqual((yield* queue.get({ projectId })).entries.length, 32);
      }),
      { github },
    );
  });
});

describe("dequeue and project deletion remove the queue rows", () => {
  it.live("dequeue and project deletion remove the queue rows", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const store = yield* HoustonMergeQueueStore;
        const sql = yield* SqlClient.SqlClient;
        const projectId = yield* githubProject("gone", github, [1, 2]);
        const other = makeGitHub(makeRepos("houston-mq-other-"));
        const keptId = yield* createProject("kept", other.repos!.checkout);
        yield* queue.enqueue({ projectId, pullRequest: 1 });
        yield* queue.enqueue({ projectId, pullRequest: 2 });
        yield* queue.setSettings({
          projectId,
          mergeWhenVerified: false,
          verificationCommand: "pnpm test",
          timeLimitMinutes: 30,
        });
        for (const id of [projectId, keptId]) {
          yield* store.appendLog(id, {
            kind: "merge",
            number: 1,
            repository: "o/r",
            url: pullUrl(1),
            title: "PR 1",
            refName: "main",
            oldSha: null,
            newSha: null,
            headSha: null,
            forkSha: null,
            method: "squash",
            detail: null,
            unattended: false,
          });
        }
        yield* sql`
          INSERT INTO houston_merge_queue_settings (project_id, verification_command)
          VALUES (${keptId}, 'make check')
        `;
        yield* sql`
          INSERT INTO houston_merge_queue_entries (
            project_id, number, repository, url, head_ref, head_sha, position, enqueued_at
          ) VALUES (${keptId}, 5, 'o/r', ${pullUrl(5)}, 'houston/5', ${"5".repeat(40)}, 1, 'now')
        `;

        yield* queue.dequeue({ projectId, number: 1 });
        assert.deepEqual(numbersOf((yield* queue.get({ projectId })).entries), [2]);
        const again = yield* failure(queue.dequeue({ projectId, number: 1 }));
        assert.strictEqual(again.kind, "not_found");
        assert.include(again.message, "#1");

        yield* deleteProject(projectId);
        const count = (table: string, id: string) =>
          sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM ${sql(table)} WHERE project_id = ${id}
          `.pipe(Effect.map((rows) => rows[0]!.n));
        for (const table of [
          "houston_merge_queue_entries",
          "houston_merge_queue_settings",
          "houston_merge_queue_log",
        ]) {
          assert.strictEqual(yield* count(table, projectId), 0, table);
          assert.strictEqual(yield* count(table, keptId), 1, table);
        }
      }),
      { github },
    );
  });
});

describe("the reviewer gate reads the slice's newest review run", () => {
  it.live("the reviewer gate reads the slice's newest review run", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const sql = yield* SqlClient.SqlClient;
        const projectId = yield* githubProject("reviewer", github, [1, 2, 3]);
        const task = (number: number, kind: "slice" | "delivery") =>
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO houston_tasks (number, project_id, title, status, created_by, created_at, updated_at)
              VALUES (${number}, ${projectId}, ${`Task ${number}`}, 'in_review', 'user', 'now', 'now')
            `;
            const id = (yield* sql<{ readonly id: number }>`
              SELECT id FROM houston_tasks WHERE number = ${number}
            `)[0]!.id;
            yield* sql`INSERT INTO houston_task_domain (task_id, kind) VALUES (${id}, ${kind})`;
            return id;
          });
        const run = (
          taskId: number,
          attempt: number,
          kind: "implementation" | "review",
          state: string,
          patch: { readonly branch?: string; readonly prUrl?: string } = {},
        ) => sql`
          INSERT INTO houston_task_runs (
            task_id, attempt, kind, state, provider, branch, initial_revision, started_at, pr_url
          ) VALUES (
            ${taskId}, ${attempt}, ${kind}, ${state}, 'codex', ${patch.branch ?? null}, 1,
            ${`2026-10-30T0${attempt}:00:00.000Z`}, ${patch.prUrl ?? null}
          )
        `;
        // HOU-4 matches #1 by branch; its newest review run passed after an older one did not.
        const four = yield* task(4, "slice");
        yield* run(four, 1, "implementation", "handed_back", { branch: "houston/1" });
        yield* run(four, 2, "review", "needs_review");
        yield* run(four, 3, "review", "handed_back");
        // HOU-5 matches #2 only by its pull request URL; its review is still running.
        const five = yield* task(5, "slice");
        yield* run(five, 1, "implementation", "handed_back", { prUrl: pullUrl(2) });
        yield* run(five, 2, "review", "running");
        // HOU-6 is a delivery task on #3's branch: the gate does not apply.
        const six = yield* task(6, "delivery");
        yield* run(six, 1, "implementation", "handed_back", { branch: "houston/3" });

        for (const number of [1, 2, 3]) yield* queue.enqueue({ projectId, pullRequest: number });
        const gate = (number: number) =>
          queue
            .get({ projectId })
            .pipe(
              Effect.map((snapshot) =>
                snapshot.entries
                  .find((entry) => entry.number === number)!
                  .gates.find((value) => value.kind === "reviewer")!,
              ),
            );
        assert.strictEqual((yield* gate(1)).state, "passed");
        const running = yield* gate(2);
        assert.strictEqual(running.state, "failed");
        assert.include(running.reason, "HOU-5");
        assert.include(running.reason, "still running");
        assert.strictEqual((yield* gate(3)).state, "notApplicable");

        // A newer review run decides: HOU-4's newest is now not a pass.
        yield* run(four, 4, "review", "needs_review");
        const failed = yield* gate(1);
        assert.strictEqual(failed.state, "failed");
        assert.include(failed.reason, "HOU-4");
        assert.include(failed.reason, "is not pass");
      }),
      { github },
    );
  });
});

describe("a changed command discards the verifications it passed", () => {
  it.live("a changed command discards the verifications it passed", () => {
    const github = makeGitHub(makeRepos());
    return withQueue(
      Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const store = yield* HoustonMergeQueueStore;
        const projectId = yield* githubProject("command", github, [1, 2]);
        const settings = {
          projectId,
          mergeWhenVerified: false,
          verificationCommand: "  pnpm test  ",
          timeLimitMinutes: 30,
        };
        const stored = yield* queue.setSettings(settings);
        assert.strictEqual(stored.verificationCommand, "pnpm test");
        assert.strictEqual(stored.revision, 1);
        for (const number of [1, 2]) {
          const entry = yield* queue.enqueue({ projectId, pullRequest: number });
          yield* store.setVerification(projectId, number, {
            baseRef: "main",
            baseSha: "a".repeat(40),
            headSha: entry.headSha,
            verifiedSha: "b".repeat(40),
            at: "2026-10-30T10:00:00.000Z",
          });
        }
        const verified = (yield* queue.get({ projectId })).entries.map(
          (entry) => entry.verification,
        );
        assert.isTrue(verified.every((value) => value !== null));

        // The same command with another time limit keeps them.
        yield* queue.setSettings({ ...settings, timeLimitMinutes: 45, expectedRevision: 1 });
        assert.isTrue(
          (yield* queue.get({ projectId })).entries.every((entry) => entry.verification !== null),
        );
        const stale = yield* failure(
          queue.setSettings({ ...settings, verificationCommand: "make", expectedRevision: 1 }),
        );
        assert.strictEqual(stale.kind, "conflict");

        yield* queue.setSettings({
          ...settings,
          verificationCommand: "pnpm check",
          expectedRevision: 2,
        });
        const after = yield* queue.get({ projectId });
        assert.deepEqual(
          after.entries.map((entry) => entry.verification),
          [null, null],
        );
        assert.strictEqual(after.settings.revision, 3);
        assert.strictEqual(after.settings.verificationCommand, "pnpm check");
      }),
      { github },
    );
  });
});

describe("v1 queue state is not read", () => {
  it.live("v1 queue state is not read", () => {
    const baseDir = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "houston-mq-v1-")),
    );
    const v1 = NodePath.join(baseDir, "houston.db");
    const github = makeGitHub(makeRepos());
    const digest = () =>
      [v1, `${v1}-wal`, `${v1}-shm`].map((file) =>
        NodeFS.existsSync(file)
          ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex")
          : "absent",
      );
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          CREATE TABLE merge_queue_entries (workspace TEXT, number INTEGER, head_sha TEXT, position INTEGER)
        `;
        yield* sql`
          INSERT INTO merge_queue_entries VALUES (${github.repos!.checkout}, 7, ${"7".repeat(40)}, 1)
        `;
        yield* sql`
          CREATE TABLE merge_queue_settings (workspace TEXT, verification_command TEXT, merge_when_verified INTEGER)
        `;
        yield* sql`INSERT INTO merge_queue_settings VALUES (${github.repos!.checkout}, 'make test', 1)`;
      }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: v1 }))), Effect.scoped);
      const before = digest();
      yield* withQueue(
        Effect.gen(function* () {
          const queue = yield* HoustonMergeQueueService;
          const projectId = yield* createProject("v1", github.repos!.checkout);
          const snapshot = yield* queue.get({ projectId });
          assert.deepEqual(snapshot.entries, []);
          assert.deepEqual(snapshot.log, []);
          assert.deepEqual(snapshot.settings, {
            projectId,
            mergeWhenVerified: false,
            verificationCommand: "",
            timeLimitMinutes: 30,
            paused: false,
            revision: 0,
          });
        }),
        { github, baseDir },
      );
      assert.deepEqual(digest(), before);
    });
  });
});
