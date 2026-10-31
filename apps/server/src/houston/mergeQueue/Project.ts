// @effect-diagnostics nodeBuiltinImport:off - resolves real paths and the home directory.
// What the queue knows about a project: its GitHub repository from the checkout's remote, its
// line, and the branches Houston created there. Git runs through upstream's VcsProcess.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ProjectId } from "@t3tools/contracts";
import { houstonTaskKey, type HoustonTaskRunState } from "@t3tools/contracts/houston/tasks";
import { parseGitRemoteRepository } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { managedWorktreesDirectories } from "../../worktreesDirectory.ts";
import { HoustonBuildSlot } from "./BuildSlot.ts";
import {
  line,
  order,
  refuse,
  wslRefusal,
  type LineContext,
  type QueueRow,
  type Review,
} from "./rules.ts";
import { HoustonMergeQueueStore } from "./Store.ts";

/** Local git work; fetches and pushes cross the network and get longer. */
export const GIT_LOCAL_TIMEOUT_MS = 120_000;
export const GIT_NETWORK_TIMEOUT_MS = 600_000;

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Command-scope config for every queue git process and the git it starts. Automatic gc and
// maintenance leave a child holding the output pipe and, on Windows, the scratch worktree.
const QUEUE_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  // The user's config stops at the scratch worktree: no other branch, hook, tag or submodule.
  ["rebase.updateRefs", "false"],
  ["core.hooksPath", "/dev/null"],
  ["commit.gpgSign", "false"],
  ["rerere.enabled", "false"],
  ["submodule.recurse", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["push.followTags", "false"],
  ["push.recurseSubmodules", "no"],
  ["push.gpgSign", "false"],
  ["core.fsmonitor", "false"],
];

const queueGitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const [key, value] of QUEUE_GIT_CONFIG) {
    Object.assign(env, VcsProcess.gitConfigEnv(env, key, value, process.platform));
  }
  return env;
};

/** Runs git in `cwd`; a git that could not run fails with its error's text. */
export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  timeoutMs = GIT_LOCAL_TIMEOUT_MS,
): Effect.Effect<GitResult, string, VcsProcess.VcsProcess> =>
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    const output = yield* vcs
      .run({
        operation: "HoustonMergeQueue.git",
        command: "git",
        args,
        cwd,
        allowNonZeroExit: true,
        timeoutMs,
        env: queueGitEnv(),
      })
      .pipe(Effect.mapError((error) => `git ${args[0] ?? ""} in ${cwd}: ${error.message}`));
    return { exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr };
  });

/** Runs git and fails with its stderr unless it exits 0; the trimmed stdout otherwise. */
export const gitOk = (cwd: string, args: ReadonlyArray<string>, timeoutMs?: number) =>
  git(cwd, args, timeoutMs).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.fail(
            `git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
          ),
    ),
  );

export interface ProjectInfo {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

/** A project whose checkout's remote is on GitHub. */
export interface ProjectTarget extends ProjectInfo {
  readonly remote: string;
  readonly host: string;
  /** `owner/name`. */
  readonly repository: string;
}

const isGitHubHost = (host: string) =>
  host === "github.com" || host.endsWith(".ghe.com") || host.includes("github");

export interface QueueView {
  readonly rows: ReadonlyArray<QueueRow>;
  readonly reviews: ReadonlyArray<Review>;
  readonly context: LineContext;
  readonly entries: ReturnType<typeof line>;
}

export class HoustonMergeQueueProject extends Context.Service<
  HoustonMergeQueueProject,
  {
    readonly resolve: (
      operation: string,
      projectId: ProjectId,
    ) => Effect.Effect<ProjectInfo, ReturnType<typeof refuse>>;
    /** The project and its GitHub remote; `unsupported` without one. */
    readonly target: (
      operation: string,
      projectId: ProjectId,
    ) => Effect.Effect<ProjectTarget, ReturnType<typeof refuse>>;
    /** Why the queue does not move: which pause holds, if any. */
    readonly pausedReason: (project: ProjectInfo) => Effect.Effect<string | null>;
    /** The rows in line order with their gates, statuses and reasons. */
    readonly view: (project: ProjectInfo) => Effect.Effect<QueueView>;
    /** Upstream's managed worktrees directories, current and previous. */
    readonly managedDirectories: Effect.Effect<ReadonlyArray<string>>;
    /** Branches checked out in a worktree under a managed worktrees directory of the project. */
    readonly managedBranches: (project: ProjectInfo) => Effect.Effect<ReadonlySet<string>>;
    /** Branches recorded on a Houston task run of the project. */
    readonly taskBranches: (projectId: ProjectId) => Effect.Effect<ReadonlySet<string>>;
  }
>()("houston/houston/mergeQueue/Project/HoustonMergeQueueProject") {}

interface RunRow {
  readonly task_id: number;
  readonly number: number;
  readonly kind: "implementation" | "review";
  readonly state: HoustonTaskRunState;
  readonly branch: string | null;
  readonly pr_url: string | null;
}

const realLocation = (target: string): string => {
  try {
    return NodeFS.realpathSync.native(target);
  } catch {
    const parent = NodePath.dirname(target);
    return parent === target
      ? target
      : NodePath.join(realLocation(parent), NodePath.basename(target));
  }
};

/** Whether `path` is `root` or inside it, after following links; case-blind on Windows. */
export const resolvesInside = (path: string, root: string) => {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const child = fold(realLocation(NodePath.resolve(path)));
  const parent = fold(realLocation(NodePath.resolve(root)));
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const store = yield* HoustonMergeQueueStore;
  const sql = yield* SqlClient.SqlClient;
  const slot = yield* HoustonBuildSlot;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const withVcs = <A, E>(effect: Effect.Effect<A, E, VcsProcess.VcsProcess>) =>
    Effect.provideService(effect, VcsProcess.VcsProcess, vcs);

  const resolve: HoustonMergeQueueProject["Service"]["resolve"] = (operation, projectId) =>
    projects.get(projectId).pipe(
      Effect.orDie,
      Effect.flatMap((project) =>
        Option.isSome(project) && project.value.deletedAt === null
          ? Effect.succeed({
              projectId,
              title: project.value.title,
              workspaceRoot: project.value.workspaceRoot,
            })
          : Effect.fail(refuse("not_found", operation, `no project ${projectId}`)),
      ),
    );

  const target: HoustonMergeQueueProject["Service"]["target"] = Effect.fn(
    "HoustonMergeQueueProject.target",
  )(function* (operation, projectId) {
    const project = yield* resolve(operation, projectId);
    const unsupported = (why: string) =>
      refuse("unsupported", operation, `the merge queue needs a GitHub remote; ${why}`);
    const remotes = yield* withVcs(gitOk(project.workspaceRoot, ["remote"])).pipe(
      Effect.mapError(() => unsupported(`${project.workspaceRoot} is not a git repository`)),
    );
    const names = remotes.split(/\r?\n/).filter((name) => name.length > 0);
    const remote = names.includes("origin") ? "origin" : names[0];
    if (remote === undefined) return yield* unsupported(`${project.title} has no git remote`);
    // The configured URL, before any insteadOf rewrite, names the host.
    const url = yield* withVcs(
      gitOk(project.workspaceRoot, ["config", "--get", `remote.${remote}.url`]),
    ).pipe(Effect.mapError(() => unsupported(`remote ${remote} has no URL`)));
    const parsed = parseGitRemoteRepository(url);
    if (parsed === null || !isGitHubHost(parsed.host)) {
      return yield* unsupported(`remote ${remote} of ${project.title} is ${url}`);
    }
    const segments = parsed.path.split("/");
    if (segments.length !== 2) {
      return yield* unsupported(`remote ${remote} of ${project.title} is ${url}`);
    }
    return { ...project, remote, host: parsed.host, repository: parsed.path };
  });

  const pausedReason = Effect.fn("HoustonMergeQueueProject.pausedReason")(function* (
    project: ProjectInfo,
  ) {
    if (yield* store.globalPaused) return "every merge queue is paused";
    const settings = yield* store.settings(project.projectId);
    return settings.paused ? `the merge queue of ${project.title} is paused` : null;
  });

  const reviewsOf = (projectId: ProjectId, rows: ReadonlyArray<QueueRow>) =>
    sql<RunRow>`
      SELECT r.task_id, t.number, r.kind, r.state, r.branch, r.pr_url
      FROM houston_task_runs r
      JOIN houston_tasks t ON t.id = r.task_id
      JOIN houston_task_domain d ON d.task_id = t.id
      WHERE t.project_id = ${projectId} AND d.kind = 'slice'
      ORDER BY r.id DESC
    `.pipe(
      Effect.map((runs) =>
        rows.map((row): Review => {
          const newest = new Map<number, RunRow>();
          for (const run of runs) {
            if (run.kind === "implementation" && !newest.has(run.task_id))
              newest.set(run.task_id, run);
          }
          const match = [...newest.values()].find(
            (run) => run.branch === row.headRef || (run.pr_url !== null && run.pr_url === row.url),
          );
          if (match === undefined) return { kind: "notSlice" };
          const review = runs.find((run) => run.task_id === match.task_id && run.kind === "review");
          return { kind: "slice", key: houstonTaskKey(match.number), state: review?.state ?? null };
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.succeed(
          rows.map((): Review => ({ kind: "unreadable", error: String(cause).slice(0, 300) })),
        ),
      ),
    );

  const view = Effect.fn("HoustonMergeQueueProject.view")(function* (project: ProjectInfo) {
    const rows = order(yield* store.rows(project.projectId));
    const reviews = yield* reviewsOf(project.projectId, rows);
    const settings = yield* store.settings(project.projectId);
    const holder = yield* slot.current;
    const context: LineContext = {
      commandSet: settings.verificationCommand.trim().length > 0,
      paused: yield* pausedReason(project),
      running:
        holder !== null && holder.projectId === project.projectId && holder.number !== null
          ? { number: holder.number, since: holder.since }
          : null,
      refusal: wslRefusal(project.workspaceRoot, process.platform),
    };
    return { rows, reviews, context, entries: line(rows, reviews, context) };
  });

  const managedDirectories = serverSettings.getSettings.pipe(
    Effect.map((settings) =>
      managedWorktreesDirectories(settings, config.worktreesDir, path, NodeOS.homedir()),
    ),
    Effect.orElseSucceed(() => [config.worktreesDir]),
  );

  const managedBranches = Effect.fn("HoustonMergeQueueProject.managedBranches")(function* (
    project: ProjectInfo,
  ) {
    const directories = yield* managedDirectories;
    const listed = yield* withVcs(
      gitOk(project.workspaceRoot, ["worktree", "list", "--porcelain"]),
    ).pipe(Effect.orElseSucceed(() => ""));
    const branches = new Set<string>();
    let current: string | null = null;
    for (const entry of listed.split(/\r?\n/)) {
      if (entry.startsWith("worktree ")) current = entry.slice("worktree ".length);
      const branch = /^branch refs\/heads\/(.+)$/.exec(entry)?.[1];
      if (
        branch !== undefined &&
        current !== null &&
        directories.some((directory) => resolvesInside(current!, directory))
      ) {
        branches.add(branch);
      }
    }
    return branches as ReadonlySet<string>;
  });

  const taskBranches = (projectId: ProjectId) =>
    sql<{ readonly branch: string }>`
      SELECT DISTINCT r.branch FROM houston_task_runs r JOIN houston_tasks t ON t.id = r.task_id
      WHERE t.project_id = ${projectId} AND r.branch IS NOT NULL
    `.pipe(
      Effect.map((found) => new Set(found.map((row) => row.branch)) as ReadonlySet<string>),
      Effect.orElseSucceed(() => new Set<string>() as ReadonlySet<string>),
    );

  return HoustonMergeQueueProject.of({
    resolve,
    target,
    pausedReason,
    view,
    managedDirectories,
    managedBranches,
    taskBranches,
  });
});

export const layer = Layer.effect(HoustonMergeQueueProject, make);
