import { SecretProviderId, SourceControlProviderKind } from "@houston-app/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as SourceControlRateLimit from "@houston-app/source-control-core/server/SourceControlRateLimit";
import type * as SourceControlHost from "@houston-app/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@houston-app/source-control-testing/TestSourceControlHost";

import * as BitbucketApi from "./BitbucketApi.ts";

type HostGit = SourceControlHost.SourceControlHost["Service"]["git"];

const isBitbucketRepositoryLocatorError = Schema.is(BitbucketApi.BitbucketRepositoryLocatorError);

const bitbucketPullRequest = {
  id: 42,
  title: "Add Bitbucket provider",
  state: "OPEN",
  updated_on: "2026-01-02T00:00:00.000Z",
  links: {
    html: {
      href: "https://bitbucket.org/pingdotgg/houston/pull-requests/42",
    },
  },
  source: {
    branch: { name: "feature/source-control" },
    repository: {
      full_name: "octocat/houston",
      workspace: { slug: "octocat" },
    },
  },
  destination: {
    branch: { name: "main" },
    repository: {
      full_name: "pingdotgg/houston",
      workspace: { slug: "pingdotgg" },
    },
  },
};

const repositoryJson = {
  full_name: "pingdotgg/houston",
  links: {
    html: { href: "https://bitbucket.org/pingdotgg/houston" },
    clone: [
      { name: "https", href: "https://bitbucket.org/pingdotgg/houston.git" },
      { name: "ssh", href: "git@bitbucket.org:pingdotgg/houston.git" },
    ],
  },
  mainbranch: { name: "main" },
};

function makeLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  /** Holds the answer until it resolves, in place of answering at once. */
  readonly answer?: (response: Response) => Effect.Effect<Response>;
  readonly requestFailure?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientError.HttpClientError;
  readonly stall?: boolean;
  readonly git?: Partial<HostGit>;
  readonly env?: Record<string, string>;
  readonly remoteUrl?: string;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    input.stall
      ? Effect.never
      : input.requestFailure
        ? Effect.fail(input.requestFailure(request))
        : (input.answer ?? Effect.succeed)(input.response(request)).pipe(
            Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
          ),
  );
  const gitMock = {
    readConfigValue: vi.fn<HostGit["readConfigValue"]>(() =>
      Effect.succeed<string | null>("git@bitbucket.org:pingdotgg/houston.git"),
    ),
    resolvePrimaryRemoteName: vi.fn<HostGit["resolvePrimaryRemoteName"]>(() =>
      Effect.succeed("origin"),
    ),
    ensureRemote: vi.fn<HostGit["ensureRemote"]>(() => Effect.succeed("octocat")),
    fetchRemoteBranch: vi.fn<HostGit["fetchRemoteBranch"]>(() => Effect.void),
    fetchRemoteTrackingBranch: vi.fn<HostGit["fetchRemoteTrackingBranch"]>(() => Effect.void),
    setBranchUpstream: vi.fn<HostGit["setBranchUpstream"]>(() => Effect.void),
    switchRef: vi.fn<HostGit["switchRef"]>((request) =>
      Effect.succeed({ refName: request.refName }),
    ),
    listLocalBranchNames: vi.fn<HostGit["listLocalBranchNames"]>(() => Effect.succeed([])),
  };
  const git = {
    ...gitMock,
    ...input.git,
  } satisfies Partial<HostGit>;

  const listRemotes = vi.fn(() =>
    Effect.succeed({
      remotes: [
        {
          name: "origin",
          url: input.remoteUrl ?? "git@bitbucket.org:pingdotgg/houston.git",
          pushUrl: Option.none(),
          isPrimary: true,
        },
      ],
      freshness: {
        source: "live-local" as const,
        observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
        expiresAt: Option.none(),
      },
    }),
  );
  // The outer effect resolves the repository; the inner one lists its remotes.
  const resolve = vi.fn((_cwd: string) => Effect.succeed(Effect.suspend(listRemotes)));

  const layer = BitbucketApi.layer.pipe(
    Layer.provide(SourceControlRateLimit.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: input.env ?? {
            HOUSTON_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0",
            HOUSTON_BITBUCKET_EMAIL: "user@example.com",
            HOUSTON_BITBUCKET_API_TOKEN: "token",
          },
        }),
      ),
    ),
    Layer.provideMerge(TestSourceControlHost.layer({ git: { ...git, remotes: resolve } })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

  return { execute, git: gitMock, resolve, listRemotes, layer };
}

const queryParam = (
  request: HttpClientRequest.HttpClientRequest,
  key: string,
): string | undefined => {
  const value = request.urlParams.params.find(([name]) => name === key)?.[1];
  return typeof value === "string" ? value : undefined;
};

const branchQuery = (request: HttpClientRequest.HttpClientRequest): string =>
  queryParam(request, "q") ?? "";

const QUERIED_BRANCH = /source\.branch\.name = "((?:[^"\\]|\\.)*)"/gu;

/** The branches a batched query names, in the order it names them. */
const queriedBranches = (request: HttpClientRequest.HttpClientRequest) =>
  [...branchQuery(request).matchAll(QUERIED_BRANCH)].map((match) => match[1] ?? "");

const pullRequestOn = (branch: string, id: number) => ({
  ...bitbucketPullRequest,
  id,
  links: { html: { href: `https://bitbucket.org/pingdotgg/houston/pull-requests/${id}` } },
  source: { branch: { name: branch }, repository: { full_name: "pingdotgg/houston" } },
});

type PullRequestJson = ReturnType<typeof pullRequestOn>;

/** Lists a first page as Bitbucket does: queried branches only, rows in the given (newest-first)
 * order, and a `next` link when more rows match. */
const pullRequestListing =
  (rows: ReadonlyArray<PullRequestJson>) => (request: HttpClientRequest.HttpClientRequest) => {
    const branches = new Set(queriedBranches(request));
    const matching = rows.filter((row) => branches.has(row.source.branch.name));
    const pagelen = Number(queryParam(request, "pagelen"));
    return Response.json({
      values: matching.slice(0, pagelen),
      ...(matching.length > pagelen ? { next: `${request.url}?page=2` } : {}),
    });
  };

const bitbucketContext = (repository: string) => ({
  provider: {
    kind: SourceControlProviderKind.make("bitbucket"),
    name: "Bitbucket",
    baseUrl: "https://bitbucket.org",
  },
  remoteName: "origin",
  remoteUrl: `git@bitbucket.org:${repository}.git`,
});

/** Lets the background batch window pass before reading a branch lookup. */
const afterBatchWindow = <A, E, R>(lookup: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("500 millis");
    return yield* Fiber.join(fiber);
  });

/** Runs lookups together and lets the background batch window pass before reading them. */
const lookUpTogether = <A, E, R>(lookups: ReadonlyArray<Effect.Effect<A, E, R>>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forEach(lookups, (lookup) => Effect.result(lookup), {
      concurrency: "unbounded",
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("500 millis");
    return yield* Fiber.join(fiber);
  });

it.effect("parses pull request responses from the Bitbucket REST API", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        ...bitbucketPullRequest,
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const result = yield* bitbucket.getPullRequest({
      cwd: "/repo",
      reference: "#42",
    });

    assert.deepStrictEqual(result, {
      number: 42,
      title: "Add Bitbucket provider",
      url: "https://bitbucket.org/pingdotgg/houston/pull-requests/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "octocat/houston",
      headRepositoryOwnerLogin: "octocat",
    });
    assert.strictEqual(
      execute.mock.calls[0]?.[0].url,
      "https://api.test.local/2.0/repositories/pingdotgg/houston/pullrequests/42",
    );
  }).pipe(Effect.provide(layer));
});

it.effect.each([false, true])("honors PR URL repositories, context=%s", (withContext) => {
  const { execute, git, layer } = makeLayer({
    response: (request) =>
      Response.json(
        request.url.endsWith("/pullrequests/42")
          ? {
              ...bitbucketPullRequest,
              source: {
                branch: { name: "feature/source-control" },
                repository: { full_name: "another/app" },
              },
              destination: { branch: { name: "main" }, repository: { full_name: "another/app" } },
            }
          : {
              ...repositoryJson,
              full_name: "another/app",
              links: { clone: [{ name: "ssh", href: "git@bitbucket.org:another/app.git" }] },
            },
      ),
  });
  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const input = {
      cwd: "/repo",
      reference: "https://bitbucket.org/another/app/pull-requests/42",
      ...(withContext
        ? {
            context: {
              provider: {
                kind: SourceControlProviderKind.make("bitbucket"),
                name: "Bitbucket",
                baseUrl: "https://bitbucket.org",
              },
              remoteName: "origin",
              remoteUrl: "git@bitbucket.org:pingdotgg/houston.git",
            },
          }
        : {}),
    };
    yield* bitbucket.getPullRequest(input);
    yield* bitbucket.checkoutPullRequest(input);
    assert.deepStrictEqual(
      execute.mock.calls.slice(0, 2).map(([request]) => request.url),
      [
        "https://api.test.local/2.0/repositories/another/app/pullrequests/42",
        "https://api.test.local/2.0/repositories/another/app/pullrequests/42",
      ],
    );
    assert.deepStrictEqual(git.ensureRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      preferredName: "another",
      url: "git@bitbucket.org:another/app.git",
    });
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "octocat",
      remoteBranch: "feature/source-control",
      localBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "feature/source-control",
      remoteName: "octocat",
      remoteBranch: "feature/source-control",
    });
  }).pipe(Effect.provide(layer));
});

it.effect.each([false, true])(
  "reuses matching checkout remotes for numeric references, context=%s",
  (withContext) => {
    const { git, layer } = makeLayer({
      response: () =>
        Response.json({
          ...bitbucketPullRequest,
          source: {
            ...bitbucketPullRequest.source,
            repository: { full_name: "pingdotgg/houston" },
          },
        }),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      yield* bitbucket.checkoutPullRequest({
        cwd: "/repo",
        reference: "#42",
        ...(withContext
          ? {
              context: {
                provider: {
                  kind: SourceControlProviderKind.make("bitbucket"),
                  name: "Bitbucket",
                  baseUrl: "https://bitbucket.org",
                },
                remoteName: "upstream",
                remoteUrl: "git@bitbucket.org:PingDotGG/Houston.git",
              },
            }
          : {}),
      });
      assert.strictEqual(git.ensureRemote.mock.calls.length, 0);
      assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
        cwd: "/repo",
        remoteName: withContext ? "upstream" : "origin",
        remoteBranch: "feature/source-control",
        localBranch: "feature/source-control",
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("lists pull requests with Bitbucket state and source branch query params", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [
          {
            ...bitbucketPullRequest,
            id: 7,
            state: "MERGED",
            source: {
              branch: { name: "feature/merged" },
              repository: { full_name: "pingdotgg/houston" },
            },
          },
        ],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const result = yield* afterBatchWindow(
      bitbucket.listPullRequests({
        cwd: "/repo",
        headSelector: "origin:feature/merged",
        state: "merged",
        limit: 10,
      }),
    );

    assert.strictEqual(result[0]?.state, "merged");
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://api.test.local/2.0/repositories/pingdotgg/houston/pullrequests",
    );
    assert.deepStrictEqual(request?.urlParams.params, [
      ["pagelen", "10"],
      ["sort", "-updated_on"],
      ["q", 'source.branch.name = "feature/merged" AND state = "MERGED"'],
      ["state", "MERGED"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("reads repository clone URLs and default branch", () => {
  const { layer } = makeLayer({
    response: (request) =>
      Response.json(
        request.url.endsWith("/branching-model")
          ? {
              development: {
                branch: { name: "main" },
                name: "main",
                use_mainbranch: true,
              },
            }
          : repositoryJson,
      ),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const cloneUrls = yield* bitbucket.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "pingdotgg/houston",
    });
    const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/houston",
      url: "https://bitbucket.org/pingdotgg/houston.git",
      sshUrl: "git@bitbucket.org:pingdotgg/houston.git",
    });
    assert.strictEqual(defaultBranch, "main");
  }).pipe(Effect.provide(layer));
});

it.effect.each([false, true])(
  "rejects invalid explicit repositories before fallback, context=%s",
  (withContext) => {
    const { execute, resolve, listRemotes, layer } = makeLayer({
      response: () => Response.json(repositoryJson),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      for (const repository of ["houston", "", " \t "]) {
        const error = yield* bitbucket
          .getRepositoryCloneUrls({
            cwd: "/repo",
            repository,
            ...(withContext
              ? {
                  context: {
                    provider: {
                      kind: SourceControlProviderKind.make("bitbucket"),
                      name: "Bitbucket",
                      baseUrl: "https://bitbucket.org",
                    },
                    remoteName: "origin",
                    remoteUrl: "git@bitbucket.org:pingdotgg/houston.git",
                  },
                }
              : {}),
          })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));

        assert.instanceOf(error, BitbucketApi.BitbucketRepositoryLocatorError);
        assert.strictEqual(
          isBitbucketRepositoryLocatorError(error) ? error.repository : null,
          repository,
        );
        assert.strictEqual(resolve.mock.calls.length, 0);
        assert.strictEqual(listRemotes.mock.calls.length, 0);
        assert.strictEqual(execute.mock.calls.length, 0);
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("prefers an explicit repository and uses context when the repository is omitted", () => {
  const { execute, resolve, listRemotes, layer } = makeLayer({
    response: (request) =>
      Response.json(request.url.endsWith("/branching-model") ? {} : repositoryJson),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const context = {
      provider: {
        kind: SourceControlProviderKind.make("bitbucket"),
        name: "Bitbucket",
        baseUrl: "https://bitbucket.org",
      },
      remoteName: "origin",
      remoteUrl: "git@bitbucket.org:another/context.git",
    };
    for (const repository of ["pingdotgg/houston", "https://bitbucket.org/pingdotgg/houston.git"]) {
      yield* bitbucket.getRepositoryCloneUrls({ cwd: "/repo", context, repository });
    }
    yield* bitbucket.getDefaultBranch({ cwd: "/repo", context });

    assert.deepStrictEqual(
      execute.mock.calls.map(([request]) => request.url).toSorted(),
      [
        "https://api.test.local/2.0/repositories/pingdotgg/houston",
        "https://api.test.local/2.0/repositories/pingdotgg/houston",
        "https://api.test.local/2.0/repositories/another/context",
        "https://api.test.local/2.0/repositories/another/context/branching-model",
      ].toSorted(),
    );
    assert.strictEqual(resolve.mock.calls.length, 0);
    assert.strictEqual(listRemotes.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("sends a self-hosted Bitbucket remote nowhere unless an API base url is configured", () =>
  Effect.gen(function* () {
    const remoteUrl = "https://bitbucket.example.com/scm/proj/repo.git";
    const context = {
      provider: {
        kind: SourceControlProviderKind.make("bitbucket"),
        name: "Bitbucket Self-Hosted",
        baseUrl: "https://bitbucket.example.com",
      },
      remoteName: "origin",
      remoteUrl,
    };
    const cloudEnv = {
      HOUSTON_BITBUCKET_EMAIL: "user@example.com",
      HOUSTON_BITBUCKET_API_TOKEN: "t",
    };
    const response = (request: HttpClientRequest.HttpClientRequest) =>
      Response.json(request.url.endsWith("/branching-model") ? {} : repositoryJson);
    const defaultBranch = (setup: ReturnType<typeof makeLayer>, withContext: boolean) =>
      BitbucketApi.BitbucketApi.pipe(
        Effect.flatMap((bitbucket) =>
          bitbucket.getDefaultBranch({ cwd: "/repo", ...(withContext ? { context } : {}) }),
        ),
        Effect.provide(setup.layer),
      );
    const requestedUrls = (setup: ReturnType<typeof makeLayer>) =>
      setup.execute.mock.calls.map(([request]) => request.url).toSorted();

    // A self-hosted remote in the checkout, then a self-hosted context beside a Cloud remote.
    for (const [setup, withContext] of [
      [makeLayer({ response, env: cloudEnv, remoteUrl }), false],
      [makeLayer({ response, env: cloudEnv }), true],
    ] as const) {
      const result = yield* defaultBranch(setup, withContext).pipe(Effect.result);
      assert.deepStrictEqual(requestedUrls(setup), []);
      assert.strictEqual(
        Result.isFailure(result) && result.failure._tag,
        "BitbucketRepositoryRemoteNotFoundError",
      );
    }

    // An explicit repository does not let a self-hosted context reach the Cloud API.
    const explicit = makeLayer({ response, env: cloudEnv });
    const cloneUrls = yield* BitbucketApi.BitbucketApi.pipe(
      Effect.flatMap((bitbucket) =>
        bitbucket.getRepositoryCloneUrls({ cwd: "/repo", context, repository: "proj/repo" }),
      ),
      Effect.provide(explicit.layer),
      Effect.result,
    );
    assert.deepStrictEqual(requestedUrls(explicit), []);
    assert.strictEqual(
      Result.isFailure(cloneUrls) && cloneUrls.failure._tag,
      "BitbucketRepositoryRemoteNotFoundError",
    );

    const cloud = makeLayer({ response, env: cloudEnv });
    yield* defaultBranch(cloud, false);
    assert.deepStrictEqual(requestedUrls(cloud), [
      "https://api.bitbucket.org/2.0/repositories/pingdotgg/houston",
      "https://api.bitbucket.org/2.0/repositories/pingdotgg/houston/branching-model",
    ]);

    const configured = makeLayer({ response, remoteUrl });
    yield* defaultBranch(configured, true);
    assert.deepStrictEqual(requestedUrls(configured), [
      "https://api.test.local/2.0/repositories/proj/repo",
      "https://api.test.local/2.0/repositories/proj/repo/branching-model",
    ]);
  }),
);

it.effect(
  "prefers the Bitbucket branching model development branch as the default PR target",
  () => {
    const { execute, layer } = makeLayer({
      response: (request) =>
        Response.json(
          request.url.endsWith("/branching-model")
            ? {
                development: {
                  branch: { name: "develop" },
                  name: "develop",
                  use_mainbranch: false,
                },
              }
            : repositoryJson,
        ),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

      assert.strictEqual(defaultBranch, "develop");
      assert.deepStrictEqual(
        execute.mock.calls.map((call) => call[0].url).toSorted(),
        [
          "https://api.test.local/2.0/repositories/pingdotgg/houston",
          "https://api.test.local/2.0/repositories/pingdotgg/houston/branching-model",
        ].toSorted(),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "falls back to the repository main branch when the Bitbucket development branch is invalid",
  () => {
    const { layer } = makeLayer({
      response: (request) =>
        Response.json(
          request.url.endsWith("/branching-model")
            ? {
                development: {
                  name: "develop",
                  use_mainbranch: false,
                  is_valid: false,
                },
              }
            : repositoryJson,
        ),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

      assert.strictEqual(defaultBranch, "main");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("creates pull requests using the official REST payload shape", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(bitbucketPullRequest),
  });

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "bitbucket-pr-body-" });
    yield* fileSystem.writeFileString(bodyFile, "PR body");

    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile,
    });

    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://api.test.local/2.0/repositories/pingdotgg/houston/pullrequests",
    );
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    const rawBody = (request.body as { readonly body?: Uint8Array }).body;
    assert.ok(rawBody);
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(rawBody)), {
      title: "Provider PR",
      description: "PR body",
      source: {
        branch: { name: "feature/provider" },
        repository: { full_name: "owner/houston" },
      },
      destination: {
        branch: { name: "main" },
      },
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("reports the account Bitbucket confirms for the configured credential", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ username: "bitbucket-user" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const auth = yield* bitbucket.probeAuth;
    assert.strictEqual(auth.status, "authenticated");
    assert.deepStrictEqual(auth.account, Option.some("bitbucket-user"));
    assert.deepStrictEqual(auth.host, Option.some("bitbucket.org"));
  }).pipe(Effect.provide(layer));
});

it.effect("prefers credentials saved in settings over the environment, without a restart", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ username: "bitbucket-user" }),
  });
  const lastAuthorization = () => execute.mock.calls.at(-1)?.[0].headers.authorization;
  const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;

    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), basic("user@example.com", "token"));

    yield* settings.update({
      sourceControlHosts: {
        bitbucket: { email: "saved@example.com", apiToken: "saved-api-token" },
      },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), basic("saved@example.com", "saved-api-token"));

    yield* settings.update({
      sourceControlHosts: { bitbucket: { accessToken: "saved-access-token" } },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), "Bearer saved-access-token");

    yield* settings.update({
      sourceControlHosts: { bitbucket: { accessToken: "", apiToken: "" } },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(lastAuthorization(), basic("user@example.com", "token"));

    // A reference left in place by getWithSecrets is one its secret provider could not read.
    const requests = execute.mock.calls.length;
    yield* settings.update({
      sourceControlHosts: {
        bitbucket: {
          accessToken: { provider: SecretProviderId.make("vault"), reference: "bb#token" },
        },
      },
    });
    const auth = yield* bitbucket.probeAuth;
    assert.strictEqual(auth.status, "unauthenticated");
    assert.include(Option.getOrThrow(auth.detail), '"vault"');
    const error = yield* afterBatchWindow(
      Effect.flip(
        bitbucket.listPullRequests({ cwd: "/repo", headSelector: "feature", state: "open" }),
      ),
    );
    assert.strictEqual(error._tag, "SettingsSecretUnresolvedError");
    assert.strictEqual(execute.mock.calls.length, requests);
  }).pipe(Effect.provide(layer));
});

it.effect("never puts a saved token that is unsafe for an HTTP header on the wire", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ username: "bitbucket-user" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;

    // Fetch would reject this header with an error quoting the token, and that error reaches
    // clients. The unusable token is ignored, so the environment credential is used instead.
    yield* settings.update({
      sourceControlHosts: { bitbucket: { accessToken: "saved\ntoken" } },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(
      execute.mock.calls.at(-1)?.[0].headers.authorization,
      `Basic ${btoa("user@example.com:token")}`,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reports saved credentials as configured when Bitbucket cannot confirm them", () => {
  const { execute, layer } = makeLayer({
    response: () => new Response(null, { status: 401 }),
    env: { HOUSTON_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0" },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;

    assert.strictEqual((yield* bitbucket.probeAuth).status, "unauthenticated");
    assert.strictEqual(execute.mock.calls.length, 0);

    yield* settings.update({
      sourceControlHosts: { bitbucket: { accessToken: "saved-access-token" } },
    });
    assert.deepStrictEqual(yield* bitbucket.probeAuth, {
      status: "unknown",
      account: Option.none(),
      host: Option.some("bitbucket.org"),
      detail: Option.some("An access token is configured."),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("marks a failed response to a request sent without credentials as anonymous", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ type: "error" }, { status: 404 }),
    env: { HOUSTON_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0" },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
    const read = bitbucket
      .request({ method: "GET", url: "/repositories/acme/private/pullrequests/7" })
      .pipe(Effect.flip);

    const anonymous = yield* read;
    assert.strictEqual(execute.mock.calls.at(-1)?.[0].headers.authorization, undefined);
    assert.instanceOf(anonymous, BitbucketApi.BitbucketResponseError);
    assert.strictEqual(anonymous.status, 404);
    assert.strictEqual(anonymous.anonymous, true);

    yield* settings.update({
      sourceControlHosts: { bitbucket: { accessToken: "saved-access-token" } },
    });
    const authenticated = yield* read;
    assert.instanceOf(authenticated, BitbucketApi.BitbucketResponseError);
    assert.strictEqual(authenticated.status, 404);
    assert.strictEqual(authenticated.anonymous, undefined);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps Bitbucket response bodies out of checkout diagnostics", () => {
  const responseBody = '{"error":{"message":"credential=secret-value"}}';
  const { layer } = makeLayer({
    response: () => new Response(responseBody, { status: 403 }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const error = yield* bitbucket
      .checkoutPullRequest({ cwd: "/repo", reference: "42" })
      .pipe(Effect.flip);

    assert.instanceOf(error, BitbucketApi.BitbucketResponseError);
    assert.strictEqual(error.operation, "getPullRequest");
    assert.strictEqual(error.status, 403);
    assert.strictEqual(error.responseBodyLength, responseBody.length);
    assert.notProperty(error, "responseBody");
    assert.strictEqual(
      error.message,
      "Bitbucket API failed in getPullRequest: Bitbucket returned HTTP 403.",
    );
    assert.notInclude(error.message, "secret-value");
  }).pipe(Effect.provide(layer));
});

it.effect("checks out fork pull requests through an ensured fork remote", () => {
  const { git, layer } = makeLayer({
    response: (request) => {
      if (request.url.endsWith("/repositories/octocat/houston")) {
        return Response.json({
          ...repositoryJson,
          full_name: "octocat/houston",
          links: {
            html: { href: "https://bitbucket.org/octocat/houston" },
            clone: [
              { name: "https", href: "https://bitbucket.org/octocat/houston.git" },
              { name: "ssh", href: "git@bitbucket.org:octocat/houston.git" },
            ],
          },
        });
      }
      return Response.json({
        ...bitbucketPullRequest,
        source: {
          branch: { name: "main" },
          repository: {
            full_name: "octocat/houston",
            workspace: { slug: "octocat" },
          },
        },
      });
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.checkoutPullRequest({
      cwd: "/repo",
      reference: "42",
      force: true,
    });

    assert.deepStrictEqual(git.ensureRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      preferredName: "octocat",
      url: "git@bitbucket.org:octocat/houston.git",
    });
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "octocat",
      remoteBranch: "main",
      localBranch: "houston/pr-42/main",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "houston/pr-42/main",
      remoteName: "octocat",
      remoteBranch: "main",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "houston/pr-42/main",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a url that points away from the configured Bitbucket", () => {
  const { layer, execute } = makeLayer({ response: () => new Response("{}", { status: 200 }) });
  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const error = yield* Effect.flip(
      bitbucket.request({ method: "GET", url: "https://attacker.example/2.0/repositories" }),
    );

    assert.strictEqual(error._tag, "BitbucketUntrustedUrlError");
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps only the host of a url it refuses, never its query", () =>
  Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const error = yield* Effect.flip(
      bitbucket.request({
        method: "GET",
        url: "https://attacker.example/asset?signature=secret-token",
      }),
    );

    assert.strictEqual(error._tag, "BitbucketUntrustedUrlError");
    assert.strictEqual(
      error._tag === "BitbucketUntrustedUrlError" ? error.host : "",
      "https://attacker.example",
    );
    assert.notInclude(error.message, "secret-token");
  }).pipe(Effect.provide(makeLayer({ response: () => new Response("{}", { status: 200 }) }).layer)),
);

it.effect("does not follow a redirect off the configured Bitbucket", () =>
  Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const error = yield* Effect.flip(
      bitbucket.request({ method: "GET", url: "/repositories/acme/web/pullrequests/1/diff" }),
    );

    assert.strictEqual(error._tag, "BitbucketUntrustedUrlError");
  }).pipe(
    Effect.provide(
      makeLayer({
        response: () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/stolen" },
          }),
      }).layer,
    ),
  ),
);

it.effect("follows a redirect that stays on the configured Bitbucket", () =>
  Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const result = yield* bitbucket.request({
      method: "GET",
      url: "/repositories/acme/web/pullrequests/1/diff",
    });

    assert.strictEqual(result.body, "diff --git a/a.ts b/a.ts");
    assert.isFalse(result.truncated);
  }).pipe(
    Effect.provide(
      makeLayer({
        response: (request) =>
          request.url.endsWith("/pullrequests/1/diff")
            ? new Response(null, {
                status: 302,
                headers: { location: "https://api.test.local/2.0/repositories/acme/web/diff/abc" },
              })
            : new Response("diff --git a/a.ts b/a.ts", { status: 200 }),
      }).layer,
    ),
  ),
);

it.effect("cuts a response short rather than reading an unbounded diff into memory", () =>
  Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;

    const result = yield* bitbucket.request({
      method: "GET",
      url: "/repositories/acme/web/pullrequests/1/diff",
      maxBytes: 8,
    });

    assert.strictEqual(result.body, "12345678");
    assert.isTrue(result.truncated);
  }).pipe(
    Effect.provide(
      makeLayer({ response: () => new Response("1234567890", { status: 200 }) }).layer,
    ),
  ),
);

it.effect("pauses background reads after a 429 until Bitbucket's retry-after passes", () => {
  let answered = 0;
  const { execute, layer } = makeLayer({
    response: () => {
      answered += 1;
      return answered === 1
        ? new Response("Rate limit exceeded", { status: 429, headers: { "retry-after": "60" } })
        : Response.json({ values: [] });
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const lookup = afterBatchWindow(
      bitbucket.listPullRequests({
        cwd: "/repo",
        headSelector: "feature/a",
        state: "all",
      }),
    );

    yield* Effect.flip(lookup);
    const paused = yield* Effect.flip(lookup);
    // Keyed by the repository host, where PullRequestService records its own backoff.
    assert.deepInclude(paused, {
      _tag: "SourceControlRateLimitPausedError",
      host: "bitbucket.org",
      // The 429 answers once the batch window has passed.
      retryAt: 60_500,
    });
    assert.strictEqual(execute.mock.calls.length, 1);

    // A user waiting on an answer is not held back by the background pause, and their success
    // does not end it early.
    yield* lookup.pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
    yield* bitbucket.request({
      method: "POST",
      url: "/repositories/acme/web/pullrequests/1/approve",
    });

    yield* TestClock.adjust("58 seconds");
    assert.strictEqual((yield* Effect.flip(lookup))._tag, "SourceControlRateLimitPausedError");

    yield* TestClock.adjust("500 millis");
    yield* lookup;
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a sweep over many branches to a few Bitbucket requests at a time", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    let inFlight = 0;
    let peak = 0;
    const { layer } = makeLayer({
      response: () => Response.json({ values: [] }),
      answer: (response) =>
        Effect.gen(function* () {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          yield* Queue.offer(started, undefined);
          yield* Deferred.await(release);
          inFlight -= 1;
          return response;
        }),
    });

    yield* Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      // One repository each, so no two lookups share a request.
      const sweep = yield* Effect.forEach(
        Array.from({ length: 12 }, (_, index) => `acme/repo-${index}`),
        (repository) =>
          bitbucket.listPullRequests({
            cwd: "/repo",
            context: bitbucketContext(repository),
            headSelector: "feature",
            state: "all",
          }),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("500 millis");
      for (let index = 0; index < 4; index += 1) yield* Queue.take(started);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sweep);
    }).pipe(Effect.provide(layer));

    assert.strictEqual(peak, 4);
  }),
);

it.effect("sends 45 concurrent branch lookups in one repository as 3 requests", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json({ values: [] }) });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const results = yield* lookUpTogether(
      Array.from({ length: 45 }, (_, index) =>
        bitbucket.listPullRequests({
          cwd: "/repo",
          headSelector: `feature/${index}`,
          state: "all",
        }),
      ),
    );

    assert.isTrue(results.every(Result.isSuccess));
    assert.strictEqual(execute.mock.calls.length, 3);
    assert.deepStrictEqual(
      execute.mock.calls
        .map(([request]) => queriedBranches(request).length)
        .toSorted((left, right) => left - right),
      [5, 20, 20],
    );
    assert.deepStrictEqual(
      execute.mock.calls.flatMap(([request]) => queriedBranches(request)).toSorted(),
      Array.from({ length: 45 }, (_, index) => `feature/${index}`).toSorted(),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("gives each batched branch only its own pull requests, up to its limit", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [
          pullRequestOn("feature/b", 5),
          pullRequestOn("feature/a", 4),
          pullRequestOn("feature/unrelated", 3),
          pullRequestOn("feature/a", 2),
          pullRequestOn("feature/b", 1),
        ],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const [a, b, c] = yield* lookUpTogether([
      bitbucket.listPullRequests({ cwd: "/repo", headSelector: "feature/a", state: "all" }),
      bitbucket.listPullRequests({
        cwd: "/repo",
        headSelector: "feature/b",
        state: "all",
        limit: 1,
      }),
      bitbucket.listPullRequests({ cwd: "/repo", headSelector: "feature/c", state: "all" }),
    ]);

    const numbers = (result: typeof a) =>
      Result.getOrThrow(result!).map((pullRequest) => pullRequest.number);
    assert.deepStrictEqual(numbers(a), [4, 2]);
    assert.deepStrictEqual(numbers(b), [5]);
    assert.deepStrictEqual(numbers(c), []);
    assert.strictEqual(execute.mock.calls.length, 1);
    const request = execute.mock.calls[0]![0];
    assert.strictEqual(
      branchQuery(request),
      '(source.branch.name = "feature/a" OR source.branch.name = "feature/b" OR source.branch.name = "feature/c") AND (state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")',
    );
  }).pipe(Effect.provide(layer));
});

it.effect("escapes a branch name so its quotes and backslashes cannot change the filter", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json({ values: [] }) });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const hostile = 'x\\" OR source.branch.name ~ "';
    yield* lookUpTogether([
      bitbucket.listPullRequests({ cwd: "/repo", headSelector: hostile, state: "open" }),
    ]);
    yield* lookUpTogether([
      bitbucket.listPullRequests({ cwd: "/repo", headSelector: hostile, state: "open" }),
      bitbucket.listPullRequests({ cwd: "/repo", headSelector: "trailing\\", state: "open" }),
    ]);

    const [single, batched] = execute.mock.calls.map(([request]) => branchQuery(request));
    assert.strictEqual(
      single,
      'source.branch.name = "x\\\\\\" OR source.branch.name ~ \\"" AND state = "OPEN"',
    );
    assert.strictEqual(
      batched,
      '(source.branch.name = "x\\\\\\" OR source.branch.name ~ \\"" OR source.branch.name = "trailing\\\\") AND state = "OPEN"',
    );
  }).pipe(Effect.provide(layer));
});

it.effect("never merges lookups for different repositories or state filters", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json({ values: [] }) });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const lookup = (repository: string, branch: string, state: "open" | "all") =>
      bitbucket.listPullRequests({
        cwd: "/repo",
        context: bitbucketContext(repository),
        headSelector: branch,
        state,
      });
    yield* lookUpTogether([
      lookup("acme/web", "feature/a", "all"),
      lookup("acme/web", "feature/b", "all"),
      lookup("acme/api", "feature/a", "all"),
      lookup("acme/web", "feature/c", "open"),
    ]);

    assert.deepStrictEqual(
      execute.mock.calls
        .map(([request]) => `${request.url} ${queriedBranches(request).join(",")}`)
        .toSorted(),
      [
        "https://api.test.local/2.0/repositories/acme/api/pullrequests feature/a",
        "https://api.test.local/2.0/repositories/acme/web/pullrequests feature/a,feature/b",
        "https://api.test.local/2.0/repositories/acme/web/pullrequests feature/c",
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("sends a lone lookup as one request once the batch window passes", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ values: [pullRequestOn("feature/a", 9)] }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const lookup = bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/a",
      state: "all",
    });

    const background = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("499 millis");
    assert.strictEqual(execute.mock.calls.length, 0);
    yield* TestClock.adjust("1 millis");
    assert.deepStrictEqual(
      (yield* Fiber.join(background)).map((pullRequest) => pullRequest.number),
      [9],
    );

    const interactive = yield* lookup.pipe(
      Effect.provideService(SourceControlRateLimit.Interactive, true),
      Effect.forkChild,
    );
    yield* TestClock.adjust("50 millis");
    yield* Fiber.join(interactive);
    assert.strictEqual(execute.mock.calls.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("answers a quiet branch that shares a batch with a busy one", () => {
  const listing = pullRequestListing([
    ...Array.from({ length: 600 }, (_, index) => pullRequestOn("feature/busy", 2000 - index)),
    pullRequestOn("feature/quiet", 7),
  ]);
  const { execute, layer } = makeLayer({ response: listing });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const [busy, quiet] = yield* lookUpTogether(
      ["feature/busy", "feature/quiet"].map((branch) =>
        bitbucket.listPullRequests({ cwd: "/repo", headSelector: branch, state: "all" }),
      ),
    );

    assert.deepStrictEqual(
      Result.getOrThrow(busy!).map((pullRequest) => pullRequest.number),
      Array.from({ length: 20 }, (_, index) => 2000 - index),
    );
    assert.deepStrictEqual(
      Result.getOrThrow(quiet!).map((pullRequest) => pullRequest.number),
      [7],
    );
    assert.isAtMost(execute.mock.calls.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("asks about each branch on its own once the shared requests run out", () => {
  const busyBranches = ["feature/busy-0", "feature/busy-1", "feature/busy-2"];
  const quietBranches = Array.from({ length: 10 }, (_, index) => `feature/quiet-${index}`);
  // Each busy branch fills a shared first page in turn; nineteen pull requests per quiet branch,
  // interleaved, all older than the busy branches'.
  const listing = pullRequestListing([
    ...busyBranches.flatMap((branch, busy) =>
      Array.from({ length: 600 }, (_, index) => pullRequestOn(branch, 9000 - busy * 1000 - index)),
    ),
    ...Array.from({ length: 190 }, (_, index) =>
      pullRequestOn(quietBranches[index % 10]!, 1000 - index),
    ),
  ]);
  const { execute, layer } = makeLayer({ response: listing });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const results = yield* lookUpTogether(
      [...busyBranches, ...quietBranches].map((branch) =>
        bitbucket.listPullRequests({ cwd: "/repo", headSelector: branch, state: "all" }),
      ),
    );
    const quiet = results.slice(busyBranches.length);

    for (const busy of results.slice(0, busyBranches.length)) {
      assert.strictEqual(Result.getOrThrow(busy!).length, 20);
    }
    quietBranches.forEach((_, branch) => {
      assert.deepStrictEqual(
        Result.getOrThrow(quiet[branch]!).map((pullRequest) => pullRequest.number),
        Array.from({ length: 19 }, (_, index) => 1000 - branch - index * 10),
      );
    });
    const queried = execute.mock.calls.map(([request]) => queriedBranches(request));
    // Three shared requests, then one per quiet branch the shared ones left unanswered.
    assert.strictEqual(queried.length, 13);
    assert.deepStrictEqual(
      queried
        .slice(3)
        .map(([branch]) => branch)
        .toSorted(),
      quietBranches.toSorted(),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("asks about each branch on its own when a shared first page answers none", () => {
  // Nineteen pull requests per branch, interleaved: the first page holds fewer than twenty of each.
  const branches = ["feature/a", "feature/b", "feature/c"];
  const listing = pullRequestListing(
    Array.from({ length: 57 }, (_, index) => pullRequestOn(branches[index % 3]!, 100 - index)),
  );
  const { execute, layer } = makeLayer({ response: listing });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const results = yield* lookUpTogether(
      branches.map((branch) =>
        bitbucket.listPullRequests({ cwd: "/repo", headSelector: branch, state: "all" }),
      ),
    );

    branches.forEach((_, branch) => {
      assert.deepStrictEqual(
        Result.getOrThrow(results[branch]!).map((pullRequest) => pullRequest.number),
        Array.from({ length: 19 }, (_, index) => 100 - branch - index * 3),
      );
    });
    const sent = execute.mock.calls.map(
      ([request]) =>
        `${request.url} ${queriedBranches(request).join(",")} pagelen=${queryParam(request, "pagelen")}`,
    );
    const url = "https://api.test.local/2.0/repositories/pingdotgg/houston/pullrequests";
    assert.deepStrictEqual(sent[0], `${url} feature/a,feature/b,feature/c pagelen=50`);
    assert.deepStrictEqual(sent.slice(1).toSorted(), [
      `${url} feature/a pagelen=20`,
      `${url} feature/b pagelen=20`,
      `${url} feature/c pagelen=20`,
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("answers the other lookups of a batch when one caller is interrupted", () => {
  const { execute, layer } = makeLayer({
    response: pullRequestListing([pullRequestOn("feature/a", 2), pullRequestOn("feature/c", 1)]),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const [a, b, c] = yield* Effect.forEach(["feature/a", "feature/b", "feature/c"], (branch) =>
      Effect.forkChild(
        bitbucket.listPullRequests({ cwd: "/repo", headSelector: branch, state: "all" }),
      ),
    );
    yield* TestClock.adjust("200 millis");
    yield* Fiber.interrupt(b!);
    yield* TestClock.adjust("300 millis");

    assert.deepStrictEqual(
      (yield* Fiber.join(a!)).map((pullRequest) => pullRequest.number),
      [2],
    );
    assert.deepStrictEqual(
      (yield* Fiber.join(c!)).map((pullRequest) => pullRequest.number),
      [1],
    );
    assert.strictEqual(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("fails a whole batch on a server error and answers the next batch", () => {
  let answered = 0;
  const listing = pullRequestListing([pullRequestOn("feature/a", 3)]);
  const { execute, layer } = makeLayer({
    response: (request) => {
      answered += 1;
      return answered === 1 ? new Response("Unavailable", { status: 503 }) : listing(request);
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const sweep = () =>
      lookUpTogether(
        ["feature/a", "feature/b"].map((branch) =>
          bitbucket.listPullRequests({ cwd: "/repo", headSelector: branch, state: "all" }),
        ),
      );

    for (const result of yield* sweep()) {
      assert.deepInclude(Result.getFailure(result).pipe(Option.getOrThrow), {
        _tag: "BitbucketResponseError",
        status: 503,
      });
    }
    const [a, b] = yield* sweep();
    assert.deepStrictEqual(
      Result.getOrThrow(a!).map((pullRequest) => pullRequest.number),
      [3],
    );
    assert.deepStrictEqual(Result.getOrThrow(b!), []);
    assert.strictEqual(execute.mock.calls.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("never batches interactive lookups with background ones", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json({ values: [] }) });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const lookup = (branch: string) =>
      bitbucket.listPullRequests({ cwd: "/repo", headSelector: branch, state: "all" });
    yield* lookUpTogether([
      lookup("feature/a"),
      lookup("feature/b").pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),
      lookup("feature/c"),
      lookup("feature/d").pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),
    ]);

    assert.deepStrictEqual(
      execute.mock.calls.map(([request]) => queriedBranches(request).join(",")).toSorted(),
      ["feature/a,feature/c", "feature/b,feature/d"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("never batches lookups made with different credential scopes", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json({ values: [] }) });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const lookup = (branch: string, scope: string) =>
      bitbucket
        .listPullRequests({ cwd: "/repo", headSelector: branch, state: "all" })
        .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, scope));
    yield* lookUpTogether([
      lookup("feature/a", "project-one"),
      lookup("feature/b", "project-two"),
      lookup("feature/c", "project-one"),
    ]);

    assert.deepStrictEqual(
      execute.mock.calls.map(([request]) => queriedBranches(request).join(",")).toSorted(),
      ["feature/a,feature/c", "feature/b"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "fails every batched lookup as rate limited and sends nothing until the pause ends",
  () => {
    let answered = 0;
    const { execute, layer } = makeLayer({
      response: () => {
        answered += 1;
        return answered === 1
          ? new Response("Rate limit exceeded", {
              status: 429,
              headers: { "retry-after": "60", "x-ratelimit-limit": "1000" },
            })
          : Response.json({ values: [] });
      },
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const sweep = () =>
        lookUpTogether(
          ["feature/a", "feature/b", "feature/c"].map((branch) =>
            bitbucket.listPullRequests({ cwd: "/repo", headSelector: branch, state: "all" }),
          ),
        );

      const limited = yield* sweep();
      assert.strictEqual(execute.mock.calls.length, 1);
      for (const result of limited) {
        assert.isTrue(Result.isFailure(result));
        const error = Result.getFailure(result).pipe(Option.getOrThrow);
        assert.deepInclude(error, {
          _tag: "BitbucketResponseError",
          operation: "listPullRequests",
          status: 429,
          retryAt: 60_500,
          rateLimit: 1000,
        });
        assert.strictEqual(
          error.message,
          "Bitbucket API failed in listPullRequests: Bitbucket's API rate limit was reached (HTTP 429); requests resume at 1970-01-01T00:01:00.500Z.",
        );
      }

      const paused = yield* sweep();
      for (const result of paused) {
        assert.strictEqual(
          Result.getFailure(result).pipe(Option.getOrThrow)._tag,
          "SourceControlRateLimitPausedError",
        );
      }
      assert.strictEqual(execute.mock.calls.length, 1);

      yield* TestClock.adjust("58 seconds");
      assert.isTrue((yield* sweep()).every(Result.isFailure));
      assert.strictEqual(execute.mock.calls.length, 1);

      yield* TestClock.adjust("1 second");
      assert.isTrue((yield* sweep()).every(Result.isSuccess));
      assert.strictEqual(execute.mock.calls.length, 2);
    }).pipe(Effect.provide(layer));
  },
);
