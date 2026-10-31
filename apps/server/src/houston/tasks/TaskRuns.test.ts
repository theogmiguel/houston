// @effect-diagnostics nodeBuiltinImport:off - inspects a real temporary git repository.
// Task runs as threads: Start, run state, handback, stop, resume, retry, merged pull requests,
// planning and review, over the real orchestrator and launcher (taskRuns.testkit.ts).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  HoustonTaskError,
  type HoustonTask,
  type HoustonTaskDetail,
  type HoustonTaskRun,
} from "@t3tools/contracts/houston/tasks";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { briefMessageId } from "./TaskRuns.ts";
import {
  ANTIGRAVITY,
  CLAUDE,
  CODEX,
  commitLines,
  git,
  makeRunsHarness,
  runWith,
  selection,
  threadOf,
  withThreadsOnly,
  type RunsContext,
} from "./taskRuns.testkit.ts";

const TIMEOUT = 120_000;

const READ_ONLY = {
  interactionMode: "default",
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
} as const;

const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => {
      assert.instanceOf(error, HoustonTaskError);
      return error as unknown as HoustonTaskError;
    }),
  );

const detailOf = (context: RunsContext, task: Pick<HoustonTask, "key">) =>
  context.tasks.get({ id: task.key });

const newestRun = (detail: HoustonTaskDetail, kind: HoustonTaskRun["kind"] = "implementation") => {
  const run = detail.runs.find((candidate) => candidate.kind === kind);
  assert.isDefined(run, `no ${kind} run`);
  return run as HoustonTaskRun;
};

const projectionOf = (context: RunsContext, threadId: ThreadId) =>
  context.orchestrator.getThreadProjection(threadId);

const threadIds = (context: RunsContext) =>
  context.orchestrator
    .getShellSnapshot()
    .pipe(Effect.map((snapshot) => snapshot.threads.map((thread) => thread.id)));

const userMessages = (projection: OrchestrationV2ThreadProjection) =>
  projection.messages.filter((message) => message.role === "user").map((message) => message.text);

const worktreeList = (repo: string) =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));

/** Starts `task` and waits until its run has a thread and a worktree. */
const startAndPrepare = (
  context: RunsContext,
  task: HoustonTask,
  input: { readonly hold?: boolean } = {},
) =>
  Effect.gen(function* () {
    const started = yield* context.runs.start({ id: task.key });
    if (input.hold === true)
      context.harness.doubles.script.hold.add(briefMessageId(started.run.id));
    yield* context.until(
      "the run's worktree",
      detailOf(context, task).pipe(Effect.map((detail) => newestRun(detail).worktreePath !== null)),
    );
    return newestRun(yield* detailOf(context, task));
  });

const waitForRunState = (
  context: RunsContext,
  task: HoustonTask,
  state: HoustonTaskRun["state"],
  kind: HoustonTaskRun["kind"] = "implementation",
) =>
  context.until(
    `${task.key} ${kind} run ${state}`,
    detailOf(context, task).pipe(
      Effect.map((detail) => detail.runs.find((run) => run.kind === kind)?.state === state),
    ),
  );

const historyActions = (detail: HoustonTaskDetail) => detail.history.map((entry) => entry.action);

const linkPullRequest = (context: RunsContext, threadId: ThreadId, number: number) =>
  context.orchestrator.dispatch({
    type: "thread.pull-request.link",
    commandId: CommandId.make(`link:${threadId}:${number}`),
    threadId,
    host: "github.com",
    repository: "houston/tasks",
    number,
    url: `https://github.com/houston/tasks/pull/${number}`,
    source: "manual",
  });

let syncs = 0;
const syncPullRequest = (
  context: RunsContext,
  threadId: ThreadId,
  number: number,
  state: "open" | "closed" | "merged",
) =>
  context.orchestrator.dispatch({
    type: "thread.pull-request-link.sync",
    commandId: CommandId.make(`sync:${threadId}:${(syncs += 1)}`),
    threadId,
    host: "github.com",
    repository: "houston/tasks",
    number,
    snapshot: {
      state,
      title: "Task",
      headBranch: "houston/task",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-10-30T00:00:00.000Z",
    },
    stack: null,
  });

/** Reports `headSha` pushed to the linked pull request, as the watch reactor does: the watch is
 * started first, and each sync names the watch it updates. */
const pushHead = (
  context: RunsContext,
  threadId: ThreadId,
  number: number,
  headSha: string,
  wakes = 0,
) =>
  Effect.gen(function* () {
    yield* context.orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch-start:${threadId}:${(syncs += 1)}`),
      threadId,
      host: "github.com",
      repository: "houston/tasks",
      number,
      watching: true,
    });
    const projection = yield* projectionOf(context, threadId);
    const watch = projection.thread.pullRequests?.find((link) => link.number === number)?.watch;
    assert.isDefined(watch, `pull request ${number} is watched`);
    const startedAt = watch?.startedAt ?? "";
    yield* context.orchestrator.dispatch({
      type: "thread.pull-request-watch.sync",
      commandId: CommandId.make(`watch:${threadId}:${(syncs += 1)}`),
      threadId,
      host: "github.com",
      repository: "houston/tasks",
      number,
      startedAt,
      watch: {
        startedAt,
        headSha,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: startedAt,
        remarkIds: [],
        conflicting: false,
        wakes,
      },
    });
  });

const runCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM houston_task_runs`;
  return row?.n ?? 0;
});

describe("start launches a worktree thread with the brief", () => {
  it.effect(
    "one thread on houston/task/hou-<n>-<slug>, attempt 1 recorded, the brief sent first",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("start");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const task = yield* context.readyTask("Fix the Login, page!", {
              description: "The button does nothing.",
            });
            const before = yield* threadIds(context);
            const started = yield* context.runs.start({ id: task.key });
            assert.isUndefined(started.brief);
            const run = yield* startAndPrepareExisting(context, task);
            const after = yield* threadIds(context);
            assert.strictEqual(after.length, before.length + 1);
            assert.strictEqual(run.id, started.run.id);
            assert.strictEqual(run.attempt, 1);
            assert.strictEqual(run.kind, "implementation");
            const branch = `houston/task/hou-${task.number}-fix-the-login-page`;
            assert.strictEqual(run.branch, branch);
            assert.isNotNull(run.runId);
            assert.strictEqual(run.baseCommit, git(harness.repo, "rev-parse", "main"));
            const threadId = yield* threadOf(run);
            const projection = yield* projectionOf(context, threadId);
            assert.strictEqual(projection.thread.title, `${task.key} Fix the Login, page!`);
            assert.strictEqual(projection.thread.branch, branch);
            assert.strictEqual(projection.thread.worktreePath, run.worktreePath);
            assert.strictEqual(
              git(run.worktreePath ?? "", "rev-parse", "--abbrev-ref", "HEAD"),
              branch,
            );
            const [first] = userMessages(projection);
            assert.include(first ?? "", "<<<HOUSTON-TASK-DATA");
            assert.include(first ?? "", "The button does nothing.");
            const detail = yield* detailOf(context, task);
            assert.strictEqual(detail.task.status, "in_progress");
            assert.include(historyActions(detail), "houston:start");
            assert.strictEqual(run.initialRevision, detail.task.revision);
          }),
        );
      }),
    TIMEOUT,
  );
});

/** The run of a start already sent, once its worktree exists. */
const startAndPrepareExisting = (context: RunsContext, task: HoustonTask) =>
  Effect.gen(function* () {
    yield* context.until(
      "the run's worktree",
      detailOf(context, task).pipe(Effect.map((detail) => newestRun(detail).worktreePath !== null)),
    );
    return newestRun(yield* detailOf(context, task));
  });

describe("prefill leaves the thread idle and returns the brief", () => {
  it.effect(
    "no message, no thread run, and the brief in the result",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("prefill");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({ delivery: "prefill" });
            const task = yield* context.readyTask("Prefilled task");
            const started = yield* context.runs.start({ id: task.key });
            assert.include(started.brief ?? "", "<<<HOUSTON-TASK-DATA");
            assert.include(started.brief ?? "", "Prefilled task");
            const run = yield* startAndPrepareExisting(context, task);
            const projection = yield* projectionOf(context, yield* threadOf(run));
            assert.deepEqual(userMessages(projection), []);
            assert.deepEqual(projection.runs, []);
            assert.strictEqual(run.state, "waiting_for_input");
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("start requires a project and can assign one", () => {
  it.effect(
    "an unassigned task is refused without a project and assigned with one",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("project");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const task = yield* context.readyTask("Unassigned", { projectId: null });
            const before = yield* threadIds(context);
            const refused = yield* refusal(context.runs.start({ id: task.key }));
            assert.strictEqual(refused.kind, "invalid");
            assert.include(refused.message, "a project is required");
            assert.deepEqual(yield* threadIds(context), before);
            assert.strictEqual(yield* runCount, 0);
            yield* context.runs.start({
              id: task.key,
              projectId: context.projectId,
              overrideReadiness: true,
            });
            const detail = yield* detailOf(context, task);
            assert.strictEqual(detail.task.projectId, context.projectId);
            assert.strictEqual(detail.runs.length, 1);
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("start requires readiness unless overridden", () => {
  it.effect(
    "unready lists the reasons; the override starts",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("ready");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const task = yield* context.readyTask("No acceptance", { acceptance: [] });
            const refused = yield* refusal(context.runs.start({ id: task.key }));
            assert.strictEqual(refused.kind, "unready");
            assert.include(refused.message, "acceptance item");
            assert.strictEqual(yield* runCount, 0);
            const started = yield* context.runs.start({ id: task.key, overrideReadiness: true });
            assert.strictEqual(started.run.attempt, 1);
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a second live run is refused naming the holder", () => {
  it.effect(
    "busy names the holder thread, limit 1 and live count 1",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("busy");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const task = yield* context.readyTask("Busy");
            const first = yield* context.runs.start({ id: task.key });
            const refused = yield* refusal(context.runs.start({ id: task.key }));
            assert.strictEqual(refused.kind, "busy");
            assert.strictEqual(refused.limit, 1);
            assert.strictEqual(refused.actual, 1);
            assert.include(refused.message, first.run.threadId ?? "missing thread");
            assert.strictEqual(yield* runCount, 1);
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a brief over the cap is refused before anything is created", () => {
  it.effect(
    "limit at 16,385 bytes with worktrees, threads and runs unchanged",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("brief-cap");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const task = yield* context.readyTask("Long", { description: "x".repeat(17_000) });
            const worktrees = worktreeList(harness.repo);
            const threads = yield* threadIds(context);
            const refused = yield* refusal(context.runs.start({ id: task.key }));
            assert.strictEqual(refused.kind, "limit");
            assert.strictEqual(refused.limit, 16_384);
            assert.isAbove(refused.actual ?? 0, 16_384);
            yield* context.settle;
            assert.deepEqual(worktreeList(harness.repo), worktrees);
            assert.deepEqual(yield* threadIds(context), threads);
            assert.strictEqual(yield* runCount, 0);
            assert.strictEqual((yield* detailOf(context, task)).task.status, "todo");
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a working run moves its task to in progress unless the user did", () => {
  it.effect(
    "a prefilled run that starts running moves todo to in_progress",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("working");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({ delivery: "prefill" });
            const task = yield* context.readyTask("Working");
            yield* context.runs.start({ id: task.key });
            const run = yield* startAndPrepareExisting(context, task);
            assert.strictEqual((yield* detailOf(context, task)).task.status, "todo");
            const threadId = yield* threadOf(run);
            harness.doubles.script.hold.add("working-1");
            yield* context.send(threadId, "working-1", "go");
            yield* waitForRunState(context, task, "running");
            assert.strictEqual((yield* detailOf(context, task)).task.status, "in_progress");
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "a status the user set after the run started stays",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("user-status");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({ delivery: "prefill" });
            const task = yield* context.readyTask("User status");
            yield* context.runs.start({ id: task.key });
            const run = yield* startAndPrepareExisting(context, task);
            const current = (yield* detailOf(context, task)).task;
            yield* context.tasks.save({
              id: task.key,
              expectedRevision: current.revision,
              patch: { status: "backlog" },
            });
            harness.doubles.script.hold.add("user-status-1");
            yield* context.send(yield* threadOf(run), "user-status-1", "go");
            yield* waitForRunState(context, task, "running");
            assert.strictEqual((yield* detailOf(context, task)).task.status, "backlog");
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a handback moves the task to review and warns of drift", () => {
  it.effect(
    "handed_back, the summary as a comment, in_review; a drift warning after an edit",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("handback");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const clean = yield* context.readyTask("Clean handback");
            yield* startAndPrepareExisting(
              context,
              yield* context.runs.start({ id: clean.key }).pipe(Effect.as(clean)),
            );
            yield* waitForRunState(context, clean, "waiting_for_input");
            const handed = yield* context.runs.handback({ id: clean.key, summary: "Done it." });
            assert.strictEqual(handed.state, "handed_back");
            const cleanDetail = yield* detailOf(context, clean);
            assert.strictEqual(cleanDetail.task.status, "in_review");
            const comment = cleanDetail.comments.at(-1)?.body ?? "";
            assert.include(comment, "Done it.");
            assert.notInclude(comment.toLowerCase(), "changed since");

            const drifted = yield* context.readyTask("Drifted handback");
            yield* context.runs.start({ id: drifted.key });
            yield* startAndPrepareExisting(context, drifted);
            const current = (yield* detailOf(context, drifted)).task;
            yield* context.tasks.save({
              id: drifted.key,
              expectedRevision: current.revision,
              patch: { description: "edited while running" },
            });
            yield* context.runs.handback({ id: drifted.key, summary: "Also done." });
            const driftDetail = yield* detailOf(context, drifted);
            const warning = driftDetail.comments.at(-1)?.body ?? "";
            assert.include(warning, "Also done.");
            assert.include(warning.toLowerCase(), "changed since");
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("stop, resume and retry act on the run", () => {
  it.effect(
    "stop cancels; resume and retry open the next attempt in the same worktree and branch",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("control");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const task = yield* context.readyTask("Controlled");
            const first = yield* startAndPrepare(context, task, { hold: true });
            yield* waitForRunState(context, task, "running");
            const stopped = yield* context.runs.runControl({ runId: first.id, action: "stop" });
            assert.strictEqual(stopped.state, "cancelled");
            yield* context.settle;
            const firstThread = yield* projectionOf(context, yield* threadOf(first));
            assert.isFalse(
              firstThread.runs.some((run) =>
                ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
              ),
            );
            assert.strictEqual(newestRun(yield* detailOf(context, task)).state, "cancelled");

            const resumed = yield* context.runs.runControl({ runId: first.id, action: "resume" });
            assert.strictEqual(resumed.attempt, 2);
            assert.notStrictEqual(resumed.threadId, first.threadId);
            assert.strictEqual(resumed.branch, first.branch);
            assert.strictEqual(resumed.worktreePath, first.worktreePath);
            yield* waitForRunState(context, task, "waiting_for_input");
            yield* context.runs.handback({ id: task.key, summary: "attempt 2" });

            yield* context.setSettings({ reviewer: selection("codex"), reviewMode: "manual" });
            commitLines(resumed.worktreePath ?? "", "work.ts", 40);
            const reviewed = yield* context.runs.reviewStart({ runId: resumed.id });
            const review = newestRun(reviewed, "review");
            yield* context.runs.reviewSubmit(yield* threadOf(review), {
              runId: review.id,
              verdict: "fail",
              findings: [
                {
                  path: "work.ts",
                  line: 3,
                  severity: "high",
                  category: "bug",
                  message: "the newest finding",
                },
              ],
            });
            const retried = yield* context.runs.runControl({ runId: resumed.id, action: "retry" });
            assert.strictEqual(retried.attempt, 3);
            assert.strictEqual(retried.branch, first.branch);
            assert.strictEqual(retried.worktreePath, first.worktreePath);
            yield* context.settle;
            const brief = userMessages(yield* projectionOf(context, yield* threadOf(retried)))[0];
            assert.include(brief ?? "", "the newest finding");
            assert.include(brief ?? "", "work.ts:3");
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "an unknown run is refused naming it",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("control-unknown");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const refused = yield* refusal(context.runs.runControl({ runId: 999, action: "stop" }));
            assert.strictEqual(refused.kind, "not_found");
            assert.include(refused.message, "999");
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("resume recovers a removed worktree", () => {
  const scenarios = [
    { name: "local branch", deleteLocal: false, merge: false },
    { name: "pushed branch", deleteLocal: true, merge: false },
    { name: "base contains the changes", deleteLocal: false, merge: true },
  ] as const;
  for (const scenario of scenarios) {
    it.effect(
      scenario.name,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeRunsHarness(`recover-${scenario.name.replaceAll(" ", "-")}`);
          yield* runWith(harness, (context) =>
            Effect.gen(function* () {
              const task = yield* context.readyTask("Recover me");
              const first = yield* startAndPrepare(context, task);
              yield* waitForRunState(context, task, "waiting_for_input");
              const worktree = first.worktreePath ?? "";
              const branch = first.branch ?? "";
              const head = commitLines(worktree, "feature.ts", 5);
              git(harness.repo, "push", "-q", "origin", branch);
              yield* context.runs.runControl({ runId: first.id, action: "stop" });
              git(harness.repo, "worktree", "remove", "--force", worktree);
              if (scenario.deleteLocal) git(harness.repo, "branch", "-q", "-D", branch);
              if (scenario.merge) git(harness.repo, "merge", "-q", "--ff-only", branch);
              assert.isFalse(existsSync(worktree));

              const resumed = yield* context.runs.runControl({ runId: first.id, action: "resume" });
              assert.strictEqual(resumed.worktreePath, worktree);
              assert.isTrue(existsSync(join(worktree, "README.md")));
              if (scenario.merge) {
                assert.notStrictEqual(resumed.branch, branch);
                assert.strictEqual(
                  git(worktree, "rev-parse", "HEAD"),
                  git(harness.repo, "rev-parse", "main"),
                );
              } else {
                assert.strictEqual(resumed.branch, branch);
                assert.strictEqual(git(worktree, "rev-parse", "HEAD"), head);
              }
              assert.strictEqual(
                git(worktree, "rev-parse", "--abbrev-ref", "HEAD"),
                resumed.branch ?? "",
              );
            }),
          );
        }),
      TIMEOUT,
    );
  }
});

const registers = (repo: string, path: string) => {
  const wanted = path.replaceAll("\\", "/").toLowerCase();
  return worktreeList(repo).some(
    (line) => line.slice("worktree ".length).replaceAll("\\", "/").toLowerCase() === wanted,
  );
};

describe("task worktree cleanup touches only the task's own trees", () => {
  it.effect(
    "resume drops the task's stale registration and keeps an unrelated one",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("scoped-prune");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const task = yield* context.readyTask("Scoped prune");
            const first = yield* startAndPrepare(context, task);
            yield* waitForRunState(context, task, "waiting_for_input");
            const worktree = first.worktreePath ?? "";
            yield* context.runs.runControl({ runId: first.id, action: "stop" });
            const unrelated = join(harness.root, "unrelated");
            git(harness.repo, "worktree", "add", "-q", "-b", "unrelated", unrelated);
            // Both folders deleted by hand: git still registers both worktrees.
            rmSync(unrelated, { recursive: true, force: true });
            rmSync(worktree, { recursive: true, force: true });
            assert.isTrue(registers(harness.repo, unrelated));

            const resumed = yield* context.runs.runControl({ runId: first.id, action: "resume" });
            assert.strictEqual(resumed.worktreePath, worktree);
            assert.isTrue(existsSync(join(worktree, "README.md")));
            assert.isTrue(
              registers(harness.repo, unrelated),
              "the unrelated registration survives",
            );
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "a separate review tree is removed when its review ends",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("review-tree");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({ reviewer: selection("codex"), reviewMode: "manual" });
            const { task, run } = yield* handedBack(context, "Review tree");
            const worktree = run.worktreePath ?? "";
            // An uncommitted change makes the review read a tree of its own at the head.
            writeFileSync(join(worktree, "uncommitted.ts"), "draft\n");
            yield* context.runs.handback({ id: task.key, summary: "ready" });
            const started = yield* context.runs.reviewStart({ runId: run.id });
            const review = newestRun(started, "review");
            const reviewTree = review.worktreePath ?? "";
            assert.notStrictEqual(reviewTree, worktree);
            assert.isTrue(existsSync(reviewTree));
            yield* context.settle;
            yield* context.runs.reviewSubmit(yield* threadOf(review), {
              runId: review.id,
              verdict: "pass",
              findings: [],
            });
            yield* context.settle;
            assert.isFalse(existsSync(reviewTree), "the review tree is gone");
            assert.isFalse(registers(harness.repo, reviewTree));
            assert.isTrue(
              existsSync(join(worktree, "uncommitted.ts")),
              "the implementer's tree stays",
            );
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a lost thread interrupts the run and a live one restores it", () => {
  for (const action of ["delete", "archive"] as const) {
    it.effect(
      `a ${action}d thread interrupts its run and keeps the task in progress`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeRunsHarness(`lost-${action}`);
          yield* runWith(harness, (context) =>
            Effect.gen(function* () {
              const task = yield* context.readyTask(`Lost by ${action}`);
              const run = yield* startAndPrepare(context, task, { hold: true });
              yield* waitForRunState(context, task, "running");
              const threadId = yield* threadOf(run);
              yield* context.orchestrator.dispatch({
                type: action === "delete" ? "thread.delete" : "thread.archive",
                commandId: CommandId.make(`${action}:${threadId}`),
                threadId,
              } as never);
              yield* waitForRunState(context, task, "interrupted");
              const detail = yield* detailOf(context, task);
              assert.strictEqual(newestRun(detail).reason, `thread ${action}d`);
              assert.strictEqual(detail.task.status, "in_progress");
            }),
          );
        }),
      TIMEOUT,
    );
  }

  it.effect(
    "a restart with the thread run not live interrupts it; the thread running again restores it",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("restart");
        const databaseFile = join(mkdtempSync(join(tmpdir(), "houston-task-runs-db-")), "t.db");
        const { task, threadId, projectId } = yield* runWith(
          harness,
          (context) =>
            Effect.gen(function* () {
              const task = yield* context.readyTask("Survives a restart");
              const run = yield* startAndPrepare(context, task);
              yield* waitForRunState(context, task, "waiting_for_input");
              const threadId = yield* threadOf(run);
              harness.doubles.script.hold.add("before-restart");
              yield* context.send(threadId, "before-restart", "keep going");
              yield* waitForRunState(context, task, "running");
              return { task, threadId, projectId: context.projectId };
            }),
          { databaseFile },
        );
        yield* runWith(
          harness,
          (context) =>
            Effect.gen(function* () {
              const detail = yield* detailOf(context, task);
              assert.strictEqual(newestRun(detail).state, "interrupted");
              assert.strictEqual(newestRun(detail).reason, "server restarted");
              assert.strictEqual(detail.task.status, "in_progress");
              harness.doubles.script.hold.add("after-restart");
              yield* context.send(threadId, "after-restart", "continue");
              yield* waitForRunState(context, task, "running");
            }),
          { databaseFile, projectId, restarted: true },
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "a thread deleted after the last applied event closes its run at the next boot",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("cursor");
        const databaseFile = join(mkdtempSync(join(tmpdir(), "houston-task-runs-db-")), "t.db");
        const { task, threadId, projectId } = yield* runWith(
          harness,
          (context) =>
            Effect.gen(function* () {
              const task = yield* context.readyTask("Deleted in the gap");
              const run = yield* startAndPrepare(context, task);
              yield* waitForRunState(context, task, "waiting_for_input");
              return { task, threadId: yield* threadOf(run), projectId: context.projectId };
            }),
          { databaseFile },
        );
        // The deletion is stored while task runs follow nothing, as after a crash before applying.
        yield* withThreadsOnly(
          harness,
          (orchestrator) =>
            orchestrator.dispatch({
              type: "thread.delete",
              commandId: CommandId.make(`delete-in-gap:${threadId}`),
              threadId,
            } as never),
          { databaseFile },
        );
        yield* runWith(
          harness,
          (context) =>
            Effect.gen(function* () {
              const detail = yield* detailOf(context, task);
              assert.strictEqual(newestRun(detail).state, "interrupted");
              assert.strictEqual(newestRun(detail).reason, "thread deleted");
              // The closed run no longer holds the task: a new start is not refused as busy.
              const again = yield* context.runs.start({ id: task.key });
              assert.notStrictEqual(again.run.id, newestRun(detail).id);
            }),
          { databaseFile, projectId, restarted: true },
        );
      }),
    TIMEOUT,
  );
});

describe("a linked pull request is watched so every push is seen", () => {
  it.effect(
    "linking a pull request starts its watch; a watch that cannot start is noted",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("watch-on-link");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const watchOf = (threadId: ThreadId, number: number) =>
              projectionOf(context, threadId).pipe(
                Effect.map(
                  (projection) =>
                    projection.thread.pullRequests?.find((link) => link.number === number)?.watch,
                ),
              );
            const watched = yield* context.readyTask("Watched link");
            const watchedRun = yield* startAndPrepare(context, watched);
            yield* waitForRunState(context, watched, "waiting_for_input");
            const watchedThread = yield* threadOf(watchedRun);
            yield* linkPullRequest(context, watchedThread, 11);
            yield* context.settle;
            assert.isDefined(
              yield* watchOf(watchedThread, 11),
              "the linked pull request is watched",
            );

            // A settled thread cannot watch: the task says why every_push will not see its pushes.
            const settled = yield* context.readyTask("Settled link");
            const settledRun = yield* startAndPrepare(context, settled);
            yield* waitForRunState(context, settled, "waiting_for_input");
            const settledThread = yield* threadOf(settledRun);
            yield* context.orchestrator.dispatch({
              type: "thread.settle",
              commandId: CommandId.make(`settle:${settledThread}`),
              threadId: settledThread,
            });
            yield* linkPullRequest(context, settledThread, 12);
            yield* context.settle;
            assert.isUndefined(yield* watchOf(settledThread, 12));
            const comments = (yield* detailOf(context, settled)).comments.map(
              (comment) => comment.body,
            );
            assert.isTrue(
              comments.some(
                (body) =>
                  body.includes("https://github.com/houston/tasks/pull/12") &&
                  body.includes("not watched"),
              ),
              JSON.stringify(comments),
            );
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a merged linked pull request completes the task", () => {
  it.effect(
    "merged moves an in-review task to done; closed and unlinked leave it in review",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("merged");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const inReview = (title: string) =>
              Effect.gen(function* () {
                const task = yield* context.readyTask(title);
                const run = yield* startAndPrepare(context, task);
                yield* waitForRunState(context, task, "waiting_for_input");
                yield* context.runs.handback({ id: task.key, summary: "ready" });
                return { task, threadId: yield* threadOf(run) };
              });
            const merged = yield* inReview("Merged");
            const closed = yield* inReview("Closed");
            const unlinked = yield* inReview("Unlinked");
            yield* linkPullRequest(context, merged.threadId, 1);
            yield* linkPullRequest(context, closed.threadId, 2);
            yield* syncPullRequest(context, merged.threadId, 1, "merged");
            yield* syncPullRequest(context, closed.threadId, 2, "closed");
            yield* context.settle;
            const mergedDetail = yield* detailOf(context, merged.task);
            assert.strictEqual(mergedDetail.task.status, "done");
            assert.include(historyActions(mergedDetail), "houston:pr-merged");
            assert.strictEqual((yield* detailOf(context, closed.task)).task.status, "in_review");
            assert.strictEqual((yield* detailOf(context, unlinked.task)).task.status, "in_review");
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "merged leaves an in-progress task in progress",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("merged-in-progress");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const task = yield* context.readyTask("Still working");
            const run = yield* startAndPrepare(context, task);
            yield* waitForRunState(context, task, "waiting_for_input");
            assert.strictEqual((yield* detailOf(context, task)).task.status, "in_progress");
            const threadId = yield* threadOf(run);
            yield* linkPullRequest(context, threadId, 3);
            yield* syncPullRequest(context, threadId, 3, "merged");
            yield* context.settle;
            const detail = yield* detailOf(context, task);
            assert.strictEqual(detail.task.status, "in_progress");
            assert.notInclude(historyActions(detail), "houston:pr-merged");
          }),
        );
      }),
    TIMEOUT,
  );
});

/** A delivery with an initiative, ready to plan. */
const plannableTask = (context: RunsContext, title: string) =>
  Effect.gen(function* () {
    const initiative = yield* context.tasks.saveInitiative({
      projectId: context.projectId,
      name: "Auth",
      trackerDescription: "From the tracker",
    });
    const task = yield* context.readyTask(title);
    yield* context.tasks.saveDomain({
      id: task.key,
      expectedRevision: task.revision,
      kind: "delivery",
      initiativeId: initiative.id,
    });
    return { task: (yield* detailOf(context, task)).task, initiative };
  });

const PROPOSAL = {
  description: "Planned description",
  acceptance: ["planned one", "planned two"],
  pointers: ["src/login.ts"],
  outOfScope: ["the signup page"],
  questions: [],
};

describe("planning needs a read-only run", () => {
  it.effect(
    "a Codex planner runs read-only and is recorded; a provider without readOnlyRun is refused",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("plan-start");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { task, initiative } = yield* plannableTask(context, "Plan me");
            const before = yield* threadIds(context);
            const refused = yield* refusal(
              context.runs.planStart({
                id: task.key,
                expectedRevision: task.revision,
                modelSelection: selection("antigravity"),
              }),
            );
            assert.strictEqual(refused.kind, "unsupported");
            assert.match(refused.message, /antigravity/i);
            assert.include(refused.message, "read_only_run");
            assert.deepEqual(yield* threadIds(context), before);

            const detail = yield* context.runs.planStart({
              id: task.key,
              expectedRevision: task.revision,
              modelSelection: selection("codex"),
            });
            const planning = detail.planning;
            assert.isNotNull(planning);
            assert.strictEqual(planning?.state, "active");
            assert.strictEqual(planning?.taskRevision, task.revision);
            assert.strictEqual(planning?.initiativeRevision, initiative.revision);
            yield* context.settle;
            const turn = harness.doubles.log.started.find(
              (started) => started.input.threadId === planning?.threadId,
            );
            assert.isDefined(turn, "the planner's turn started");
            // The planning thread cannot write: its provider runs it in a read-only sandbox.
            assert.deepInclude(turn?.input.runtimePolicy, READ_ONLY);
            assert.include(turn?.input.message.text ?? "", "Plan me");
            assert.include(turn?.input.message.text ?? "", "From the tracker");
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "a planner messaged on a provider without a read-only run starts no turn and is refused by name",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("plan-moved");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { task } = yield* plannableTask(context, "Moved planner");
            const detail = yield* context.runs.planStart({
              id: task.key,
              expectedRevision: task.revision,
              modelSelection: selection("codex"),
            });
            const plannerId = detail.planning?.threadId as ThreadId;
            yield* context.settle;
            const turnsBefore = harness.doubles.log.started.length;
            const sent = yield* Effect.exit(
              context.orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make("moved-planner"),
                threadId: plannerId,
                messageId: "message:moved-planner" as never,
                text: "Now write the code",
                attachments: [],
                modelSelection: selection("antigravity"),
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              }),
            );
            yield* context.settle;
            const projection = yield* projectionOf(context, plannerId);
            const refusalText =
              sent._tag === "Failure"
                ? Cause.pretty(sent.cause)
                : JSON.stringify(projection.runs.at(-1) ?? null);
            assert.include(refusalText, "needs a read-only run");
            assert.include(refusalText, "antigravity");
            assert.strictEqual(
              harness.doubles.log.started.length,
              turnsBefore,
              "no turn starts on the provider without a read-only run",
            );
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("only the recorded planner submits a plan", () => {
  it.effect(
    "another thread is refused; the planner stores a revision; its other writes are denied",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("plan-submit");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { task } = yield* plannableTask(context, "Submit a plan");
            const started = yield* context.runs.planStart({
              id: task.key,
              expectedRevision: task.revision,
              modelSelection: selection("codex"),
            });
            const planner = started.planning?.threadId as ThreadId;
            const stranger = yield* refusal(
              context.runs.planSubmit(ThreadId.make("thread-not-the-planner"), {
                id: task.key,
                proposal: PROPOSAL,
              }),
            );
            assert.strictEqual(stranger.kind, "invalid");
            assert.include(stranger.message, "no recorded planning session");
            const submitted = yield* context.runs.planSubmit(planner, {
              id: task.key,
              proposal: PROPOSAL,
            });
            assert.strictEqual(submitted.domain.plan?.revision, 1);
            assert.deepEqual(submitted.domain.plan?.proposal.acceptance, PROPOSAL.acceptance);
            assert.strictEqual(submitted.planning?.state, "submitted");
            const denied = yield* context.runs.agentWriteRefusal(planner);
            assert.strictEqual(denied?.code, "capability_denied");
            assert.isUndefined(yield* context.runs.agentWriteRefusal(ThreadId.make("other")));
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a planner's and a reviewer's credential is scoped to their submit", () => {
  it.effect(
    "planner and reviewer turns hold only the submit scope; the implementer holds the usual one",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("submit-scope");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { task } = yield* plannableTask(context, "Scoped planner");
            const planned = yield* context.runs.planStart({
              id: task.key,
              expectedRevision: task.revision,
              modelSelection: selection("codex"),
            });
            yield* context.settle;
            const scopeOf = (threadId: ThreadId | null | undefined) => {
              const turn = harness.doubles.log.started.find(
                (started) => started.input.threadId === threadId,
              );
              assert.isDefined(turn?.mcp, `thread ${threadId} holds a T3 MCP credential`);
              return [...(turn?.mcp?.capabilities ?? [])];
            };
            assert.deepEqual(scopeOf(planned.planning?.threadId), ["houston-task-submit"]);

            yield* context.setSettings({ reviewer: selection("codex"), reviewMode: "manual" });
            const { run } = yield* handedBack(context, "Scoped reviewer");
            assert.notInclude(scopeOf(run.threadId), "houston-task-submit");
            const reviewed = yield* context.runs.reviewStart({ runId: run.id });
            yield* context.settle;
            assert.deepEqual(scopeOf(newestRun(reviewed, "review").threadId), [
              "houston-task-submit",
            ]);
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "over the server's provision, a planner turn runs read-only with only the submit scope",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("server-read-only");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { task } = yield* plannableTask(context, "Server planner");
            const planned = yield* context.runs.planStart({
              id: task.key,
              expectedRevision: task.revision,
              modelSelection: selection("codex"),
            });
            yield* context.settle;
            const turnOf = (threadId: ThreadId | null | undefined) =>
              harness.doubles.log.started.find((started) => started.input.threadId === threadId);
            const planner = turnOf(planned.planning?.threadId);
            assert.isDefined(planner);
            assert.deepInclude(planner.input.runtimePolicy, READ_ONLY);
            assert.deepEqual([...(planner.mcp?.capabilities ?? [])], ["houston-task-submit"]);

            // The implementer of the same project is neither read-only nor submit-only.
            yield* context.setSettings({});
            const run = yield* startAndPrepare(
              context,
              yield* context.readyTask("Server implementer"),
            );
            yield* context.settle;
            const implementer = turnOf(run.threadId);
            assert.isDefined(implementer);
            assert.notDeepEqual(
              implementer.input.runtimePolicy.sandboxPolicy,
              READ_ONLY.sandboxPolicy as never,
            );
            assert.notInclude([...(implementer.mcp?.capabilities ?? [])], "houston-task-submit");
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a planner's and a reviewer's run names its own submit tool", () => {
  it.effect(
    "the planner's policy names the plan submit, the reviewer's the review submit, the implementer's none",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("submit-tool");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const policyOf = (threadId: ThreadId | null | undefined) => {
              const turn = harness.doubles.log.started.find(
                (started) => started.input.threadId === threadId,
              );
              assert.isDefined(turn, `thread ${threadId} started a turn`);
              return turn.input.runtimePolicy;
            };
            const { task } = yield* plannableTask(context, "Tool planner");
            const planned = yield* context.runs.planStart({
              id: task.key,
              expectedRevision: task.revision,
              modelSelection: selection("codex"),
            });
            yield* context.settle;
            assert.strictEqual(
              policyOf(planned.planning?.threadId).houstonTaskSubmitTool,
              "houston_task_plan_submit",
            );

            yield* context.setSettings({ reviewer: selection("codex"), reviewMode: "manual" });
            const { run } = yield* handedBack(context, "Tool reviewer");
            assert.isUndefined(policyOf(run.threadId).houstonTaskSubmitTool);
            const reviewed = yield* context.runs.reviewStart({ runId: run.id });
            yield* context.settle;
            assert.strictEqual(
              policyOf(newestRun(reviewed, "review").threadId).houstonTaskSubmitTool,
              "houston_task_review_submit",
            );
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("approval applies the plan only at the revisions it read", () => {
  it.effect(
    "current revisions replace description and acceptance without a run; an edit is a conflict",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("plan-approve");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const plan = (title: string) =>
              Effect.gen(function* () {
                const planned = yield* plannableTask(context, title);
                const started = yield* context.runs.planStart({
                  id: planned.task.key,
                  expectedRevision: planned.task.revision,
                  modelSelection: selection("codex"),
                });
                yield* context.runs.planSubmit(started.planning?.threadId as ThreadId, {
                  id: planned.task.key,
                  proposal: PROPOSAL,
                });
                return { ...planned, task: (yield* detailOf(context, planned.task)).task };
              });
            const good = yield* plan("Approve me");
            const approved = yield* context.runs.planApprove({
              id: good.task.key,
              expectedRevision: good.task.revision,
              planRevision: 1,
            });
            assert.strictEqual(approved.task.description, PROPOSAL.description);
            assert.deepEqual(
              approved.acceptance.map((item) => item.text),
              PROPOSAL.acceptance,
            );
            assert.strictEqual(approved.runs.length, 0);

            const edited = yield* plan("Edited task");
            const after = yield* context.tasks.save({
              id: edited.task.key,
              expectedRevision: edited.task.revision,
              patch: { title: "Edited task, renamed" },
            });
            const taskConflict = yield* refusal(
              context.runs.planApprove({
                id: edited.task.key,
                expectedRevision: after.revision,
                planRevision: 1,
              }),
            );
            assert.strictEqual(taskConflict.kind, "conflict");

            const initiativeMoved = yield* plan("Initiative moved");
            yield* context.tasks.saveInitiative({
              projectId: context.projectId,
              id: initiativeMoved.initiative.id,
              expectedRevision: initiativeMoved.initiative.revision,
              name: "Auth, renamed",
            });
            const initiativeConflict = yield* refusal(
              context.runs.planApprove({
                id: initiativeMoved.task.key,
                expectedRevision: initiativeMoved.task.revision,
                planRevision: 1,
              }),
            );
            assert.strictEqual(initiativeConflict.kind, "conflict");
            const unchanged = yield* detailOf(context, initiativeMoved.task);
            assert.strictEqual(unchanged.task.description, "");
            assert.deepEqual(
              unchanged.acceptance.map((item) => item.text),
              ["it works"],
            );
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a restart settles planning and allows a retry", () => {
  it.effect(
    "an active session becomes exited and plan.start succeeds again",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("plan-restart");
        const databaseFile = join(mkdtempSync(join(tmpdir(), "houston-task-plan-db-")), "t.db");
        const { task, projectId } = yield* runWith(
          harness,
          (context) =>
            Effect.gen(function* () {
              const { task } = yield* plannableTask(context, "Plan across a restart");
              yield* context.runs.planStart({
                id: task.key,
                expectedRevision: task.revision,
                modelSelection: selection("codex"),
              });
              return { task, projectId: context.projectId };
            }),
          { databaseFile },
        );
        yield* runWith(
          harness,
          (context) =>
            Effect.gen(function* () {
              const settled = yield* detailOf(context, task);
              assert.strictEqual(settled.planning?.state, "exited");
              const again = yield* context.runs.planStart({
                id: task.key,
                expectedRevision: settled.task.revision,
                modelSelection: selection("codex"),
              });
              assert.strictEqual(again.planning?.state, "active");
            }),
          { databaseFile, projectId },
        );
      }),
    TIMEOUT,
  );
});

/** An in-review task whose implementation made a reviewable change; returns its run. */
const handedBack = (context: RunsContext, title: string) =>
  Effect.gen(function* () {
    const task = yield* context.readyTask(title);
    const run = yield* startAndPrepare(context, task);
    yield* waitForRunState(context, task, "waiting_for_input");
    const head = commitLines(run.worktreePath ?? "", `${task.number}.ts`, 40);
    return { task, run, head };
  });

describe("every push reviews the pushed head only", () => {
  it.effect(
    "the review worktree holds the pushed head, not a newer local commit or an uncommitted change",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("every-push");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({ reviewer: selection("codex"), reviewMode: "every_push" });
            const { task, run, head } = yield* handedBack(context, "Pushed head");
            const worktree = run.worktreePath ?? "";
            commitLines(worktree, "unpushed.ts", 3);
            writeFileSync(join(worktree, "uncommitted.ts"), "not committed");
            const threadId = yield* threadOf(run);
            yield* linkPullRequest(context, threadId, 7);
            yield* pushHead(context, threadId, 7, head);
            yield* context.until(
              "the every-push review",
              detailOf(context, task).pipe(
                Effect.map((detail) =>
                  detail.runs.some((candidate) => candidate.kind === "review"),
                ),
              ),
            );
            const review = newestRun(yield* detailOf(context, task), "review");
            const reviewTree = review.worktreePath ?? "";
            assert.notStrictEqual(reviewTree, worktree);
            assert.strictEqual(git(reviewTree, "rev-parse", "HEAD"), head);
            assert.isFalse(existsSync(join(reviewTree, "unpushed.ts")));
            assert.isFalse(existsSync(join(reviewTree, "uncommitted.ts")));
            assert.isTrue(existsSync(join(reviewTree, `${task.number}.ts`)));
            yield* context.settle;
            const turn = harness.doubles.log.started.find(
              (started) => started.input.threadId === review.threadId,
            );
            assert.deepInclude(turn?.input.runtimePolicy, READ_ONLY);
            assert.strictEqual(
              readFileSync(join(worktree, "uncommitted.ts"), "utf8"),
              "not committed",
            );
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("a verdict is pinned to its head and goes outdated", () => {
  it.effect(
    "the verdict names the reviewed head and reads outdated after a new push",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("outdated");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({ reviewer: selection("codex"), reviewMode: "manual" });
            const { task, run, head } = yield* handedBack(context, "Pinned verdict");
            yield* context.runs.handback({ id: task.key, summary: "ready" });
            const started = yield* context.runs.reviewStart({ runId: run.id });
            const review = newestRun(started, "review");
            const submitted = yield* context.runs.reviewSubmit(yield* threadOf(review), {
              runId: review.id,
              verdict: "pass",
              findings: [],
            });
            const verdict = newestRun(submitted, "review").review;
            assert.strictEqual(verdict?.headSha, head);
            assert.strictEqual(verdict?.verdict, "pass");
            assert.isFalse(verdict?.outdated);
            const threadId = yield* threadOf(run);
            yield* linkPullRequest(context, threadId, 9);
            const next = commitLines(run.worktreePath ?? "", "next.ts", 2);
            yield* pushHead(context, threadId, 9, next);
            yield* context.settle;
            assert.isTrue(newestRun(yield* detailOf(context, task), "review").review?.outdated);
          }),
        );
      }),
    TIMEOUT,
  );
});

const failReview = (context: RunsContext, task: HoustonTask, message: string) =>
  Effect.gen(function* () {
    yield* context.until(
      "an open review",
      detailOf(context, task).pipe(
        Effect.map((detail) => {
          const review = detail.runs.find((run) => run.kind === "review");
          return (
            review !== undefined && review.review?.verdict === undefined && review.threadId !== null
          );
        }),
      ),
    );
    const review = newestRun(yield* detailOf(context, task), "review");
    return yield* context.runs.reviewSubmit(yield* threadOf(review), {
      runId: review.id,
      verdict: "fail",
      findings: [{ path: "a.ts", line: 1, severity: "high", category: "bug", message }],
    });
  });

describe("a failed review reworks up to the configured rounds", () => {
  it.effect(
    "rounds 2: two automatic retries, the third failure stops at needs_review",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("rework");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({
              reviewer: selection("codex"),
              reviewMode: "handback",
              reworkRounds: 2,
            });
            const { task } = yield* handedBack(context, "Rework me");
            yield* context.runs.handback({ id: task.key, summary: "round 0" });
            for (const round of [1, 2, 3]) {
              const failed = yield* failReview(context, task, `finding of round ${round}`);
              assert.include(
                failed.comments.map((comment) => comment.body).join("\n"),
                `finding of round ${round}`,
              );
              if (round === 3) break;
              yield* context.until(
                `attempt ${round + 1}`,
                detailOf(context, task).pipe(
                  Effect.map((detail) => newestRun(detail).attempt === round + 1),
                ),
              );
              const retry = newestRun(yield* detailOf(context, task));
              yield* waitForRunState(context, task, "waiting_for_input");
              commitLines(retry.worktreePath ?? "", `round-${round}.ts`, 40);
              yield* context.runs.handback({ id: task.key, summary: `round ${round}` });
            }
            yield* context.settle;
            const detail = yield* detailOf(context, task);
            const implementation = detail.runs.filter((run) => run.kind === "implementation");
            assert.strictEqual(implementation.length, 3);
            assert.strictEqual(newestRun(detail).state, "needs_review");
            assert.strictEqual(
              historyActions(detail).filter((action) => action === "houston:rework").length,
              2,
            );
            for (const run of implementation) {
              const messages = userMessages(yield* projectionOf(context, yield* threadOf(run)));
              assert.strictEqual(messages.length, 1, "only the brief reaches each attempt");
            }
            const third = userMessages(
              yield* projectionOf(context, yield* threadOf(implementation[0] as HoustonTaskRun)),
            )[0];
            assert.include(third ?? "", "finding of round 2");
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("with no rework rounds the findings are information only", () => {
  it.effect(
    "one queued message with the findings, and no new attempt",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("no-rework");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({
              reviewer: selection("codex"),
              reviewMode: "handback",
              reworkRounds: 0,
            });
            const { task, run, head } = yield* handedBack(context, "Information only");
            yield* context.runs.handback({ id: task.key, summary: "done" });
            yield* failReview(context, task, "an informational finding");
            yield* context.settle;
            const detail = yield* detailOf(context, task);
            assert.strictEqual(
              detail.runs.filter((item) => item.kind === "implementation").length,
              1,
            );
            assert.strictEqual(newestRun(detail).state, "needs_review");
            const messages = userMessages(yield* projectionOf(context, yield* threadOf(run)));
            assert.strictEqual(messages.length, 2);
            assert.include(messages[1] ?? "", "an informational finding");
            assert.strictEqual(git(run.worktreePath ?? "", "rev-parse", "HEAD"), head);
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("small diffs skip and each head has an attempt cap", () => {
  it.effect(
    "a small automatic review is skipped with its counts; a third start on one head is refused",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("skip-cap");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({ reviewer: selection("codex"), reviewMode: "handback" });
            const small = yield* context.readyTask("Small change");
            const smallRun = yield* startAndPrepare(context, small);
            yield* waitForRunState(context, small, "waiting_for_input");
            commitLines(smallRun.worktreePath ?? "", "tiny.ts", 30);
            yield* context.runs.handback({ id: small.key, summary: "tiny" });
            yield* context.settle;
            const skipped = newestRun(yield* detailOf(context, small), "review");
            assert.strictEqual(skipped.review?.verdict, "skipped");
            assert.include(skipped.review?.skippedReason ?? "", "30 changed line(s) in 1 file(s)");
            assert.isNull(skipped.threadId);

            yield* context.setSettings({ reviewer: selection("codex"), reviewMode: "manual" });
            const { task, run, head } = yield* handedBack(context, "Capped");
            yield* context.runs.handback({ id: task.key, summary: "ready" });
            yield* context.runs.reviewStart({ runId: run.id });
            yield* failReview(context, task, "first");
            yield* context.runs.reviewStart({ runId: run.id });
            yield* failReview(context, task, "second");
            const capped = yield* refusal(context.runs.reviewStart({ runId: run.id }));
            assert.strictEqual(capped.kind, "limit");
            assert.strictEqual(capped.limit, 2);
            assert.include(capped.message, "2 review attempt");
            assert.include(capped.message, head);
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "an every_push refusal note is written once per head and reason",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRunsHarness("refusal-note", [CLAUDE, CODEX, ANTIGRAVITY]);
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            yield* context.setSettings({ reviewer: selection("codex"), reviewMode: "every_push" });
            const { task, run } = yield* handedBack(context, "Unknown head");
            const threadId = yield* threadOf(run);
            yield* linkPullRequest(context, threadId, 11);
            const missing = "0123456789abcdef0123456789abcdef01234567";
            yield* pushHead(context, threadId, 11, missing);
            yield* context.settle;
            yield* pushHead(context, threadId, 11, missing, 1);
            yield* context.settle;
            const notes = (yield* detailOf(context, task)).comments.filter((comment) =>
              comment.body.includes(missing),
            );
            assert.strictEqual(notes.length, 1);
            assert.strictEqual(
              (yield* detailOf(context, task)).runs.filter((item) => item.kind === "review").length,
              0,
            );
          }),
        );
      }),
    TIMEOUT,
  );
});
