// GitHub issue reads through upstream's GitHubRest against an in-process fake of api.github.com.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { EMPTY_GITHUB_CURSOR, pollGitHub } from "./GitHubSource.ts";
import { storedSettings, type GithubCursor } from "./rules.ts";
import {
  GITHUB_SETTINGS_TOKEN,
  githubIssue,
  layerGitHubFake,
  makeGithubFake,
  type GithubFake,
} from "./taskSources.testkit.ts";

const settings = storedSettings({
  enabled: true,
  githubRepository: "octo-org/project",
  githubLabel: "import",
});

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => githubIssue(from + index));

/** Pages with fixed ETags; a page answers 304 to its own ETag. */
const servePages = (fake: GithubFake, pages: Array<{ etag: string; issues: Array<unknown> }>) => {
  fake.respond = (url, request) => {
    const page = Number(url.searchParams.get("page"));
    const entry = pages[page - 1] ?? { etag: '"none"', issues: [] };
    if (request.ifNoneMatch === entry.etag)
      return new Response(null, { status: 304, headers: { etag: entry.etag } });
    return new Response(JSON.stringify(entry.issues), {
      status: 200,
      headers: { "content-type": "application/json", etag: entry.etag },
    });
  };
};

const paths = (fake: GithubFake) =>
  fake.requests.map((request) => {
    const url = new URL(request.url);
    return `${url.host}${url.pathname}${url.search} ${request.ifNoneMatch ?? "-"}`;
  });

describe("issue pages revalidate with etags and refetch a partial change", () => {
  it.effect("issue pages revalidate with etags and refetch a partial change", () => {
    const fake = makeGithubFake();
    return Effect.gen(function* () {
      const pages = [
        { etag: '"p1"', issues: range(1, 100) },
        { etag: '"p2"', issues: range(101, 30) },
      ];
      servePages(fake, pages);
      const first = yield* pollGitHub(settings, EMPTY_GITHUB_CURSOR);
      assert.deepEqual(paths(fake), [
        "api.github.com/repos/octo-org/project/issues?state=all&per_page=100&page=1 -",
        "api.github.com/repos/octo-org/project/issues?state=all&per_page=100&page=2 -",
      ]);
      assert.strictEqual(first.records.length, 130);
      assert.isFalse(first.notModified);

      // Every page unchanged: each is revalidated with its ETag and nothing is imported.
      fake.requests.length = 0;
      const unchanged = yield* pollGitHub(settings, first.cursor);
      assert.deepEqual(paths(fake), [
        'api.github.com/repos/octo-org/project/issues?state=all&per_page=100&page=1 "p1"',
        'api.github.com/repos/octo-org/project/issues?state=all&per_page=100&page=2 "p2"',
      ]);
      assert.isTrue(unchanged.notModified);
      assert.deepEqual(unchanged.records, []);
      assert.deepEqual(unchanged.cursor, first.cursor);

      // Page 1 unchanged, page 2 changed: every page is read again without ETags (the strong case).
      pages[1] = { etag: '"p2b"', issues: range(101, 31) };
      fake.requests.length = 0;
      const partial = yield* pollGitHub(settings, first.cursor);
      assert.deepEqual(paths(fake), [
        'api.github.com/repos/octo-org/project/issues?state=all&per_page=100&page=1 "p1"',
        'api.github.com/repos/octo-org/project/issues?state=all&per_page=100&page=2 "p2"',
        "api.github.com/repos/octo-org/project/issues?state=all&per_page=100&page=1 -",
        "api.github.com/repos/octo-org/project/issues?state=all&per_page=100&page=2 -",
      ]);
      assert.strictEqual(partial.records.length, 131);
      assert.isTrue(partial.records.some((record) => record.externalId === "octo-org/project#1"));
      assert.deepEqual((partial.cursor as GithubCursor).pages["2"], { etag: '"p2b"', count: 31 });

      // A changed filter drops the stored ETags.
      fake.requests.length = 0;
      yield* pollGitHub({ ...settings, githubLabel: "other" }, partial.cursor);
      assert.isTrue(fake.requests.every((request) => request.ifNoneMatch === undefined));
    }).pipe(Effect.provide(layerGitHubFake(fake)));
  });
});

describe("more than 20 pages is refused by name", () => {
  it.effect("more than 20 pages is refused by name", () => {
    const fake = makeGithubFake();
    return Effect.gen(function* () {
      servePages(
        fake,
        Array.from({ length: 21 }, (_, index) => ({
          etag: `"p${index}"`,
          issues: range(index * 100 + 1, 100),
        })),
      );
      const error = yield* Effect.flip(pollGitHub(settings, EMPTY_GITHUB_CURSOR));
      assert.include(error, "20-page bound");
      assert.strictEqual(fake.requests.length, 20);
    }).pipe(Effect.provide(layerGitHubFake(fake)));
  });
});

describe("github reads use upstream's credential", () => {
  it.effect("github reads use upstream's credential", () => {
    const fake = makeGithubFake();
    return Effect.gen(function* () {
      servePages(fake, [{ etag: '"p1"', issues: range(1, 2) }]);
      yield* pollGitHub(settings, EMPTY_GITHUB_CURSOR);
      assert.deepEqual(
        fake.requests.map((request) => [new URL(request.url).host, request.authorization]),
        [["api.github.com", `Bearer ${GITHUB_SETTINGS_TOKEN}`]],
      );
    }).pipe(Effect.provide(layerGitHubFake(fake)));
  });
});
