// The houston.mergeQueue.* operations: enqueue checks by rules.ts before GitHub is read, the
// snapshot and its subscriptions, settings, pause, and the user's Merge through the landing.
import { ThreadId, type ProjectId } from "@t3tools/contracts";
import {
  HOUSTON_MERGE_QUEUE_LIMITS,
  HoustonMergeQueueError,
  type HoustonMergeQueueEmptyResult,
  type HoustonMergeQueueEnqueueInput,
  type HoustonMergeQueueEntry,
  type HoustonMergeQueueEntryInput,
  type HoustonMergeQueueHandToThreadInput,
  type HoustonMergeQueueHandToThreadResult,
  type HoustonMergeQueueMergeHeadInput,
  type HoustonMergeQueueMergeHeadResult,
  type HoustonMergeQueueMessageResult,
  type HoustonMergeQueuePauseInput,
  type HoustonMergeQueueProjectInput,
  type HoustonMergeQueueSettings,
  type HoustonMergeQueueSettingsSetInput,
  type HoustonMergeQueueSnapshot,
  type HoustonMergeQueueSummary,
  type HoustonMergeQueueSummaryInput,
} from "@t3tools/contracts/houston/mergeQueue";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

import { HoustonMergeQueueGitHub } from "./GitHubQueueClient.ts";
import { HoustonMergeLanding } from "./Landing.ts";
import { HoustonMergeQueueProject, type ProjectInfo, type ProjectTarget } from "./Project.ts";
import {
  checkEnqueue,
  checkSettings,
  failureHolds,
  failureNote,
  handOffMode,
  refuse,
  type CheckedSettings,
  type QueueRow,
} from "./rules.ts";
import { HoustonMergeQueueStore } from "./Store.ts";
import { HoustonMergeQueueThreads } from "./Threads.ts";
import { HoustonMergeVerifier } from "./Verifier.ts";

const PULL_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i;
const HEAD_SHA = /^[0-9a-f]{40}$/i;

export class HoustonMergeQueueService extends Context.Service<
  HoustonMergeQueueService,
  {
    readonly get: (
      input: HoustonMergeQueueProjectInput,
    ) => Effect.Effect<HoustonMergeQueueSnapshot, HoustonMergeQueueError>;
    readonly subscribe: (
      input: HoustonMergeQueueProjectInput,
    ) => Stream.Stream<HoustonMergeQueueSnapshot, HoustonMergeQueueError>;
    readonly subscribeSummary: (
      input: HoustonMergeQueueSummaryInput,
    ) => Stream.Stream<HoustonMergeQueueSummary, HoustonMergeQueueError>;
    /** `ownerThreadId` is the enqueuing thread, for an agent's enqueue. */
    readonly enqueue: (
      input: HoustonMergeQueueEnqueueInput,
      ownerThreadId?: string,
    ) => Effect.Effect<HoustonMergeQueueEntry, HoustonMergeQueueError>;
    readonly dequeue: (
      input: HoustonMergeQueueEntryInput,
    ) => Effect.Effect<HoustonMergeQueueEmptyResult, HoustonMergeQueueError>;
    readonly mergeHead: (
      input: HoustonMergeQueueMergeHeadInput,
    ) => Effect.Effect<HoustonMergeQueueMergeHeadResult, HoustonMergeQueueError>;
    readonly setSettings: (
      input: HoustonMergeQueueSettingsSetInput,
    ) => Effect.Effect<HoustonMergeQueueSettings, HoustonMergeQueueError>;
    readonly pause: (
      input: HoustonMergeQueuePauseInput,
    ) => Effect.Effect<HoustonMergeQueueMessageResult, HoustonMergeQueueError>;
    readonly retry: (
      input: HoustonMergeQueueEntryInput,
    ) => Effect.Effect<HoustonMergeQueueMessageResult, HoustonMergeQueueError>;
    readonly handToThread: (
      input: HoustonMergeQueueHandToThreadInput,
    ) => Effect.Effect<HoustonMergeQueueHandToThreadResult, HoustonMergeQueueError>;
    readonly revert: (
      input: HoustonMergeQueueEntryInput,
    ) => Effect.Effect<HoustonMergeQueueMessageResult, HoustonMergeQueueError>;
    readonly acknowledge: (
      input: HoustonMergeQueueProjectInput,
    ) => Effect.Effect<HoustonMergeQueueEmptyResult, HoustonMergeQueueError>;
  }
>()("houston/houston/mergeQueue/Service/HoustonMergeQueueService") {}

const make = Effect.gen(function* () {
  const store = yield* HoustonMergeQueueStore;
  const projects = yield* HoustonMergeQueueProject;
  const github = yield* HoustonMergeQueueGitHub;
  const landing = yield* HoustonMergeLanding;
  const verifier = yield* HoustonMergeVerifier;
  const threads = yield* HoustonMergeQueueThreads;

  const snapshotOf = Effect.fn("HoustonMergeQueueService.snapshotOf")(function* (
    project: ProjectInfo,
  ) {
    const view = yield* projects.view(project);
    const now = yield* DateTime.now;
    const since = DateTime.formatIso(
      DateTime.subtract(now, { hours: HOUSTON_MERGE_QUEUE_LIMITS.snapshotLogHours }),
    );
    return {
      projectId: project.projectId,
      entries: view.entries,
      log: yield* store.log(project.projectId, since, HOUSTON_MERGE_QUEUE_LIMITS.snapshotLogRows),
      settings: yield* store.settings(project.projectId),
      globalPaused: yield* store.globalPaused,
      away: yield* store.away(project.projectId),
      handOff: yield* store.handOff(project.projectId),
      message: view.context.paused ?? (view.context.commandSet ? view.context.refusal : null),
    } satisfies HoustonMergeQueueSnapshot;
  });

  const get: HoustonMergeQueueService["Service"]["get"] = (input) =>
    projects.target("houston.mergeQueue.get", input.projectId).pipe(Effect.flatMap(snapshotOf));

  const subscribe: HoustonMergeQueueService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const target = yield* projects.target("houston.mergeQueue.subscribe", input.projectId);
        // Subscribing before the first read keeps every change committed during it.
        const subscription = yield* PubSub.subscribe(store.events);
        const first = yield* snapshotOf(target);
        return Stream.concat(
          Stream.succeed(first),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (event) => event.projectId === null || event.projectId === input.projectId,
            ),
            Stream.mapEffect(() => snapshotOf(target)),
          ),
        );
      }),
    );

  const summary = Effect.gen(function* () {
    const parked: Array<HoustonMergeQueueSummary["parked"][number]> = [];
    for (const projectId of yield* store.projectsWithEntries) {
      const rows = yield* store.rows(projectId);
      parked.push({
        projectId,
        parked: rows.filter((row) => failureHolds(row)?.notifiedThreadId === null).length,
      });
    }
    return { parked, globalPaused: yield* store.globalPaused } satisfies HoustonMergeQueueSummary;
  });

  const subscribeSummary: HoustonMergeQueueService["Service"]["subscribeSummary"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(store.events);
        const first = yield* summary;
        return Stream.concat(
          Stream.succeed(first),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => summary)),
        ).pipe(Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)));
      }),
    );

  const enqueue: HoustonMergeQueueService["Service"]["enqueue"] = Effect.fn(
    "HoustonMergeQueueService.enqueue",
  )(function* (input, ownerThreadId) {
    const operation = "houston.mergeQueue.enqueue";
    const target = yield* projects.target(operation, input.projectId);
    let number: number;
    if (typeof input.pullRequest === "number") {
      number = input.pullRequest;
    } else {
      const match = PULL_URL.exec(input.pullRequest.trim());
      if (match === null) {
        return yield* refuse(
          "invalid",
          operation,
          `${input.pullRequest} is not a pull request number or URL`,
        );
      }
      if (match[1]!.toLowerCase() !== target.repository.toLowerCase()) {
        return yield* refuse(
          "invalid",
          operation,
          `${input.pullRequest} is in ${match[1]}, not ${target.repository}; the merge queue of ${target.title} lands only pull requests of ${target.repository}`,
        );
      }
      number = Number(match[2]);
    }
    const dependsOn = input.dependsOn ?? null;
    const refused = checkEnqueue(
      yield* store.rows(target.projectId),
      target.title,
      number,
      dependsOn,
    );
    if (refused !== undefined) return yield* refused;

    const read = yield* github
      .read(target, number)
      .pipe(
        Effect.mapError((error) =>
          refuse("remote", operation, `could not read PR #${number} from GitHub: ${error}`),
        ),
      );
    const { facts } = read;
    if (facts.state !== "open") {
      return yield* refuse(
        "invalid",
        operation,
        `PR #${number} is ${facts.state}; only an open pull request joins the merge queue`,
      );
    }
    if (read.repository.toLowerCase() !== target.repository.toLowerCase()) {
      return yield* refuse(
        "invalid",
        operation,
        `GitHub answers PR #${number} from ${read.repository}, not ${target.repository}; the merge queue lands only pull requests of ${target.repository}`,
      );
    }
    if (
      read.headRepository !== null &&
      read.headRepository.toLowerCase() !== target.repository.toLowerCase()
    ) {
      return yield* refuse(
        "invalid",
        operation,
        `PR #${number}'s branch is in the fork ${read.headRepository}; the merge queue lands only branches in ${target.repository}`,
      );
    }
    if (facts.headRef.trim().length === 0 || facts.headSha.length === 0) {
      return yield* refuse("invalid", operation, `PR #${number} has no head branch`);
    }
    yield* store.upsertEntry({
      projectId: target.projectId,
      number,
      repository: target.repository,
      url: facts.url,
      title: facts.title,
      headRef: facts.headRef,
      headSha: facts.headSha,
      baseRef: facts.baseRef,
      dependsOn,
      ownerThreadId: ownerThreadId ?? null,
      facts,
    });
    if (facts.handOff !== undefined && facts.handOff !== null && facts.baseRef !== null) {
      yield* store.recordHandOff(
        target.projectId,
        facts.baseRef,
        handOffMode(facts, facts.baseRef, {}),
      );
    }
    yield* store.wake;
    const view = yield* projects.view(target);
    return view.entries.find((entry) => entry.number === number)!;
  });

  const dequeue: HoustonMergeQueueService["Service"]["dequeue"] = Effect.fn(
    "HoustonMergeQueueService.dequeue",
  )(function* (input) {
    const operation = "houston.mergeQueue.dequeue";
    const project = yield* projects.resolve(operation, input.projectId);
    const row = (yield* store.rows(input.projectId)).find((value) => value.number === input.number);
    if (row === undefined) {
      return yield* refuse(
        "not_found",
        operation,
        `PR #${input.number} is not in the merge queue of ${project.title}`,
      );
    }
    const target = yield* Effect.result(projects.target(operation, input.projectId));
    if (target._tag === "Success") {
      // What GitHub holds is taken back first; a refusal keeps the entry.
      yield* takeBack(target.success, row).pipe(
        Effect.mapError((error) => refuse("remote", operation, error)),
      );
    }
    yield* store.removeEntry(input.projectId, input.number);
    if (target._tag === "Success") {
      yield* verifier.forget(project.workspaceRoot, target.success.remote, row.headRef);
    }
    yield* store.wake;
    return {};
  });

  /** Takes back what GitHub holds for `row` and forgets the hold. */
  const takeBack = Effect.fn("HoustonMergeQueueService.takeBack")(function* (
    target: ProjectTarget,
    row: QueueRow,
  ) {
    const hold = row.github;
    if (hold === null || hold.mode === "houston") return;
    const nodeId = row.facts?.nodeId ?? null;
    if (nodeId !== null) {
      yield* github.takeBack({ target, number: row.number, nodeId, mode: hold.mode });
    }
    yield* store.setGitHub(target.projectId, row.number, null);
  });

  /** Takes back every hold of the project (or of every project) when its queue pauses. */
  const takeBackAll = (projectIds: ReadonlyArray<ProjectId>) =>
    Effect.forEach(
      projectIds,
      (projectId) =>
        Effect.gen(function* () {
          const target = yield* projects.target("houston.mergeQueue.pause", projectId);
          for (const row of yield* store.rows(projectId)) {
            yield* takeBack(target, row).pipe(
              Effect.catch((error: string) =>
                Effect.logWarning(
                  `Merge queue: taking PR #${row.number} back on pause failed: ${error}`,
                ),
              ),
            );
          }
        }).pipe(Effect.ignore),
      { discard: true },
    );

  const entryRow = Effect.fn("HoustonMergeQueueService.entryRow")(function* (
    operation: string,
    input: HoustonMergeQueueEntryInput,
  ) {
    const project = yield* projects.resolve(operation, input.projectId);
    const row = (yield* store.rows(input.projectId)).find((value) => value.number === input.number);
    if (row === undefined) {
      return yield* refuse(
        "not_found",
        operation,
        `PR #${input.number} is not in the merge queue of ${project.title}`,
      );
    }
    return { project, row };
  });

  const retry: HoustonMergeQueueService["Service"]["retry"] = Effect.fn(
    "HoustonMergeQueueService.retry",
  )(function* (input) {
    const operation = "houston.mergeQueue.retry";
    const { row } = yield* entryRow(operation, input);
    if (failureHolds(row) === null) {
      return yield* refuse(
        "invalid",
        operation,
        `PR #${row.number} is in line, not parked; there is nothing to retry`,
      );
    }
    yield* store.setFailure(input.projectId, row.number, null);
    yield* store.wake;
    return { message: `PR #${row.number} is back in line at ${row.headSha}` };
  });

  const handToThread: HoustonMergeQueueService["Service"]["handToThread"] = Effect.fn(
    "HoustonMergeQueueService.handToThread",
  )(function* (input) {
    const operation = "houston.mergeQueue.handToThread";
    const { project, row } = yield* entryRow(operation, input);
    const failure = failureHolds(row);
    if (failure === null) {
      return yield* refuse(
        "invalid",
        operation,
        `PR #${row.number} is in line, not parked or fixing; only a failed entry is handed to a new thread`,
      );
    }
    const threadId = `merge-queue-${yield* randomUuidV4}`;
    const worktreePath = yield* projects.managedWorktreeOf(project, row.headRef);
    // The only thread the queue launches, and only on the user's word.
    const launched = threads.launch({
      projectId: project.projectId,
      threadId,
      title: `Fix PR #${row.number}${row.title === null ? "" : `: ${row.title}`}`,
      modelSelection: input.modelSelection,
      branch: row.headRef,
      worktreePath,
      messageId: `message:merge-queue:${project.projectId}:${row.number}:${row.headSha}:hand`,
      text: failureNote({
        number: row.number,
        url: row.url,
        title: row.title,
        headRef: row.headRef,
        failure,
      }),
    });
    yield* launched.pipe(
      Effect.mapError((error) =>
        refuse("remote", operation, `launching a thread for PR #${row.number} failed: ${error}`),
      ),
    );
    yield* store.setOwner(project.projectId, row.number, threadId);
    yield* store.setFailure(project.projectId, row.number, {
      ...failure,
      notifiedThreadId: threadId,
    });
    return { threadId: ThreadId.make(threadId) };
  });

  const revert: HoustonMergeQueueService["Service"]["revert"] = Effect.fn(
    "HoustonMergeQueueService.revert",
  )(function* (input) {
    const operation = "houston.mergeQueue.revert";
    const target = yield* projects.target(operation, input.projectId);
    const merged = (yield* store.logOf(input.projectId, input.number)).some(
      (row) => row.kind === "merge",
    );
    if (!merged) {
      return yield* refuse(
        "not_found",
        operation,
        `PR #${input.number} has no queue merge in the merge queue log of ${target.title}`,
      );
    }
    yield* github
      .revert(target, input.number)
      .pipe(Effect.mapError((error) => refuse("remote", operation, error)));
    return {
      message: `GitHub opened a revert pull request for PR #${input.number}; nothing was pushed to the base`,
    };
  });

  const acknowledge: HoustonMergeQueueService["Service"]["acknowledge"] = Effect.fn(
    "HoustonMergeQueueService.acknowledge",
  )(function* (input) {
    const project = yield* projects.resolve("houston.mergeQueue.acknowledge", input.projectId);
    yield* store.acknowledge(project.projectId);
    return {};
  });

  const mergeHead: HoustonMergeQueueService["Service"]["mergeHead"] = (input) =>
    HEAD_SHA.test(input.expectedHeadSha)
      ? landing.land({
          projectId: input.projectId,
          number: input.number,
          expectedHeadSha: input.expectedHeadSha.toLowerCase(),
          unattended: false,
        })
      : Effect.fail(
          refuse(
            "invalid",
            "houston.mergeQueue.mergeHead",
            `expectedHeadSha ${input.expectedHeadSha} is not a full 40-digit hex commit`,
          ),
        );

  const setSettings: HoustonMergeQueueService["Service"]["setSettings"] = Effect.fn(
    "HoustonMergeQueueService.setSettings",
  )(function* (input) {
    const project = yield* projects.resolve("houston.mergeQueue.settings.set", input.projectId);
    yield* store.saveSettings(
      project.projectId,
      (current) => checkSettings(input, current.revision),
      (value: CheckedSettings | HoustonMergeQueueError): value is HoustonMergeQueueError =>
        Schema.is(HoustonMergeQueueError)(value),
    );
    yield* store.wake;
    return yield* store.settings(project.projectId);
  });

  const pause: HoustonMergeQueueService["Service"]["pause"] = Effect.fn(
    "HoustonMergeQueueService.pause",
  )(function* (input) {
    const word = input.paused ? "paused" : "resumed";
    if (input.projectId === undefined) {
      yield* store.setGlobalPaused(input.paused);
      if (input.paused) yield* takeBackAll(yield* store.projectsWithEntries);
      if (!input.paused) yield* store.wake;
      return { message: `every merge queue is ${word}` };
    }
    const project = yield* projects.resolve(
      "houston.mergeQueue.pause",
      input.projectId as ProjectId,
    );
    yield* store.setPaused(project.projectId, input.paused);
    if (input.paused) yield* takeBackAll([project.projectId]);
    if (!input.paused) yield* store.wake;
    return { message: `the merge queue of ${project.title} is ${word}` };
  });

  return HoustonMergeQueueService.of({
    get,
    subscribe,
    subscribeSummary,
    enqueue,
    dequeue,
    mergeHead,
    setSettings,
    pause,
    retry,
    handToThread,
    revert,
    acknowledge,
  });
});

export const layer = Layer.effect(HoustonMergeQueueService, make);
