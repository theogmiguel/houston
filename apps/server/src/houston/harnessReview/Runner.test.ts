// @effect-diagnostics nodeBuiltinImport:off - links are made with node:fs; Effect's has no junction type.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";

import {
  awaitReview,
  awaitRun,
  HoustonHarnessService,
  HoustonHarnessStore,
  createProject,
  type Kit,
  makeKit,
  model,
  reviewTask,
  runKit,
  seedPublished,
  settle,
} from "./harnessReview.testkit.ts";
import { reviewMessageId } from "./Runner.ts";

const service = HoustonHarnessService.HoustonHarnessService;
const store = HoustonHarnessStore.HoustonHarnessStore;

const kindOf = (error: unknown) => (error as { readonly kind?: string }).kind;
const messageOf = (error: unknown) => (error as { readonly message?: string }).message ?? "";

/** A directory link; a junction on Windows, which needs no privilege. */
const linkDirectory = (target: string, link: string) =>
  NodeFS.symlinkSync(target, link, "junction");

/** A file link; where Windows refuses file symlinks without developer mode, a junction stands in. */
const linkFile = (target: string, link: string) => {
  try {
    NodeFS.symlinkSync(target, link, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    NodeFS.symlinkSync(target, link, "junction");
  }
};

const readJson = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.map((text) => JSON.parse(text) as Record<string, any>),
  );

describe("one review at a time", () => {
  it.effect("one review runs per project at a time", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("busy");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const reviews = yield* store;
          const { projectId } = yield* createProject("busy");
          yield* seedPublished({ projectId, findings: [], endedAt: "2026-10-01T00:00:00.000Z" });
          yield* seedPublished({ projectId, findings: [], endedAt: "2026-10-10T00:00:00.000Z" });
          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "weekly",
          });
          kit.harness.script.hold.add(reviewMessageId(3));
          const running = yield* harness.runNow({ projectId });
          assert.equal(running.reviewId, 3);
          yield* settle;
          const third = (yield* reviews.getReview(3))!;
          assert.equal(third.status, "running");

          const busy = yield* Effect.flip(harness.runNow({ projectId }));
          assert.equal(kindOf(busy), "busy");
          assert.include(messageOf(busy), "review 3");
          assert.include(messageOf(busy), running.threadId);

          const task = (yield* reviewTask(projectId))!;
          yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
          yield* TestClock.adjust("6 seconds");
          yield* awaitRun(task);
          const fired = (yield* reviewTask(projectId))!;
          assert.equal(fired.lastRunStatus, "failed");
          assert.include(fired.lastRunError ?? "", "review 3");
          assert.lengthOf(yield* reviews.listReviews(projectId, 50), 3);

          const other = yield* createProject("busy-race");
          yield* harness.setup({
            projectId: other.projectId,
            modelSelection: model("codex"),
            schedule: "manual",
          });
          const results = yield* Effect.all(
            [
              Effect.result(harness.runNow({ projectId: other.projectId })),
              Effect.result(harness.runNow({ projectId: other.projectId })),
            ],
            { concurrency: 2 },
          );
          assert.equal(results.filter(Result.isSuccess).length, 1);
          yield* settle;
          const raced = yield* reviews.listReviews(other.projectId, 50);
          assert.lengthOf(raced, 1);
          const threads = new Set(
            kit.harness.log.started
              .map((turn) => turn.input.threadId)
              .filter((threadId) => threadId === raced[0]!.threadId),
          );
          assert.equal(threads.size, 1);
          const created = new Set(
            kit.harness.log.started.map((turn) => turn.input.threadId as string),
          );
          assert.isFalse(
            [...created].some(
              (threadId) => threadId !== raced[0]!.threadId && threadId.includes("busy-race"),
            ),
          );
        }),
      );
    }),
  );
});

describe("the run directory", () => {
  it.effect("the run directory holds the four inputs and the ignore file", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("run-directory");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const harness = yield* service;
          const reviews = yield* store;
          const { projectId, root } = yield* createProject("rundir");
          yield* fs.writeFileString(path.join(root, "CLAUDE.md"), "# Project\n");
          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          const first = yield* harness.runNow({ projectId });
          yield* settle;
          const runDir = (yield* reviews.getReview(first.reviewId))!.runDir;
          const dir = path.join(root, ...runDir.split("/"));
          for (const file of [
            "inventory.json",
            "digest.jsonl",
            "digest-meta.json",
            "decisions.json",
          ]) {
            assert.isTrue(yield* fs.exists(path.join(dir, file)), file);
          }
          assert.equal((yield* readJson(path.join(dir, "inventory.json"))).v, 1);
          assert.match(
            runDir,
            new RegExp(`^\\.houston/harness/review-${first.reviewId}-[0-9a-f]{8}$`),
          );
          const ignore = path.join(root, ".houston", "harness", ".gitignore");
          assert.equal(yield* fs.readFileString(ignore), "*\n");

          // Let the first review end, then edit the ignore file before the second.
          const answered = (yield* reviews.getReview(first.reviewId))!;
          if (answered.status === "running") {
            yield* reviews.fail(first.reviewId, {
              endedAt: "2026-10-30T09:05:00.000Z",
              error: "ended for the test",
            });
          }
          yield* fs.writeFileString(ignore, "*\n# kept by the user\n");
          const second = yield* harness.runNow({ projectId });
          yield* settle;
          assert.notEqual(second.reviewId, first.reviewId);
          assert.equal(yield* fs.readFileString(ignore), "*\n# kept by the user\n");

          // A project root that is a file.
          const fileRoot = path.join(yield* fs.makeTempDirectoryScoped(), "not-a-directory");
          yield* fs.writeFileString(fileRoot, "plain file");
          const asFile = yield* createProject("rundir-file", fileRoot);
          yield* harness.setup({
            projectId: asFile.projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          const startedBefore = kit.harness.log.started.length;
          yield* Effect.flip(harness.runNow({ projectId: asFile.projectId }));
          const [failedRoot] = yield* reviews.listReviews(asFile.projectId, 50);
          assert.equal(failedRoot!.status, "failed");
          assert.include(failedRoot!.error ?? "", fileRoot);
          assert.match(failedRoot!.error ?? "", /run directory|inventory/);
          assert.isNull(failedRoot!.threadId);

          // A run directory that cannot be created: `.houston/harness` is a file.
          const blocked = yield* createProject("rundir-blocked");
          yield* fs.makeDirectory(path.join(blocked.root, ".houston"), { recursive: true });
          yield* fs.writeFileString(path.join(blocked.root, ".houston", "harness"), "a file");
          yield* harness.setup({
            projectId: blocked.projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          yield* Effect.flip(harness.runNow({ projectId: blocked.projectId }));
          const [failedDir] = yield* reviews.listReviews(blocked.projectId, 50);
          assert.equal(failedDir!.status, "failed");
          assert.include(failedDir!.error ?? "", "run directory");
          assert.include(failedDir!.error ?? "", path.join(blocked.root, ".houston", "harness"));
          assert.isNull(failedDir!.threadId);
          assert.equal(kit.harness.log.started.length, startedBefore);
        }),
      );
    }),
  );

  it.effect("the run directory never follows a symlink", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("run-directory-links");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const harness = yield* service;
          const reviews = yield* store;

          // A repository that ships `.houston` or `.houston/harness` as a link to elsewhere.
          for (const level of [[".houston"], [".houston", "harness"]]) {
            const name = `links-${level.length}`;
            const project = yield* createProject(name);
            const outside = yield* fs.makeTempDirectoryScoped({ prefix: "harness-outside-" });
            const link = path.join(project.root, ...level);
            yield* fs.makeDirectory(path.dirname(link), { recursive: true });
            linkDirectory(outside, link);
            yield* harness.setup({
              projectId: project.projectId,
              modelSelection: model("claudeAgent"),
              schedule: "manual",
            });
            const startedBefore = kit.harness.log.started.length;
            const refused = yield* Effect.flip(harness.runNow({ projectId: project.projectId }));
            assert.include(messageOf(refused), `${link} is a symbolic link`, name);
            const [failed] = yield* reviews.listReviews(project.projectId, 50);
            assert.equal(failed!.status, "failed", name);
            assert.include(failed!.error ?? "", link, name);
            assert.isNull(failed!.threadId, name);
            assert.equal(kit.harness.log.started.length, startedBefore, name);
            assert.deepEqual(yield* fs.readDirectory(outside), [], name);
          }

          // A shipped `.gitignore` link, live or dangling, is left alone and never written through.
          const ignored = yield* createProject("links-ignore");
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "harness-outside-" });
          const harnessDir = path.join(ignored.root, ".houston", "harness");
          yield* fs.makeDirectory(harnessDir, { recursive: true });
          const target = path.join(outside, "tracked.txt");
          yield* fs.writeFileString(target, "tracked\n");
          linkFile(target, path.join(harnessDir, ".gitignore"));
          yield* harness.setup({
            projectId: ignored.projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          kit.harness.script.hold.add(reviewMessageId(3));
          const live = yield* harness.runNow({ projectId: ignored.projectId });
          yield* settle;
          assert.equal((yield* reviews.getReview(live.reviewId))!.status, "running");
          assert.deepEqual((yield* fs.readDirectory(outside)).toSorted(), ["tracked.txt"]);
          assert.equal(yield* fs.readFileString(target), "tracked\n");

          // The run directory replaced by a link before the answer: nothing is written through it.
          const runDir = path.join(
            ignored.root,
            ...(yield* reviews.getReview(live.reviewId))!.runDir.split("/"),
          );
          yield* fs.remove(runDir, { recursive: true });
          const swapped = yield* fs.makeTempDirectoryScoped({ prefix: "harness-outside-" });
          linkDirectory(swapped, runDir);
          kit.harness.script.replies.set(
            reviewMessageId(3),
            'Report\n\n```json\n{"schema":1,"findings":[]}\n```',
          );
          yield* kit.harness.release(reviewMessageId(3));
          yield* awaitReview(live.reviewId, (review) => review.status !== "running");
          const settled = (yield* reviews.getReview(live.reviewId))!;
          assert.equal(settled.status, "failed");
          assert.include(settled.error ?? "", `${runDir} is a symbolic link`);
          assert.deepEqual(yield* fs.readDirectory(swapped), []);

          // A dangling `.gitignore` link: its target is never created.
          const dangling = yield* createProject("links-dangling");
          const danglingDir = path.join(dangling.root, ".houston", "harness");
          yield* fs.makeDirectory(danglingDir, { recursive: true });
          const missing = path.join(outside, "missing", "ignore");
          linkFile(missing, path.join(danglingDir, ".gitignore"));
          yield* harness.setup({
            projectId: dangling.projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          yield* harness.runNow({ projectId: dangling.projectId });
          yield* settle;
          assert.isFalse(yield* fs.exists(missing));
        }),
      );
    }),
  );

  it.effect("run directories are unique per database and the newest ten are kept", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "harness-shared-" });
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "harness-databases-" });
      const databaseFile = path.join(base, "first.sqlite");

      // Two databases (a dev and a release channel, say) review the same folder as review 1.
      const reviewOne = (kit: Kit) =>
        runKit(
          kit,
          Effect.gen(function* () {
            const harness = yield* service;
            const reviews = yield* store;
            const project = yield* createProject("shared", root);
            yield* harness.setup({
              projectId: project.projectId,
              modelSelection: model("claudeAgent"),
              schedule: "manual",
            });
            kit.harness.script.hold.add(reviewMessageId(1));
            const started = yield* harness.runNow({ projectId: project.projectId });
            assert.equal(started.reviewId, 1);
            return (yield* reviews.getReview(1))!.runDir;
          }),
        );
      const firstDir = yield* reviewOne(yield* makeKit("unique-first", { databaseFile }));
      assert.match(firstDir, /^\.houston\/harness\/review-1-[0-9a-f]{8}$/);
      const firstReport = path.join(root, ...firstDir.split("/"), "report.md");
      yield* fs.writeFileString(firstReport, "# From the first database\n");
      const firstDigest = yield* fs.readFileString(
        path.join(root, ...firstDir.split("/"), "digest.jsonl"),
      );
      const secondDir = yield* reviewOne(yield* makeKit("unique-second"));
      assert.notEqual(secondDir, firstDir);
      assert.isTrue(yield* fs.exists(path.join(root, ...secondDir.split("/"), "digest.jsonl")));
      assert.equal(
        yield* fs.readFileString(path.join(root, ...firstDir.split("/"), "digest.jsonl")),
        firstDigest,
      );
      const reopened = yield* makeKit("unique-reopened", { databaseFile, reactor: false });
      const report = yield* runKit(
        reopened,
        Effect.flatMap(service, (harness) => harness.report({ reviewId: 1 })),
      );
      assert.equal(report.markdown, "# From the first database\n");

      // Retention: a new review keeps the run directories of this database's newest ten reviews.
      const kit = yield* makeKit("retention");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const reviews = yield* store;
          const project = yield* createProject("retention");
          const dirOf = (runDir: string) => path.join(project.root, ...runDir.split("/"));
          const seeded: Array<string> = [];
          for (let index = 0; index < 11; index += 1) {
            const id = yield* seedPublished({
              projectId: project.projectId,
              findings: [],
              endedAt: `2026-10-${String(10 + index)}T00:00:00.000Z`,
            });
            const runDir = (yield* reviews.getReview(id))!.runDir;
            yield* fs.makeDirectory(dirOf(runDir), { recursive: true });
            yield* fs.writeFileString(path.join(dirOf(runDir), "report.md"), `review ${id}\n`);
            seeded.push(runDir);
          }
          // The oldest is a link: removing it must not reach what it points at.
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "harness-outside-" });
          yield* fs.writeFileString(path.join(outside, "keep.txt"), "keep\n");
          yield* fs.remove(dirOf(seeded[0]!), { recursive: true });
          linkDirectory(outside, dirOf(seeded[0]!));
          // A v1 run directory and one this database never wrote are not its to remove.
          const v1Dir = path.join(project.root, ".houston", "harness", "r3");
          const foreign = path.join(project.root, ".houston", "harness", "review-1-0badc0de");
          for (const dir of [v1Dir, foreign]) yield* fs.makeDirectory(dir, { recursive: true });

          yield* harness.setup({
            projectId: project.projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          kit.harness.script.hold.add(reviewMessageId(12));
          const started = yield* harness.runNow({ projectId: project.projectId });
          assert.equal(started.reviewId, 12);
          assert.isFalse(yield* fs.exists(dirOf(seeded[1]!)), "the second oldest is removed");
          assert.equal(yield* fs.readFileString(path.join(outside, "keep.txt")), "keep\n");
          for (const runDir of seeded.slice(2)) {
            assert.isTrue(yield* fs.exists(dirOf(runDir)), runDir);
          }
          const newest = (yield* reviews.getReview(12))!.runDir;
          assert.isTrue(yield* fs.exists(path.join(dirOf(newest), "digest.jsonl")));
          assert.isTrue(yield* fs.exists(v1Dir));
          assert.isTrue(yield* fs.exists(foreign));
          const gone = yield* Effect.flip(harness.report({ reviewId: 2 }));
          assert.equal(kindOf(gone), "not_found");
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("digest content reaches only the run directory the review's provider reads", () => {
    const logs: Array<string> = [];
    const logger = Logger.make((options) => {
      logs.push(`${String(options.message)} ${Cause.pretty(options.cause)}`);
    });
    return Effect.gen(function* () {
      const kit = yield* makeKit("data-flow");
      const MARKER = "MARKER-digest-7f3a";
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const harness = yield* service;
          const { projectId, root } = yield* createProject("data-flow");
          const workThread = ThreadId.make("thread:data-flow:work");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create:data-flow"),
            threadId: workThread,
            projectId,
            title: "Work",
            modelSelection: model("codex"),
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: root,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("send:data-flow"),
            threadId: workThread,
            messageId: MessageId.make("message:data-flow"),
            text: `Please fix ${MARKER}`,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* settle;
          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          kit.harness.script.hold.add(reviewMessageId(1));
          const started = yield* harness.runNow({ projectId });
          yield* settle;

          const runDir = (yield* (yield* store).getReview(started.reviewId))!.runDir;
          const dir = path.join(root, ...runDir.split("/"));
          assert.include(yield* fs.readFileString(path.join(dir, "digest.jsonl")), MARKER);
          assert.isTrue(dir.startsWith(root), "the run directory is inside the review's cwd");
          // The prompt names the files; the provider reads them in its read-only run.
          const reviewTurns = kit.harness.log.started.filter(
            (turn) => turn.input.threadId === started.threadId,
          );
          assert.isAbove(reviewTurns.length, 0);
          for (const turn of kit.harness.log.started) {
            if (turn.input.threadId === workThread) continue;
            assert.notInclude(turn.input.message.text, MARKER, turn.input.threadId);
          }
          assert.deepEqual(
            new Set(
              kit.harness.log.started
                .filter((turn) => turn.input.threadId !== workThread)
                .map((turn) => turn.input.threadId),
            ),
            new Set([started.threadId]),
          );
          assert.notInclude(JSON.stringify(yield* harness.get({ projectId })), MARKER);
          assert.notInclude(JSON.stringify(yield* harness.overview({})), MARKER);
          assert.lengthOf(kit.launches, 0);
        }),
      );
      assert.notInclude(logs.join("\n"), MARKER);
    }).pipe(Effect.provide(Logger.layer([logger])));
  });

  it.effect("decisions json lists each finding with its decision and linked tasks", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("decisions-json");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const harness = yield* service;
          const p = yield* createProject("decisions-p");
          const q = yield* createProject("decisions-q");
          yield* seedPublished({
            projectId: p.projectId,
            findings: [
              { key: "denied-push", title: "Denied git push" },
              { key: "slow-tests", title: "Slow tests" },
            ],
            endedAt: "2026-10-20T00:00:00.000Z",
          });
          yield* seedPublished({
            projectId: q.projectId,
            findings: [{ key: "q-only", title: "Only in Q" }],
            endedAt: "2026-10-20T00:00:00.000Z",
          });
          yield* harness.decide({ projectId: p.projectId, key: "denied-push", state: "dismissed" });
          yield* harness.setup({
            projectId: p.projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          const started = yield* harness.runNow({ projectId: p.projectId });
          const runDir = (yield* (yield* store).getReview(started.reviewId))!.runDir;
          const decisions = yield* readJson(
            path.join(p.root, ...runDir.split("/"), "decisions.json"),
          );
          assert.equal(decisions.schema, 2);
          assert.equal(decisions.minimum_sessions_after_landing, 3);
          const byKey = new Map(
            (decisions.findings as Array<Record<string, any>>).map((finding) => [
              finding.key,
              finding,
            ]),
          );
          assert.deepEqual([...byKey.keys()].toSorted(), ["denied-push", "slow-tests"]);
          assert.equal(byKey.get("denied-push")!.title, "Denied git push");
          assert.equal(byKey.get("denied-push")!.state, "dismissed");
          assert.equal(byKey.get("denied-push")!.decided_at, "2026-10-30T09:00:00.000Z");
          assert.equal(byKey.get("slow-tests")!.state, "open");
          assert.isNull(byKey.get("slow-tests")!.decided_at);
          for (const finding of byKey.values()) assert.deepEqual(finding.tasks, []);
        }),
      );
    }),
  );
});
