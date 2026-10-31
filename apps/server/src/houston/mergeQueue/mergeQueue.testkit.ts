// @effect-diagnostics nodeBuiltinImport:off - builds temporary git repositories for the tests.
// The merge queue over one database, real git against a local bare remote, and an in-process
// GitHub fake behind PullRequestService and GitHubRest: never api.github.com or real credentials.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  PullRequestOperationError,
  type ModelSelection,
  type PullRequestActionInput,
  type PullRequestActivity,
  type PullRequestCheckStatus,
  type PullRequestChecks,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestReportStateInput,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import type { HoustonMergeQueueEntry } from "@t3tools/contracts/houston/mergeQueue";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubAppSignIn from "@t3tools/source-control-github/server/GitHubAppSignIn";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { HostedLaunch } from "../baseDir.ts";
import * as HoustonTaskStore from "../tasks/TaskStore.ts";
import {
  CONFIGURED_INSTANCES,
  layerInstances,
  layerProjectMetadata,
  layerWorkspacePaths,
} from "../tasks/tasks.testkit.ts";
import { layerMergeQueue } from "./layer.ts";
import { HoustonMergeQueueService } from "./Service.ts";
import * as HoustonMergeQueueStore from "./Store.ts";
import { HoustonMergeQueueThreads, type LaunchRequest, type QueueThread } from "./Threads.ts";

export const OWNER = "o";
export const NAME = "r";
export const REPOSITORY = `${OWNER}/${NAME}`;
export const GITHUB_URL = `https://github.com/${REPOSITORY}.git`;

// Git for the fixtures only: an identity, and no user or system config.
const fixtureEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@example.test",
  GIT_COMMITTER_NAME: "Fixture Committer",
  GIT_COMMITTER_EMAIL: "committer@example.test",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
});

export const git = (cwd: string, args: ReadonlyArray<string>, env = fixtureEnv()): string =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export const tryGit = (cwd: string, args: ReadonlyArray<string>): string | null => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};

export interface Repos {
  readonly root: string;
  /** `owner/name` on GitHub. */
  readonly repository: string;
  /** The bare repository GitHub's remote stands in for. */
  readonly bare: string;
  /** The project's checkout, a clone whose origin is GitHub's URL rewritten to `bare`. */
  readonly checkout: string;
}

const makeDir = (prefix: string) =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));

/** A bare remote with `main` holding `README.md`, and a clone of it as the project checkout. */
export const makeRepos = (prefix = "houston-mq-", repository = REPOSITORY): Repos => {
  const root = makeDir(prefix);
  const bare = NodePath.join(root, "remote.git");
  const seed = NodePath.join(root, "seed");
  const checkout = NodePath.join(root, "checkout");
  const url = `https://github.com/${repository}.git`;
  git(root, ["init", "--bare", "--initial-branch=main", bare]);
  git(root, ["init", "--initial-branch=main", seed]);
  NodeFS.writeFileSync(NodePath.join(seed, "README.md"), "base\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "base"]);
  git(seed, ["push", bare, "main"]);
  git(root, ["clone", "--quiet", bare, checkout]);
  git(checkout, ["remote", "set-url", "origin", url]);
  git(checkout, ["config", `url.${bare.replaceAll("\\", "/")}.insteadOf`, url]);
  return { root, repository, bare, checkout };
};

let clones = 0;

/** Commits `files` on `branch` (from `from`, default main) in a scratch clone and pushes it. */
export const pushBranch = (
  repos: Repos,
  branch: string,
  files: Readonly<Record<string, string>>,
  options: { readonly from?: string; readonly message?: string } = {},
): string => {
  clones += 1;
  const work = NodePath.join(repos.root, `work-${clones}`);
  git(repos.root, ["clone", "--quiet", repos.bare, work]);
  const from = options.from ?? "main";
  if (tryGit(work, ["rev-parse", "--verify", `origin/${branch}`]) !== null) {
    git(work, ["checkout", "--quiet", "-B", branch, `origin/${branch}`]);
  } else {
    git(work, ["checkout", "--quiet", "-B", branch, `origin/${from}`]);
  }
  for (const [file, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(work, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(work, file), text);
  }
  git(work, ["add", "."]);
  git(work, ["commit", "--quiet", "-m", options.message ?? `change ${branch}`]);
  git(work, ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`]);
  const head = git(work, ["rev-parse", "HEAD"]);
  NodeFS.rmSync(work, { recursive: true, force: true });
  return head;
};

export const remoteHead = (repos: Repos, branch: string): string | null =>
  tryGit(repos.bare, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);

/** A worktree of the checkout on `branch` under `directory`, as upstream creates a thread's. */
export const addManagedWorktree = (repos: Repos, directory: string, branch: string): string => {
  const name = repos.repository.split("/")[1] ?? NAME;
  const path = NodePath.join(directory, name, branch.replaceAll("/", "-"));
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  git(repos.checkout, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/heads/${branch}`]);
  git(repos.checkout, ["worktree", "add", "--quiet", path, branch]);
  return path;
};

// The GitHub fake.

export interface FakeRequest {
  readonly via: "rest" | "pullRequestService";
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface FakePull {
  number: number;
  repository: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  title: string;
  headRef: string;
  /** The head's repository; a fork's differs from `repository`. */
  headRepository: string | null;
  baseRef: string;
  /** Null reads the head from the bare remote, as GitHub reports a push. */
  headSha: string | null;
  checks: Array<{ name: string; status: PullRequestCheckStatus; required?: boolean }>;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeState: string;
  mergeability: "mergeable" | "conflicting" | "unknown";
  unresolvedThreads: number;
  threadsTruncated: boolean;
  /** GitHub's merge queue entry, pinned to the commit it was enqueued at. */
  queued: { position: number; sha: string } | null;
  /** The auto-merge request, pinned to the commit it was enabled at. */
  autoMerge: { method: string; sha: string } | null;
  /** GitHub's reason in the newest removal from its merge queue or auto-merge disable event. */
  letGo: string | null;
}

export interface FakeGitHub {
  /** The repository this fake answers for; requests are routed to a fake by repository. */
  readonly repository: string;
  readonly repos: Repos | null;
  readonly pulls: Map<number, FakePull>;
  readonly requests: Array<FakeRequest>;
  readonly reported: Array<PullRequestReportStateInput>;
  defaultBranch: string;
  mergeMethods: { merge: boolean; squash: boolean; rebase: boolean };
  /** When set, every read fails with this message. */
  readFailure: string | null;
  /** Overrides the answer to a merge request; null answers as GitHub would. */
  mergeAnswer: ((number: number, body: Record<string, unknown>) => Response) | null;
  /** Bases whose rules require GitHub's merge queue; a REST merge into one is refused. */
  mergeQueueBases: Set<string>;
  autoMergeAllowed: boolean;
  /** An older GitHub Enterprise: the facts query's hand-off fields are a schema error. */
  schemaLacksHandOff: boolean;
  /** GitHub accepts a hand-off but no read reports it. */
  handOffIgnored: boolean;
  /** The position GitHub's merge queue gives an enqueued pull request. */
  queuePosition: number;
  /** When set, a take-back (dequeue or auto-merge disable) fails with this message. */
  takeBackFailure: string | null;
  /** Upstream's pull request actions the queue ran, in order. */
  actions: Array<PullRequestActionInput>;
}

export const makeGitHub = (repos: Repos | null = null): FakeGitHub => ({
  repository: repos?.repository ?? REPOSITORY,
  repos,
  pulls: new Map(),
  requests: [],
  reported: [],
  defaultBranch: "main",
  mergeMethods: { merge: true, squash: true, rebase: true },
  readFailure: null,
  mergeAnswer: null,
  mergeQueueBases: new Set(),
  autoMergeAllowed: false,
  schemaLacksHandOff: false,
  handOffIgnored: false,
  queuePosition: 1,
  takeBackFailure: null,
  actions: [],
});

/** An open, green, approved and clean pull request on `headRef`. */
export const openPull = (github: FakeGitHub, number: number, patch: Partial<FakePull> = {}) => {
  const pull: FakePull = {
    number,
    repository: github.repository,
    state: "open",
    isDraft: false,
    title: `PR ${number}`,
    headRef: `houston/${number}`,
    headRepository: github.repository,
    baseRef: "main",
    headSha: null,
    checks: [{ name: "build", status: "success", required: true }],
    reviewDecision: "APPROVED",
    mergeState: "CLEAN",
    mergeability: "mergeable",
    unresolvedThreads: 0,
    threadsTruncated: false,
    queued: null,
    autoMerge: null,
    letGo: null,
    ...patch,
  };
  github.pulls.set(number, pull);
  return pull;
};

export const pullUrl = (number: number, repository = REPOSITORY) =>
  `https://github.com/${repository}/pull/${number}`;

const headOf = (github: FakeGitHub, pull: FakePull) =>
  pull.headSha ??
  (github.repos === null
    ? "0".repeat(40)
    : (remoteHead(github.repos, pull.headRef) ?? "0".repeat(40)));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const notFound = () => json({ message: "Not Found" }, 404);

/** Merges `sha` into the base on the bare remote as one squash commit. */
const squashOnRemote = (repos: Repos, base: string, sha: string, message: string) => {
  const parent = remoteHead(repos, base);
  const tree = git(repos.bare, ["rev-parse", `${sha}^{tree}`]);
  const commit = git(repos.bare, [
    "commit-tree",
    tree,
    ...(parent === null ? [] : ["-p", parent]),
    "-m",
    message,
  ]);
  git(repos.bare, ["update-ref", `refs/heads/${base}`, commit]);
  return commit;
};

type Fakes = FakeGitHub | ReadonlyArray<FakeGitHub>;
const fakesOf = (github: Fakes): ReadonlyArray<FakeGitHub> =>
  Array.isArray(github) ? github : [github as FakeGitHub];
const route = (github: Fakes, repository: string | undefined) => {
  const fakes = fakesOf(github);
  return (
    fakes.find((fake) => fake.repository.toLowerCase() === repository?.toLowerCase()) ?? fakes[0]!
  );
};

const restRepository = (path: string, body: unknown) => {
  const match = /\/repos\/([^/]+\/[^/]+)\//.exec(path);
  if (match !== null) return match[1];
  const variables = (body as { variables?: { owner?: string; name?: string } } | undefined)
    ?.variables;
  return variables?.owner === undefined ? undefined : `${variables.owner}/${variables.name}`;
};

/** The node id the fake gives a pull request. */
export const pullNodeId = (number: number) => `PR_node_${number}`;

/** The GraphQL mutations the queue sent, by name, with their variables. */
export const mutationsOf = (github: FakeGitHub) =>
  github.requests.flatMap((request) => {
    const query = (request.body as { query?: unknown } | null)?.query;
    if (typeof query !== "string" || !query.trimStart().startsWith("mutation")) return [];
    const name = /\{\s*(\w+)\s*\(/.exec(query)?.[1] ?? "unknown";
    return [
      {
        name,
        variables: ((request.body as { variables?: Record<string, unknown> }).variables ??
          {}) as Record<string, unknown>,
      },
    ];
  });

const graphqlError = (message: string) => json({ data: null, errors: [{ message }] });

const answerMutation = (github: FakeGitHub, query: string, variables: Record<string, unknown>) => {
  const pull = [...github.pulls.values()].find(
    (candidate) => pullNodeId(candidate.number) === variables.id,
  );
  if (pull === undefined) return graphqlError(`Could not resolve to a node with the global id`);
  const head = headOf(github, pull);
  const pinned = () =>
    variables.oid !== head
      ? `Head sha didn't match expected head sha ${String(variables.oid)}; it is ${head}`
      : null;
  if (query.includes("enqueuePullRequest(")) {
    if (!github.mergeQueueBases.has(pull.baseRef)) {
      return graphqlError(`Merge queue is not enabled for ${pull.baseRef}`);
    }
    const refused = pinned();
    if (refused !== null) return graphqlError(refused);
    if (!github.handOffIgnored) pull.queued = { position: github.queuePosition, sha: head };
    return json({
      data: { enqueuePullRequest: { mergeQueueEntry: { position: github.queuePosition } } },
    });
  }
  if (query.includes("enablePullRequestAutoMerge(")) {
    if (!github.autoMergeAllowed)
      return graphqlError("Auto merge is not allowed for this repository");
    const refused = pinned();
    if (refused !== null) return graphqlError(refused);
    if (!github.handOffIgnored) {
      pull.autoMerge = { method: String(variables.method), sha: head };
    }
    return json({ data: { enablePullRequestAutoMerge: { pullRequest: { number: pull.number } } } });
  }
  const takeBack =
    query.includes("dequeuePullRequest(") || query.includes("disablePullRequestAutoMerge(");
  if (takeBack && github.takeBackFailure !== null) return graphqlError(github.takeBackFailure);
  if (query.includes("dequeuePullRequest(")) {
    pull.queued = null;
    return json({ data: { dequeuePullRequest: { mergeQueueEntry: null } } });
  }
  if (query.includes("disablePullRequestAutoMerge(")) {
    pull.autoMerge = null;
    return json({
      data: { disablePullRequestAutoMerge: { pullRequest: { number: pull.number } } },
    });
  }
  return graphqlError("unknown mutation");
};

const answerFacts = (github: FakeGitHub, query: string, variables: Record<string, unknown>) => {
  const handOff = query.includes("isMergeQueueEnabled");
  if (handOff && github.schemaLacksHandOff) {
    return graphqlError("Field 'isMergeQueueEnabled' doesn't exist on type 'PullRequest'");
  }
  const pull = github.pulls.get(Number(variables.number));
  const handOffFields = (value: FakePull) => ({
    isMergeQueueEnabled: github.mergeQueueBases.has(value.baseRef),
    mergeQueueEntry:
      value.queued === null
        ? null
        : { position: value.queued.position, headCommit: { oid: value.queued.sha } },
    autoMergeRequest:
      value.autoMerge === null ? null : { mergeMethod: value.autoMerge.method.toUpperCase() },
    timelineItems: {
      nodes:
        value.letGo === null
          ? []
          : [{ __typename: "RemovedFromMergeQueueEvent", reason: value.letGo }],
    },
  });
  return json({
    data: {
      repository: {
        defaultBranchRef: { name: github.defaultBranch },
        ...(handOff ? { autoMergeAllowed: github.autoMergeAllowed } : {}),
        pullRequest:
          pull === undefined
            ? null
            : {
                id: pullNodeId(pull.number),
                mergeStateStatus: pull.mergeState,
                reviewDecision: pull.reviewDecision,
                isDraft: pull.isDraft,
                headRefOid: headOf(github, pull),
                ...(handOff ? handOffFields(pull) : {}),
              },
      },
    },
  });
};

/** GitHub merges a pull request it holds: its head squashed onto the base on the bare remote. */
export const githubMerges = (github: FakeGitHub, number: number) => {
  const pull = github.pulls.get(number)!;
  const head = headOf(github, pull);
  const merged =
    github.repos === null
      ? "f".repeat(40)
      : squashOnRemote(github.repos, pull.baseRef, head, `${pull.title} (#${number})`);
  pull.headSha = head;
  pull.state = "merged";
  pull.queued = null;
  pull.autoMerge = null;
  return merged;
};

const answerRest = (github: FakeGitHub, method: string, path: string, body: unknown) => {
  if (github.readFailure !== null) return json({ message: github.readFailure }, 502);
  if (method === "POST" && path.endsWith("/graphql")) {
    const request = body as { query?: string; variables?: Record<string, unknown> };
    const query = request.query ?? "";
    const variables = request.variables ?? {};
    return query.trimStart().startsWith("mutation")
      ? answerMutation(github, query, variables)
      : answerFacts(github, query, variables);
  }
  const retarget = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
  if (method === "PATCH" && retarget !== null) {
    const pull = github.pulls.get(Number(retarget[2]));
    const base = (body as { base?: unknown }).base;
    if (pull === undefined || typeof base !== "string") return notFound();
    pull.baseRef = base;
    return json({ number: pull.number, base: { ref: base } });
  }
  const merge = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(path);
  if (method === "PUT" && merge !== null) {
    const number = Number(merge[2]);
    const request = body as Record<string, unknown>;
    if (github.mergeAnswer !== null) return github.mergeAnswer(number, request);
    const pull = github.pulls.get(number);
    if (pull === undefined || merge[1] !== pull.repository) return notFound();
    if (pull.state !== "open") return json({ message: "Pull Request is not mergeable" }, 405);
    if (github.mergeQueueBases.has(pull.baseRef)) {
      return json(
        { message: `Changes must be made through the merge queue for ${pull.baseRef}` },
        405,
      );
    }
    const head = headOf(github, pull);
    if (request.sha !== head) {
      return json({ message: "Head branch was modified. Review and try the merge again." }, 409);
    }
    const merged =
      github.repos === null
        ? "f".repeat(40)
        : squashOnRemote(github.repos, pull.baseRef, head, `${pull.title} (#${number})`);
    pull.state = "merged";
    return json({ sha: merged, merged: true, message: "Pull Request successfully merged" });
  }
  return notFound();
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
  enabled: false,
  token: () => Effect.succeedNone,
  invalidate: () => Effect.void,
});

/** Upstream's GitHubRest with a Settings credential, answered by `fakes` in process. */
export const layerGitHubRestFake = (fakes: Fakes) => {
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("ghp_merge_queue_test_token"),
          source: "settings" as const,
          fingerprint: `${host}:settings`,
        }),
      saved: () => Effect.succeedNone,
      fingerprint: (host, token) => Effect.succeed(`${host}:${token.length}`),
      invalidate: () => Effect.void,
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const url = new URL(request.url);
        const body =
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : undefined;
        const github = route(fakes, restRepository(url.pathname, body));
        github.requests.push({ via: "rest", method: request.method, path: url.pathname, body });
        return HttpClientResponse.fromWeb(
          request,
          answerRest(github, request.method, url.pathname, body),
        );
      }),
    ),
  );
  return GitHubRest.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http, appSignedOut)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
};

/** Upstream's PullRequestService reads answered from `fakes`; reportState publishes its key. */
export const layerPullRequestFake = (fakes: Fakes) =>
  Layer.effect(
    PullRequestService.PullRequestService,
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<ThreadPullRequestKey>();
      const lookup = (
        operation: string,
        ref: { readonly repository: string; readonly number: number },
      ) =>
        find(route(fakes, ref.repository), operation, ref.number).pipe(
          Effect.map((pull) => ({ pull, github: route(fakes, ref.repository) })),
        );
      const find = (github: FakeGitHub, operation: string, number: number) =>
        Effect.suspend(() => {
          github.requests.push({
            via: "pullRequestService",
            method: "GET",
            path: `${operation}/${number}`,
            body: null,
          });
          if (github.readFailure !== null) {
            return Effect.fail(
              new PullRequestOperationError({
                operation,
                detail: github.readFailure,
              }),
            );
          }
          const pull = github.pulls.get(number);
          return pull === undefined
            ? Effect.fail(
                new PullRequestOperationError({
                  operation,
                  detail: `HTTP 404: no pull request #${number}`,
                }),
              )
            : Effect.succeed(pull);
        });
      const checksOf = (pull: FakePull) =>
        pull.checks.map((check) => ({
          name: check.name,
          status: check.status,
          description: null,
          url: null,
          required: check.required ?? false,
        }));
      return PullRequestService.PullRequestService.of({
        detail: (ref: PullRequestRef) =>
          lookup("detail", ref).pipe(
            Effect.map(
              ({ pull, github }) =>
                ({
                  provider: "github",
                  projectId: ref.projectId,
                  repository: pull.repository,
                  number: pull.number,
                  title: pull.title,
                  body: "",
                  url: pullUrl(pull.number, pull.repository),
                  state: pull.state,
                  isDraft: pull.isDraft,
                  mergeability: pull.mergeability,
                  headBranch: pull.headRef,
                  headRepositoryNameWithOwner: pull.headRepository,
                  headSha: headOf(github, pull),
                  baseBranch: pull.baseRef,
                  checks: checksOf(pull),
                  mergeCapabilities: { ...github.mergeMethods },
                }) as unknown as PullRequestDetail,
            ),
          ),
        activity: (ref: PullRequestRef) =>
          lookup("activity", ref).pipe(
            Effect.map(
              ({ pull }) =>
                ({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreadsTruncated: pull.threadsTruncated,
                  reviewThreads: Array.from({ length: pull.unresolvedThreads }, (_, index) => ({
                    id: `thread-${index}`,
                    path: "a.txt",
                    line: 1,
                    side: "right",
                    isResolved: false,
                    isOutdated: false,
                    comments: [],
                  })),
                  commits: [],
                }) as unknown as PullRequestActivity,
            ),
          ),
        checks: (ref: PullRequestRef) =>
          lookup("checks", ref).pipe(
            Effect.map(
              ({ pull }) =>
                ({ state: pull.state, checks: checksOf(pull) }) as unknown as PullRequestChecks,
            ),
          ),
        runAction: (input: PullRequestActionInput) =>
          lookup("runAction", input).pipe(
            Effect.flatMap(({ github }) => {
              github.actions.push(input);
              return Effect.void;
            }),
          ),
        reportState: (input: PullRequestReportStateInput) =>
          Effect.suspend(() => {
            route(fakes, input.reference.repository).reported.push(input);
            return PubSub.publish(changes, {
              host: input.reference.host ?? "github.com",
              repository: input.reference.repository,
              number: input.reference.number,
            } as ThreadPullRequestKey).pipe(Effect.asVoid);
          }),
        subscribeStateChanges: PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      } as unknown as PullRequestService.PullRequestService["Service"]);
    }),
  );

/** Every git invocation the queue made, by its arguments. */
export interface GitLog {
  readonly calls: Array<ReadonlyArray<string>>;
}

export const makeGitLog = (): GitLog => ({ calls: [] });

/** Upstream's VcsProcess, recording each git invocation before it runs. */
export const layerRecordingVcs = (log: GitLog) =>
  Layer.effect(
    VcsProcess.VcsProcess,
    Effect.gen(function* () {
      const real = yield* VcsProcess.make;
      return VcsProcess.VcsProcess.of({
        run: (input) =>
          Effect.suspend(() => {
            if (input.command === "git") log.calls.push(input.args);
            return real.run(input);
          }),
      });
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

/** The project threads the queue may tell, and every note and launch it sent. */
export interface FakeThreads {
  readonly threads: Array<QueueThread>;
  readonly notes: Array<{
    readonly threadId: string;
    readonly messageId: string;
    readonly text: string;
  }>;
  readonly launched: Array<LaunchRequest>;
  launchFailure: string | null;
}

export const makeThreads = (threads: ReadonlyArray<QueueThread> = []): FakeThreads => ({
  threads: [...threads],
  notes: [],
  launched: [],
  launchFailure: null,
});

export const thread = (
  id: string,
  projectId: string,
  patch: Partial<Omit<QueueThread, "id" | "projectId">> = {},
): QueueThread => ({ id, projectId, branch: null, worktreePath: null, archived: false, ...patch });

export const layerThreadsFake = (fake: FakeThreads) =>
  Layer.succeed(
    HoustonMergeQueueThreads,
    HoustonMergeQueueThreads.of({
      list: (projectId) =>
        Effect.sync(() => fake.threads.filter((value) => value.projectId === projectId)),
      notify: (note) =>
        Effect.sync(() => {
          fake.notes.push({ ...note });
        }),
      launch: (request) =>
        fake.launchFailure !== null
          ? Effect.fail(fake.launchFailure)
          : Effect.sync(() => {
              fake.launched.push(request);
              fake.threads.push(
                thread(request.threadId, request.projectId, {
                  branch: request.branch,
                  worktreePath: request.worktreePath,
                }),
              );
            }),
    }),
  );

export const selection = (instanceId = "codex", model = "test-model"): ModelSelection =>
  ({ instanceId, model }) as ModelSelection;

export interface MergeQueueTestOptions {
  /** One fake, or one per repository. */
  readonly github?: FakeGitHub | ReadonlyArray<FakeGitHub>;
  /** The project threads; none when absent. */
  readonly threads?: FakeThreads;
  readonly gitLog?: GitLog;
  /** A database file that outlives the layer; in memory when absent. */
  readonly databaseFile?: string;
  /** The server base dir; a fresh temporary directory when absent. */
  readonly baseDir?: string;
  /** Whether the reader and runner loops run; tests that step them by hand turn them off. */
  readonly loops?: boolean;
}

/** The merge queue as the server assembles it, with the GitHub fake and real git. */
export const layerMergeQueueTest = (options: MergeQueueTestOptions = {}) => {
  const github = options.github ?? makeGitHub();
  return layerMergeQueue(
    Layer.mergeAll(layerGitHubRestFake(github), layerPullRequestFake(github)).pipe(
      Layer.merge(layerThreadsFake(options.threads ?? makeThreads())),
    ),
    { loops: options.loops ?? true },
  ).pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(ProjectStore.layer),
    // Below the project service, so a project deletion reaches it, as in server.ts.
    Layer.provideMerge(HoustonMergeQueueStore.layer),
    Layer.provideMerge(HoustonTaskStore.layer),
    Layer.provideMerge(layerRecordingVcs(options.gitLog ?? makeGitLog())),
    Layer.provideMerge(layerInstances(CONFIGURED_INSTANCES)),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(layerWorkspacePaths),
    Layer.provideMerge(layerProjectMetadata),
    Layer.provideMerge(
      options.databaseFile === undefined
        ? Layer.fresh(SqlitePersistence.layerMemory)
        : Layer.fresh(SqlitePersistence.layerFromPath(options.databaseFile)),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), options.baseDir ?? { prefix: "houston-mq-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostedLaunch, false)),
  );
};

let projectCommands = 0;

/** Registers a project at `workspaceRoot` through the real project service. */
export const createProject = Effect.fn("HoustonMergeQueueTest.createProject")(function* (
  name: string,
  workspaceRoot: string,
) {
  const projects = yield* ProjectService.ProjectService;
  projectCommands += 1;
  const projectId = ProjectId.make(`project-${name}`);
  yield* projects.create({
    commandId: CommandId.make(`command:houston-mq-test:create:${projectCommands}`),
    projectId,
    title: name,
    workspaceRoot,
  });
  return projectId;
});

export const deleteProject = Effect.fn("HoustonMergeQueueTest.deleteProject")(function* (
  projectId: ProjectId,
) {
  const projects = yield* ProjectService.ProjectService;
  projectCommands += 1;
  yield* projects.delete({
    commandId: CommandId.make(`command:houston-mq-test:delete:${projectCommands}`),
    projectId,
  });
});

export interface ScenarioOptions {
  readonly name?: string;
  readonly command?: string;
  readonly mergeWhenVerified?: boolean;
  /** Branches checked out in a managed worktree; every pull request's branch by default. */
  readonly managed?: ReadonlyArray<string>;
  /** Moves main after the branches, so each verification rebases onto a new base. */
  readonly mainMoves?: boolean;
  readonly heads?: Readonly<Record<number, string>>;
  /** The thread that enqueues each pull request; the user's enqueue when absent. */
  readonly owners?: Readonly<Record<number, string>>;
  /** Each pull request's base branch; main when absent. */
  readonly bases?: Readonly<Record<number, string>>;
}

/** A project whose pull requests `numbers` are open on GitHub and queued in order. */
export const queueScenario = Effect.fn("HoustonMergeQueueTest.queueScenario")(function* (
  github: FakeGitHub,
  numbers: ReadonlyArray<number>,
  options: ScenarioOptions = {},
) {
  const repos = github.repos!;
  const config = yield* ServerConfig.ServerConfig;
  const queue = yield* HoustonMergeQueueService;
  for (const number of numbers) {
    const headRef = options.heads?.[number] ?? `houston/${number}`;
    const baseRef = options.bases?.[number] ?? "main";
    if (remoteHead(repos, baseRef) === null) pushBranch(repos, baseRef, { "base.txt": baseRef });
    pushBranch(repos, headRef, { [`f${number}.txt`]: `${number}\n` }, { from: baseRef });
    openPull(github, number, { headRef, baseRef });
  }
  if (options.mainMoves ?? true) pushBranch(repos, "main", { "main.txt": "moved\n" });
  for (const branch of options.managed ??
    numbers.map((number) => options.heads?.[number] ?? `houston/${number}`)) {
    addManagedWorktree(repos, config.worktreesDir, branch);
  }
  const projectId = yield* createProject(options.name ?? "scenario", repos.checkout);
  if (options.command !== undefined) {
    yield* queue.setSettings({
      projectId,
      mergeWhenVerified: options.mergeWhenVerified ?? false,
      verificationCommand: options.command,
      timeLimitMinutes: 30,
    });
  }
  for (const number of numbers) {
    yield* queue.enqueue({ projectId, pullRequest: number }, options.owners?.[number]);
  }
  return projectId;
});

export const entryOf = (
  snapshot: { readonly entries: ReadonlyArray<HoustonMergeQueueEntry> },
  number: number,
) => snapshot.entries.find((entry) => entry.number === number)!;

/** The rest requests other than the reads every queued entry makes. */
export const writesOf = (github: FakeGitHub) =>
  github.requests.filter((request) => request.via === "rest" && request.method !== "POST");

export const mergesOf = (github: FakeGitHub) =>
  github.requests.filter((request) => request.method === "PUT" && request.path.endsWith("/merge"));

export const pushesOf = (log: GitLog) => log.calls.filter((args) => args.includes("push"));
