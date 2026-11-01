// What landing reads and asks beyond git and GitHub's REST API: CI through upstream's pull
// request service, and the project's merge queue. Tests replace both.
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import { HoustonMergeQueueProject } from "../../mergeQueue/Project.ts";
import { HoustonMergeQueueService } from "../../mergeQueue/Service.ts";
import { NightShiftGit } from "../Git.ts";
import { githubRepository } from "../Host.ts";

export interface CiCheck {
  readonly name: string;
  readonly status: "passed" | "failed" | "pending";
  readonly url: string | null;
}

/** A pull request's checks as GitHub last reported them. */
export class NightShiftCi extends Context.Service<
  NightShiftCi,
  {
    readonly checks: (
      projectId: ProjectId,
      root: string,
      number: number,
    ) => Effect.Effect<ReadonlyArray<CiCheck>, string>;
  }
>()("houston/houston/nightShift/landing/Ports/NightShiftCi") {}

/** The project's merge queue, as landing enqueues into it and the push guard reads it. */
export class NightShiftLandingQueue extends Context.Service<
  NightShiftLandingQueue,
  {
    /** Branches checked out in a managed worktree of the project or recorded on a task run. */
    readonly managedBranches: (projectId: ProjectId) => Effect.Effect<ReadonlySet<string>>;
    readonly queued: (projectId: ProjectId) => Effect.Effect<ReadonlySet<number>>;
    readonly enqueue: (input: {
      readonly projectId: ProjectId;
      readonly number: number;
      readonly dependsOn: number | null;
      readonly ownerThreadId: string;
    }) => Effect.Effect<void, string>;
    readonly dequeue: (projectId: ProjectId, number: number) => Effect.Effect<void, string>;
  }
>()("houston/houston/nightShift/landing/Ports/NightShiftLandingQueue") {}

const STATUS: Record<string, CiCheck["status"]> = {
  success: "passed",
  skipped: "passed",
  neutral: "passed",
  pending: "pending",
  failure: "failed",
  cancelled: "failed",
  "action-required": "failed",
};

/** Reads through upstream's pull request service, never from cache. */
export const layerCi = Layer.effect(
  NightShiftCi,
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(PullRequestService.PullRequestService);
    const git = yield* NightShiftGit;
    return NightShiftCi.of({
      checks: Effect.fn("NightShiftCi.checks")(function* (projectId, root, number) {
        if (Option.isNone(service)) {
          return yield* Effect.fail("pull request reads are not available on this server");
        }
        const origin = yield* git.origin(root);
        const repository = origin.kind === "origin" ? githubRepository(origin.url) : null;
        if (repository === null) {
          return yield* Effect.fail(`the origin of ${root} is not a github.com repository`);
        }
        const read = yield* service.value
          .checks({ projectId, host: "github.com", repository, number, allowStale: false })
          .pipe(Effect.mapError((error) => error.message));
        return (read?.checks ?? []).map((check) => ({
          name: check.name,
          status: STATUS[check.status] ?? "pending",
          url: check.url,
        }));
      }),
    });
  }),
);

const OPERATION = "houston.nightShift.landing";

/** The merge queue's own service and project reads. */
export const layerLandingQueue = Layer.effect(
  NightShiftLandingQueue,
  Effect.gen(function* () {
    const service = yield* HoustonMergeQueueService;
    const projects = yield* HoustonMergeQueueProject;
    const message = (error: { readonly message: string }) => error.message;
    return NightShiftLandingQueue.of({
      managedBranches: Effect.fn("NightShiftLandingQueue.managedBranches")(
        function* (projectId) {
          const project = yield* projects.resolve(OPERATION, projectId);
          const managed = yield* projects.managedBranches(project);
          const tasks = yield* projects.taskBranches(projectId);
          return new Set([...managed, ...tasks]) as ReadonlySet<string>;
        },
        Effect.orElseSucceed(() => new Set<string>() as ReadonlySet<string>),
      ),
      queued: Effect.fn("NightShiftLandingQueue.queued")(
        function* (projectId) {
          const snapshot = yield* service.get({ projectId: ProjectId.make(projectId) });
          return new Set(snapshot.entries.map((entry) => entry.number)) as ReadonlySet<number>;
        },
        Effect.orElseSucceed(() => new Set<number>() as ReadonlySet<number>),
      ),
      enqueue: Effect.fn("NightShiftLandingQueue.enqueue")((input) =>
        service
          .enqueue(
            {
              projectId: input.projectId,
              pullRequest: input.number,
              ...(input.dependsOn === null ? {} : { dependsOn: input.dependsOn }),
            },
            input.ownerThreadId,
          )
          .pipe(Effect.asVoid, Effect.mapError(message)),
      ),
      dequeue: Effect.fn("NightShiftLandingQueue.dequeue")((projectId, number) =>
        service.dequeue({ projectId, number }).pipe(Effect.asVoid, Effect.mapError(message)),
      ),
    });
  }),
);
