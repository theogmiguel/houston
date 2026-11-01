// @effect-diagnostics nodeBuiltinImport:off - issue text loses the user's home path before it leaves.
// A suspected defect as a GitHub issue, through upstream's client and the credential it resolves
// for github.com. A draft makes one duplicate search; only an explicit file creates or comments.
import * as NodeOS from "node:os";

import type { ProjectId } from "@t3tools/contracts";
import {
  HOUSTON_DEFECT_LIMITS,
  HOUSTON_DEFECT_REPOSITORY,
  HoustonHarnessError,
  type HoustonDefectCredential,
  type HoustonDefectDraftInput,
  type HoustonDefectFileInput,
  type HoustonDefectFileResult,
  type HoustonDefectIssueDraft,
  type HoustonDefectIssueMatch,
} from "@t3tools/contracts/houston/harnessReview";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as NightShiftGit from "../../nightShift/Git.ts";
import { describeGitHubError } from "../../taskSources/GitHubSource.ts";
import { HoustonHarnessStore } from "../Store.ts";
import { HoustonDefects } from "./Defects.ts";
import { redact } from "./redact.ts";
import {
  GITHUB_ONLY,
  githubRepositoryOf,
  issueBody,
  issueTitle,
  parseRepository,
  searchWords,
} from "./rules.ts";

const HOST = "github.com";

const CREDENTIAL_LABELS: Record<string, string> = {
  settings: "the account of the token saved in Settings ▸ Source Control",
  app: "the account signed in to the Houston GitHub app",
  env: "the account of GH_TOKEN",
  gh: "your gh login",
};

const SearchAnswer = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ number: Schema.Number, title: Schema.String, html_url: Schema.String }),
  ),
});
const decodeSearch = Schema.decodeUnknownOption(Schema.fromJsonString(SearchAnswer));
const decodeCreated = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ number: Schema.optional(Schema.Number), html_url: Schema.String }),
  ),
);

export class HoustonDefectIssues extends Context.Service<
  HoustonDefectIssues,
  {
    readonly draft: (
      input: HoustonDefectDraftInput,
    ) => Effect.Effect<HoustonDefectIssueDraft, HoustonHarnessError>;
    readonly file: (
      input: HoustonDefectFileInput,
    ) => Effect.Effect<HoustonDefectFileResult, HoustonHarnessError>;
  }
>()("houston/houston/harnessReview/defects/Issues/HoustonDefectIssues") {}

const refuse = (kind: HoustonHarnessError["kind"], operation: string, message: string) =>
  new HoustonHarnessError({ kind, operation, message });

const make = Effect.gen(function* () {
  const store = yield* HoustonHarnessStore;
  const defects = yield* HoustonDefects;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const github = yield* GitHubRest.GitHubRest;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const git = yield* NightShiftGit.NightShiftGit;

  const projectOf = (operation: string, projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.orDie,
      Effect.flatMap((row) =>
        Option.isSome(row) && row.value.deletedAt === null
          ? Effect.succeed(row.value)
          : Effect.fail(refuse("not_found", operation, `project ${projectId} does not exist`)),
      ),
    );

  /** The defect, its project root and the repository it files into, before any GitHub request. */
  const target = Effect.fn("HoustonDefectIssues.target")(function* (
    operation: string,
    projectId: ProjectId,
    key: string,
  ) {
    const project = yield* projectOf(operation, projectId);
    const defect = yield* defects.row(projectId, key);
    if (defect.destination === "houston") {
      return { defect, root: project.workspaceRoot, repository: HOUSTON_DEFECT_REPOSITORY };
    }
    const origin = yield* git.origin(project.workspaceRoot);
    if (origin.kind !== "origin") {
      return yield* refuse(
        "unsupported",
        operation,
        `project ${projectId} has no origin remote on github.com${origin.kind === "notRepository" ? " (its folder is not a git repository)" : ""}; ${GITHUB_ONLY}`,
      );
    }
    const repository = githubRepositoryOf(origin.url);
    if (repository === null) {
      return yield* refuse(
        "unsupported",
        operation,
        `project ${projectId}'s origin remote is on ${origin.host || "an unknown host"}, not github.com; ${GITHUB_ONLY}`,
      );
    }
    return { defect, root: project.workspaceRoot, repository };
  });

  // A Settings token outranks the app sign-in, which outranks GH_TOKEN and gh (GitHubRequestPolicy).
  const credential = Effect.gen(function* () {
    const held = yield* credentials.get(HOST);
    const found: HoustonDefectCredential = { source: held.source, account: null };
    if (found.source === "settings") return found;
    const app = yield* github.appCredential(HOST).pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(app) ? { source: "app", account: null } : found;
  }).pipe(Effect.orElseSucceed((): HoustonDefectCredential | null => null));

  const draft: HoustonDefectIssues["Service"]["draft"] = Effect.fn("HoustonDefectIssues.draft")(
    function* (input) {
      const operation = "defects.draft";
      const { defect, root, repository } = yield* target(operation, input.projectId, input.key);
      const clean = (text: string) => redact(text, root, NodeOS.homedir());
      const title = issueTitle(clean(defect.title), defect.detector ?? "harness");
      const body = clean(issueBody(defect));
      const words = searchWords(clean(defect.title));
      const held = yield* credential;
      const query = `repo:${repository} is:issue is:open ${words}`;
      const searched = yield* github
        .rest({
          host: HOST,
          operation: "houstonDefectsSearch",
          path: `search/issues?q=${encodeURIComponent(query)}&per_page=${HOUSTON_DEFECT_LIMITS.duplicates}`,
        })
        .pipe(Effect.result);
      let duplicates: ReadonlyArray<HoustonDefectIssueMatch> = [];
      let note: string | null = null;
      if (searched._tag === "Failure") {
        const error = searched.failure;
        if (
          error._tag === "GitHubApiRateLimitError" ||
          error._tag === "SourceControlRateLimitPausedError"
        ) {
          const reset =
            error.retryAt === undefined
              ? ""
              : `; it resets at ${DateTime.formatIso(DateTime.makeUnsafe(error.retryAt))}`;
          note = `GitHub rate limit reached, so the duplicate search did not run${reset}. No duplicates are listed, and the draft can still be filed.`;
        } else {
          note = `The duplicate search did not run: ${describeGitHubError("the duplicate search", error)}. No duplicates are listed, and the draft can still be filed.`;
        }
      } else {
        const answer = decodeSearch(searched.success.body);
        if (Option.isNone(answer)) {
          note = "The duplicate search answered in an unexpected shape; no duplicates are listed.";
        } else {
          duplicates = answer.value.items
            .filter((item) => Number.isInteger(item.number) && item.number > 0)
            .slice(0, HOUSTON_DEFECT_LIMITS.duplicates)
            .map((item) => ({ number: item.number, title: clean(item.title), url: item.html_url }));
        }
      }
      const as =
        held === null
          ? "no GitHub credential yet (sign in to github.com before filing)"
          : (held.account ?? CREDENTIAL_LABELS[held.source] ?? held.source);
      return {
        destination: defect.destination,
        repository,
        credential: held,
        title,
        body,
        transmits: `Creating this issue sends the title and body above to github.com/${repository} as ${as}. The duplicate search asked github.com/${repository} for open issues matching "${words}". Nothing else leaves this machine.`,
        duplicates,
        note,
      } satisfies HoustonDefectIssueDraft;
    },
  );

  const file: HoustonDefectIssues["Service"]["file"] = Effect.fn("HoustonDefectIssues.file")(
    function* (input) {
      const operation = "defects.file";
      const { root, repository: expected } = yield* target(operation, input.projectId, input.key);
      const repository = parseRepository(input.repository);
      if (repository === null) {
        return yield* refuse(
          "invalid",
          operation,
          `repository "${input.repository.slice(0, 200)}" is not owner/name; refusing to file the issue`,
        );
      }
      if (repository.toLowerCase() !== expected.toLowerCase()) {
        return yield* refuse(
          "invalid",
          operation,
          `repository "${repository}" is not this defect's repository "${expected}"; refusing to file the issue`,
        );
      }
      const clean = (text: string) => redact(text.trim(), root, NodeOS.homedir());
      const title = clean(input.title);
      const body = clean(input.body);
      const bound = (what: string, text: string, max: number) => {
        const length = Array.from(text).length;
        return length === 0 || length > max
          ? refuse("invalid", operation, `${what} has ${length} characters; expected 1 to ${max}`)
          : null;
      };
      const refused =
        bound("title", title, HOUSTON_DEFECT_LIMITS.issueTitleChars) ??
        bound("body", body, HOUSTON_DEFECT_LIMITS.issueBodyChars);
      if (refused !== null) return yield* refused;
      const sent = yield* github
        .rest(
          input.commentOn === undefined
            ? {
                host: HOST,
                operation: "houstonDefectsCreateIssue",
                method: "POST",
                path: `repos/${expected}/issues`,
                body: { title, body },
              }
            : {
                host: HOST,
                operation: "houstonDefectsComment",
                method: "POST",
                path: `repos/${expected}/issues/${input.commentOn}/comments`,
                body: { body },
              },
        )
        .pipe(
          Effect.mapError((error) =>
            refuse(
              "remote",
              operation,
              describeGitHubError(
                input.commentOn === undefined
                  ? `creating an issue in ${expected}`
                  : `commenting on ${expected}#${input.commentOn}`,
                error,
              ),
            ),
          ),
        );
      const created = decodeCreated(sent.body);
      if (Option.isNone(created)) {
        return yield* refuse(
          "remote",
          operation,
          `GitHub answered HTTP ${sent.status} without an issue URL`,
        );
      }
      const number =
        input.commentOn ??
        created.value.number ??
        Number(/\/issues\/(\d+)/.exec(created.value.html_url)?.[1] ?? 1);
      yield* store.defectFiled(input.projectId, input.key, created.value.html_url);
      return {
        number,
        url: created.value.html_url,
        note: input.commentOn === undefined ? null : `Commented on #${input.commentOn}`,
      };
    },
  );

  return HoustonDefectIssues.of({ draft, file });
});

export const layer = Layer.effect(HoustonDefectIssues, make).pipe(
  Layer.provide(NightShiftGit.layer),
);
