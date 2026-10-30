// Reads a repository's issues through upstream's GitHub client: the credential it resolves for
// github.com, page ETags so unchanged pages cost no rate limit, and its quota and pause rules.
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import type * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  GITHUB_MAX_PAGES,
  GITHUB_PAGE_SIZE,
  githubMatches,
  githubRecord,
  parseRepository,
  quote,
  githubCursorFits,
  type GithubCursor,
  type RemoteRecord,
  type StoredSettings,
} from "./rules.ts";

const HOST = "github.com";

/** How long one page may take; tests shorten it to prove a stalled answer is named. */
export const GitHubRequestTimeout = Context.Reference<Duration.Duration>(
  "houston/houston/taskSources/GitHubSource/GitHubRequestTimeout",
  { defaultValue: () => Duration.seconds(30) },
);

export const EMPTY_GITHUB_CURSOR: GithubCursor = {
  repository: null,
  label: null,
  assignedUser: null,
  pages: {},
};

export interface GithubPoll {
  readonly records: ReadonlyArray<RemoteRecord>;
  readonly cursor: GithubCursor;
  readonly notModified: boolean;
}

/** A failed read, named by its operation and the answer GitHub gave. */
export const describeGitHubError = (
  operation: string,
  error: GitHubRequestPolicy.GitHubApiError,
  timeout: Duration.Duration = Duration.seconds(30),
) => {
  switch (error._tag) {
    case "GitHubApiAuthenticationError":
      return `${operation} failed with HTTP 401: GitHub refused the credential for ${HOST}`;
    case "GitHubApiRateLimitError":
      return `${operation} failed: GitHub rate limit exceeded (HTTP 403 or 429)${
        error.retryAt === undefined
          ? ""
          : `; it resets at ${DateTime.formatIso(DateTime.makeUnsafe(error.retryAt))}`
      }`;
    case "GitHubApiNotFoundError":
      return `${operation} failed with HTTP 404: the repository does not exist or the credential cannot see it`;
    case "GitHubApiResponseError":
      return `${operation} failed with HTTP ${error.status}: ${error.message}`;
    case "GitHubApiRequestError":
      return Cause.isTimeoutError(error.cause)
        ? `${operation} failed: no response within ${Duration.toSeconds(timeout)} seconds`
        : `${operation} failed: ${error.message}`;
    case "SourceControlRateLimitPausedError":
      return `${operation} failed: GitHub requests are paused after a rate limit until ${DateTime.formatIso(DateTime.makeUnsafe(error.retryAt))}`;
    default:
      return `${operation} failed: ${error.message}`;
  }
};

interface Pages {
  readonly issues: Array<unknown>;
  readonly pages: Record<string, { readonly etag: string | null; readonly count: number }>;
  changed: boolean;
  sawNotModified: boolean;
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Polls every issue of the configured repository; the caller keeps the cursor. */
export const pollGitHub = Effect.fn("HoustonTaskSources.pollGitHub")(function* (
  settings: StoredSettings,
  cursor: GithubCursor,
) {
  const api = yield* GitHubRest.GitHubRest;
  const timeout = yield* GitHubRequestTimeout;
  const repository = parseRepository(settings.githubRepository ?? "");
  if (repository === null) {
    return yield* Effect.fail(
      `GitHub repository ${quote(settings.githubRepository ?? "")} is not owner/name`,
    );
  }

  const readPages = Effect.fnUntraced(function* (conditional: boolean) {
    const result: Pages = { issues: [], pages: {}, changed: false, sawNotModified: false };
    for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
      const path = `repos/${repository}/issues?state=all&per_page=${GITHUB_PAGE_SIZE}&page=${page}`;
      const operation = `GitHub issue poll of ${repository} page ${page}`;
      const prior = conditional ? cursor.pages[String(page)] : undefined;
      const response = yield* api
        .rest({
          host: HOST,
          operation: "houstonTaskSourcesIssues",
          path,
          timeout,
          ...(prior?.etag == null ? {} : { ifNoneMatch: prior.etag }),
        })
        .pipe(Effect.mapError((error) => describeGitHubError(operation, error, timeout)));
      if (response.status === 304) {
        if (prior === undefined) {
          return yield* Effect.fail(`${operation} answered 304 without a stored page`);
        }
        result.sawNotModified = true;
        result.pages[String(page)] = {
          etag: response.headers.etag ?? prior.etag,
          count: prior.count,
        };
        if (prior.count < GITHUB_PAGE_SIZE) return result;
        continue;
      }
      if (response.truncated)
        return yield* Effect.fail(`${operation} answered more than the response bound`);
      const parsed = yield* decodeJson(response.body).pipe(
        Effect.mapError(() => `${operation} answered invalid JSON`),
      );
      if (!Array.isArray(parsed)) return yield* Effect.fail(`${operation} did not answer a list`);
      result.changed = true;
      result.pages[String(page)] = { etag: response.headers.etag ?? null, count: parsed.length };
      result.issues.push(...parsed);
      if (parsed.length < GITHUB_PAGE_SIZE) return result;
    }
    return yield* Effect.fail(
      `GitHub issue poll of ${repository} exceeded the ${GITHUB_MAX_PAGES}-page bound`,
    );
  });

  const next = (pages: Pages["pages"]): GithubCursor => ({
    repository: settings.githubRepository,
    label: settings.githubLabel,
    assignedUser: settings.githubAssignedUser,
    pages,
  });

  const first = yield* readPages(githubCursorFits(cursor, settings));
  if (!first.changed) {
    return { records: [], cursor: next(first.pages), notModified: true } satisfies GithubPoll;
  }
  // A changed page beside unchanged ones is not the whole list, so read every page again.
  const read = first.sawNotModified ? yield* readPages(false) : first;
  const records = read.issues
    .filter((issue) => githubMatches(issue, settings))
    .flatMap((issue) => {
      const record = githubRecord(issue, repository);
      return record === null ? [] : [record];
    });
  return { records, cursor: next(read.pages), notModified: false } satisfies GithubPoll;
});
