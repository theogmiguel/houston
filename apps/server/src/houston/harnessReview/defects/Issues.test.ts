// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - real git origins; GitHub's reset time.
// Issue drafts and filing against an in-process fake of api.github.com that records every request.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";

import {
  HoustonDefectIssues,
  HoustonDefects,
  HoustonHarnessService,
  NOW,
  createProject,
  makeKit,
  runKit,
  sql,
  type Kit,
  type KitServices,
} from "../harnessReview.testkit.ts";

const TIMEOUT = 180_000;
const issues = HoustonDefectIssues.HoustonDefectIssues;
const defects = HoustonDefects.HoustonDefects;
const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ012345";

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit), "expected a refusal");
  return Cause.squash((exit as Exit.Failure<A, E>).cause) as {
    readonly kind?: string;
    readonly message?: string;
  };
};

const git = (root: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });

/** A project folder that is a git repository, with `origin` at `url` when given. */
const repositoryProject = (name: string, origin?: string) =>
  Effect.gen(function* () {
    const project = yield* createProject(name);
    git(project.root, ["init", "--quiet"]);
    if (origin !== undefined) git(project.root, ["remote", "add", "origin", origin]);
    return project;
  });

const report = (
  projectId: ProjectId,
  title: string,
  destination: "houston" | "project" = "houston",
  extra: { readonly description?: string; readonly evidence?: ReadonlyArray<string> } = {},
) =>
  Effect.flatMap(defects, (store) =>
    store.report({
      projectId,
      threadId: ThreadId.make("thread-reporter"),
      title,
      destination,
      ...extra,
    }),
  );

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const searchAnswer = (count: number) =>
  json({
    total_count: count,
    items: Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      title: index === 0 ? `leaked ${TOKEN}` : `issue ${index + 1}`,
      html_url: `https://github.com/theogmiguel/houston/issues/${index + 1}`,
    })),
  });

const withIssues = <A, E>(
  name: string,
  body: (kit: Kit) => Effect.Effect<A, E, KitServices | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const kit = yield* makeKit(name, { reactor: false });
    return yield* runKit(kit, body(kit));
  });

describe("drafts", () => {
  it.effect(
    "a draft makes one search and redacts the issue text",
    () =>
      withIssues("issue-draft", (kit) =>
        Effect.gen(function* () {
          const { projectId } = yield* repositoryProject("issue-draft");
          kit.github.respond = () => searchAnswer(12);
          const { key } = yield* report(projectId, "worker re-asked the same question", "houston", {
            description: `asked twice with GITHUB_TOKEN=${TOKEN}`,
            evidence: ["message 5425 asked again"],
          });
          const draft = yield* (yield* issues).draft({ projectId, key });
          assert.strictEqual(draft.destination, "houston");
          assert.strictEqual(draft.repository, "theogmiguel/houston");
          assert.strictEqual(draft.credential?.source, "settings");
          assert.strictEqual(draft.title, "fix(harness): worker re-asked the same question");
          assert.include(draft.body, "asked twice with GITHUB_TOKEN=<redacted>");
          assert.notInclude(draft.body, TOKEN);
          assert.include(draft.body, "- message 5425 asked again");
          assert.include(
            draft.body,
            "Reported by an agent thread through `houston_defect_report`.",
          );
          const minute = `${NOW.slice(0, 10)} ${NOW.slice(11, 16)} UTC`;
          assert.include(draft.body, `first seen ${minute}`);
          assert.include(draft.body, `last seen ${minute}`);
          assert.include(draft.body, "Seen 1 time");
          assert.include(draft.transmits, "github.com/theogmiguel/houston");
          assert.include(draft.transmits, "worker re-asked same question");
          assert.include(draft.transmits, "Settings");

          assert.lengthOf(kit.github.requests, 1, "exactly one GitHub request");
          const [request] = kit.github.requests;
          const url = new URL(request!.url);
          assert.strictEqual(request!.method, "GET");
          assert.strictEqual(url.host, "api.github.com");
          assert.strictEqual(url.pathname, "/search/issues");
          assert.strictEqual(
            url.searchParams.get("q"),
            "repo:theogmiguel/houston is:issue is:open worker re-asked same question",
          );
          assert.lengthOf(draft.duplicates, 10);
          assert.notInclude(JSON.stringify(draft.duplicates), TOKEN);
          assert.strictEqual(draft.duplicates[0]?.title, "leaked <redacted>");
          assert.isNull(draft.note);

          // No evidence and an already conventional title.
          const bare = yield* report(projectId, "fix(defects): x");
          const plain = yield* (yield* issues).draft({ projectId, key: bare.key });
          assert.strictEqual(plain.title, "fix(defects): x");
          assert.include(plain.body, "- none recorded");

          // A project defect goes to the project's github.com origin.
          const { projectId: own } = yield* repositoryProject(
            "issue-draft-own",
            "git@github.com:acme/widgets.git",
          );
          const projectDefect = yield* report(own, "widget build is flaky", "project");
          const sent = kit.github.requests.length;
          const ownDraft = yield* (yield* issues).draft({ projectId: own, key: projectDefect.key });
          assert.strictEqual(ownDraft.repository, "acme/widgets");
          assert.strictEqual(kit.github.requests.length, sent + 1);
          assert.include(
            new URL(kit.github.requests.at(-1)!.url).searchParams.get("q") ?? "",
            "repo:acme/widgets is:issue is:open",
          );
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "a failed or rate limited search leaves the draft usable",
    () =>
      Effect.gen(function* () {
        const reset = Date.parse(NOW) / 1000 + 3600;
        yield* withIssues("issue-rate-limited", (kit) =>
          Effect.gen(function* () {
            const { projectId } = yield* repositoryProject("issue-rate-limited");
            kit.github.respond = () =>
              json({ message: "API rate limit exceeded" }, 403, {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(reset),
              });
            const { key } = yield* report(projectId, "worker re-asked the same question");
            const draft = yield* (yield* issues).draft({ projectId, key });
            assert.lengthOf(draft.duplicates, 0);
            assert.include(draft.note ?? "", "rate limit");
            assert.include(draft.note ?? "", new Date(reset * 1000).toISOString());
            assert.strictEqual(draft.title, "fix(harness): worker re-asked the same question");
            assert.include(draft.body, "## Evidence");
          }),
        );
        yield* withIssues("issue-search-failed", (kit) =>
          Effect.gen(function* () {
            const { projectId } = yield* repositoryProject("issue-search-failed");
            kit.github.respond = () => json({ message: "Server Error" }, 500);
            const { key } = yield* report(projectId, "worker re-asked the same question");
            const draft = yield* (yield* issues).draft({ projectId, key });
            assert.lengthOf(draft.duplicates, 0);
            assert.include(draft.note ?? "", "did not run");
            assert.include(draft.note ?? "", "500");
            assert.strictEqual(draft.title, "fix(harness): worker re-asked the same question");
            assert.include(draft.body, "## Evidence");
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "a project remote off github.com is refused before any request",
    () =>
      withIssues("issue-off-github", (kit) =>
        Effect.gen(function* () {
          const { projectId: gitlab } = yield* repositoryProject(
            "issue-gitlab",
            "https://gitlab.com/acme/widgets.git",
          );
          const { projectId: bare } = yield* repositoryProject("issue-no-origin");
          const service = yield* issues;
          const cases = [
            [gitlab, "gitlab.com"],
            [bare, "no origin remote"],
          ] as const;
          for (const [projectId, names] of cases) {
            const { key } = yield* report(projectId, "widget build is flaky", "project");
            const drafted = failureOf(yield* Effect.exit(service.draft({ projectId, key })));
            const filed = failureOf(
              yield* Effect.exit(
                service.file({
                  projectId,
                  key,
                  title: "fix(harness): widget build is flaky",
                  body: "body",
                  repository: "acme/widgets",
                }),
              ),
            );
            for (const refusal of [drafted, filed]) {
              assert.strictEqual(refusal.kind, "unsupported", names);
              assert.include(refusal.message ?? "", names);
              assert.include(refusal.message ?? "", "filing issues supports github.com only");
            }
          }
          assert.lengthOf(kit.github.requests, 0, "no GitHub request");
        }),
      ),
    TIMEOUT,
  );
});

describe("filing", () => {
  it.effect(
    "filing redacts again and creates one issue or comment",
    () =>
      withIssues("issue-file", (kit) =>
        Effect.gen(function* () {
          const { projectId } = yield* repositoryProject("issue-file");
          const service = yield* issues;
          const harness = yield* HoustonHarnessService.HoustonHarnessService;
          const database = yield* sql;
          const stateOf = (key: string) =>
            Effect.map(harness.get({ projectId }), (snapshot) =>
              snapshot.defects.find((defect) => defect.key === key),
            );
          const { key } = yield* report(projectId, "worker re-asked the same question");
          const base = {
            projectId,
            key,
            title: "fix(harness): worker re-asked the same question",
            body: "It asked twice. GITHUB_TOKEN=x",
            repository: "theogmiguel/houston",
          };

          // Refusals: repository shape and identity, bounds; nothing is sent.
          const refusals: ReadonlyArray<readonly [string, typeof base, ReadonlyArray<string>]> = [
            ["another repository", { ...base, repository: "other/repo" }, ["other/repo"]],
            ["not owner/name", { ...base, repository: "theogmiguel" }, ["owner/name"]],
            ["empty title", { ...base, title: "" }, ["title", "256"]],
            ["257-character title", { ...base, title: "t".repeat(257) }, ["257", "256"]],
            ["60,001-character body", { ...base, body: "b".repeat(60_001) }, ["60001", "60000"]],
          ];
          for (const [label, input, parts] of refusals) {
            const refused = failureOf(yield* Effect.exit(service.file(input)));
            assert.strictEqual(refused.kind, "invalid", label);
            for (const part of parts) assert.include(refused.message ?? "", part, label);
          }
          assert.lengthOf(kit.github.requests, 0);

          // GitHub refusing: remote with its message, and the defect stays undecided.
          kit.github.respond = () =>
            json({ message: "Validation Failed", errors: ["title is too spammy"] }, 422);
          const remote = failureOf(yield* Effect.exit(service.file(base)));
          assert.strictEqual(remote.kind, "remote");
          assert.include(remote.message ?? "", "title is too spammy");
          assert.strictEqual((yield* stateOf(key))?.state, "open");
          assert.isNull((yield* stateOf(key))?.issueUrl ?? null);

          // A new issue: one POST, redacted again.
          kit.github.requests.length = 0;
          kit.github.respond = () =>
            json({ number: 41, html_url: "https://github.com/theogmiguel/houston/issues/41" }, 201);
          // The edited title carries a token and the home path; both go before it is sent.
          const home = NodeOS.homedir();
          const title = `fix(harness): push failed with ${TOKEN} in ${NodePath.join(home, "notes.txt")}`;
          const filed = yield* service.file({ ...base, title, repository: "TheogMiguel/Houston" });
          assert.strictEqual(filed.number, 41);
          assert.strictEqual(filed.url, "https://github.com/theogmiguel/houston/issues/41");
          assert.lengthOf(kit.github.requests, 1);
          const [create] = kit.github.requests;
          assert.strictEqual(create!.method, "POST");
          assert.strictEqual(new URL(create!.url).pathname, "/repos/theogmiguel/houston/issues");
          const sent = create!.body as { readonly title: string; readonly body: string };
          assert.strictEqual(
            sent.title,
            `fix(harness): push failed with <redacted> in ~${NodePath.sep}notes.txt`,
          );
          assert.notInclude(sent.title, TOKEN);
          assert.notInclude(sent.title, home);
          assert.include(sent.body, "GITHUB_TOKEN=<redacted>");
          assert.notInclude(sent.body, "GITHUB_TOKEN=x");
          const after = yield* stateOf(key);
          assert.strictEqual(after?.issueUrl, filed.url);
          assert.strictEqual(after?.state, "resolved");
          assert.deepEqual(
            yield* database`SELECT decided_by FROM houston_harness_decisions WHERE key = ${key}`,
            [{ decided_by: "filed" }],
          );

          // A comment on #12 instead: one POST to its comments.
          const second = yield* report(projectId, "the same question again later");
          kit.github.requests.length = 0;
          kit.github.respond = () =>
            json(
              { html_url: "https://github.com/theogmiguel/houston/issues/12#issuecomment-7" },
              201,
            );
          const commented = yield* service.file({
            ...base,
            key: second.key,
            commentOn: 12,
          });
          assert.strictEqual(commented.number, 12);
          assert.lengthOf(kit.github.requests, 1);
          assert.strictEqual(kit.github.requests[0]!.method, "POST");
          assert.strictEqual(
            new URL(kit.github.requests[0]!.url).pathname,
            "/repos/theogmiguel/houston/issues/12/comments",
          );
          assert.include(
            (kit.github.requests[0]!.body as { readonly body: string }).body,
            "GITHUB_TOKEN=<redacted>",
          );
          assert.strictEqual((yield* stateOf(second.key))?.state, "resolved");
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "a filed defect is not filed again and a double submit opens one issue",
    () =>
      withIssues("issue-file-once", (kit) =>
        Effect.gen(function* () {
          const { projectId } = yield* repositoryProject("issue-file-once");
          const service = yield* issues;
          const { key } = yield* report(projectId, "worker re-asked the same question");
          const input = {
            projectId,
            key,
            title: "fix(harness): worker re-asked the same question",
            body: "It asked twice.",
            repository: "theogmiguel/houston",
          };
          let next = 50;
          kit.github.respond = () => {
            next += 1;
            return json(
              { number: next, html_url: `https://github.com/theogmiguel/houston/issues/${next}` },
              201,
            );
          };

          const both = yield* Effect.all(
            [Effect.exit(service.file(input)), Effect.exit(service.file(input))],
            { concurrency: 2 },
          );
          assert.lengthOf(kit.github.requests, 1, "a double submit sends one create");
          assert.lengthOf(both.filter(Exit.isSuccess), 1);
          const refused = failureOf(both.find(Exit.isFailure)!);
          assert.strictEqual(refused.kind, "conflict");

          const again = failureOf(yield* Effect.exit(service.file(input)));
          assert.strictEqual(again.kind, "conflict");
          assert.include(again.message ?? "", "https://github.com/theogmiguel/houston/issues/51");
          assert.lengthOf(kit.github.requests, 1, "a filed defect sends nothing more");

          // A comment on an existing issue is still allowed.
          yield* service.file({ ...input, commentOn: 7 });
          assert.lengthOf(kit.github.requests, 2);
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "nothing reaches github but the search and the explicit file",
    () =>
      withIssues("issue-nothing-else", (kit) =>
        Effect.gen(function* () {
          const { projectId } = yield* repositoryProject("issue-nothing-else");
          const harness = yield* HoustonHarnessService.HoustonHarnessService;
          const store = yield* defects;
          const { key } = yield* report(projectId, "worker re-asked the same question");
          yield* store.decide({ projectId, key, decision: "dismiss" });
          yield* store.decide({ projectId, key, decision: "reopen" });
          yield* harness.get({ projectId });
          yield* harness.overview({});
          assert.lengthOf(kit.github.requests, 0, "recording, deciding and listing send nothing");

          kit.github.respond = () => searchAnswer(1);
          yield* (yield* issues).draft({ projectId, key });
          // The user closes the draft: nothing to call, nothing sent.
          yield* harness.get({ projectId });
          assert.lengthOf(kit.github.requests, 1, "the draft's one search");

          kit.github.respond = () =>
            json({ number: 3, html_url: "https://github.com/theogmiguel/houston/issues/3" }, 201);
          yield* (yield* issues).file({
            projectId,
            key,
            title: "fix(harness): worker re-asked the same question",
            body: "body",
            repository: "theogmiguel/houston",
          });
          assert.lengthOf(kit.github.requests, 2, "the file's one create");
        }),
      ),
    TIMEOUT,
  );
});
