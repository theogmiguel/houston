import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { IssueTemplateList } from "@houston-app/contracts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@houston-app/source-control-core/server/SourceControlRateLimit";
import * as GitHubIssueTracker from "./GitHubIssueTracker.ts";

const DETAIL_RESPONSE = JSON.stringify({
  data: {
    viewer: { login: "mona" },
    repository: {
      viewerPermission: "TRIAGE",
      issue: {
        __typename: "Issue",
        number: 42,
        title: "Composer loses focus",
        url: "https://github.com/acme/web/issues/42",
        author: {
          __typename: "User",
          login: "octocat",
          avatarUrl: "https://avatars/octocat",
          name: "Octo Cat",
        },
        state: "CLOSED",
        stateReason: "DUPLICATE",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-03T00:00:00Z",
        closedAt: "2026-07-03T00:00:00Z",
        comments: {
          totalCount: 3,
          pageInfo: { hasPreviousPage: true, startCursor: "Y3Vyc29y" },
          nodes: [
            {
              __typename: "IssueComment",
              id: "IC_1",
              author: { __typename: "User", login: "mona", avatarUrl: "https://avatars/mona" },
              body: "Repro attached.",
              createdAt: "2026-07-02T00:00:00Z",
              url: "https://github.com/acme/web/issues/42#issuecomment-1",
              reactionGroups: [
                {
                  content: "THUMBS_UP",
                  viewerHasReacted: true,
                  reactors: {
                    totalCount: 2,
                    nodes: [
                      { __typename: "User", login: "mona" },
                      { __typename: "User", login: "octavia" },
                    ],
                  },
                },
                {
                  content: "EYES",
                  viewerHasReacted: false,
                  reactors: { totalCount: 0, nodes: [] },
                },
              ],
            },
          ],
        },
        assignees: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ login: "octavia", name: null, avatarUrl: "https://avatars/mona" }],
        },
        labels: {
          pageInfo: { hasNextPage: true, endCursor: "labels-next" },
          nodes: [{ name: "bug", color: "d73a4a" }, null],
        },
        body: "Typing in the composer drops focus after a paste.",
        viewerCanUpdate: false,
        viewerCanClose: false,
        viewerCanReopen: true,
        reactionGroups: [],
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 50,
              title: "fix(web): keep composer focus",
              url: "https://github.com/acme/web/pull/50",
              state: "MERGED",
              isDraft: false,
              repository: { nameWithOwner: "acme/web" },
            },
          ],
        },
        timelineItems: {
          nodes: [
            {
              __typename: "LabeledEvent",
              id: "LE_1",
              createdAt: "2026-07-01T01:00:00Z",
              actor: { __typename: "User", login: "octavia", avatarUrl: "https://avatars/octavia" },
              label: { name: "bug" },
            },
            {
              __typename: "CrossReferencedEvent",
              id: "CRE_1",
              createdAt: "2026-07-02T01:00:00Z",
              actor: { __typename: "User", login: "mona", avatarUrl: "https://avatars/mona" },
              source: {
                __typename: "PullRequest",
                number: 50,
                title: "fix(web): keep composer focus",
                url: "https://github.com/acme/web/pull/50",
                state: "MERGED",
                isDraft: false,
                repository: { nameWithOwner: "acme/web" },
              },
            },
            { __typename: "MentionedEvent", id: "ME_1", createdAt: "2026-07-02T02:00:00Z" },
            {
              __typename: "ClosedEvent",
              id: "CE_1",
              createdAt: "2026-07-03T00:00:00Z",
              actor: null,
            },
          ],
        },
      },
    },
  },
});

const decodeVariables = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);

function transport(httpClient: HttpClient.HttpClient) {
  return GitHubRest.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        GitHubQuota.layer,
        SourceControlRateLimit.layer,
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          saved: () => Effect.succeedNone,
          get: (host) =>
            Effect.succeed({
              host,
              token: Redacted.make("test-token"),
              source: "gh" as const,
              fingerprint: "test",
            }),
        }),
        Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
          enabled: false,
          token: () => Effect.succeedNone,
          invalidate: () => Effect.void,
        }),
        Layer.succeed(HttpClient.HttpClient, httpClient),
      ),
    ),
  );
}

function tracker(onRequest: (variables: unknown) => void, templateRepository?: unknown) {
  return GitHubIssueTracker.make.pipe(
    Effect.provide(
      transport(
        HttpClient.make((request) => {
          if (request.body._tag !== "Uint8Array")
            return Effect.die("Expected a GraphQL JSON request.");
          const { query, variables } = decodeVariables(new TextDecoder().decode(request.body.body));
          const statusRead = /query IssueStatuses\b/.test(query);
          if (!statusRead) onRequest(variables);
          const body = statusRead
            ? JSON.stringify({
                data: {
                  repository: {
                    planningStatuses: null,
                    issue: { viewerCanSetStatus: false, status: null },
                  },
                },
              })
            : templateRepository !== undefined
              ? JSON.stringify({ data: { repository: templateRepository } })
              : "labelsCursor" in variables
                ? JSON.stringify({
                    data: {
                      repository: {
                        issue: {
                          labels: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            nodes: [{ name: "needs repro", color: "ffffff" }],
                          },
                          assignees: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            nodes: [],
                          },
                        },
                      },
                    },
                  })
                : DETAIL_RESPONSE;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body, {
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        }),
      ),
    ),
  );
}

const encodeTemplateList = Schema.encodeSync(IssueTemplateList);

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

describe("GitHubIssueTracker", () => {
  it.effect("writes an issue lifecycle without mutating pull requests or foreign comments", () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      let issueState: { state: string; stateReason: string | null } = {
        state: "OPEN",
        stateReason: null,
      };
      const http = HttpClient.make((request) => {
        if (request.body._tag !== "Uint8Array") return Effect.die("Expected a JSON request.");
        const text = new TextDecoder().decode(request.body.body);
        let response: unknown = {};
        if (request.url === "https://api.github.com/graphql") {
          const { query, variables } = decodeVariables(text);
          expect(request.method).toBe("POST");
          const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
          if (operation === "IssueStatuses") {
            response = {
              data: {
                repository: {
                  planningStatuses: null,
                  issue: { viewerCanSetStatus: false, status: null },
                },
              },
            };
          } else if (operation === "IssueNodeId" || operation === "IssueCommentScope") {
            expect(variables).toMatchObject({ owner: "acme", name: "web" });
            response = {
              data: {
                repository: {
                  issue: variables["number"] === 42 ? { id: "I_42", ...issueState } : null,
                },
                ...(operation === "IssueCommentScope"
                  ? { node: { __typename: "IssueComment", issue: { id: "I_other" } } }
                  : {}),
              },
            };
          } else {
            expect(["AddReaction", "RemoveReaction"]).toContain(operation);
            expect(variables).toEqual({ subjectId: "I_42", content: "THUMBS_UP" });
            writes.push(operation);
            response = {
              data: {
                [operation === "AddReaction" ? "addReaction" : "removeReaction"]: {
                  reaction: { content: "THUMBS_UP" },
                },
              },
            };
          }
        } else {
          const body = decodeBody(text);
          writes.push([request.method, request.url, body]);
          if (typeof body["state"] === "string") {
            issueState = {
              state: body["state"].toUpperCase(),
              stateReason:
                typeof body["state_reason"] === "string"
                  ? body["state_reason"].toUpperCase()
                  : null,
            };
          }
          if (request.url.endsWith("/issues")) {
            response = { number: 42, html_url: "https://github.com/acme/web/issues/42" };
          }
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(response), {
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      });
      const api = yield* GitHubIssueTracker.make.pipe(Effect.provide(transport(http)));
      const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      expect(
        yield* api.create({
          ...target,
          title: "Fixture",
          body: "Body",
          labels: ["bug"],
          assignees: ["octocat"],
        }),
      ).toEqual({
        key: "42",
        displayKey: "#42",
        url: "https://github.com/acme/web/issues/42",
      });
      yield* api.comment({ ...target, body: "Comment" });
      yield* api.update({ ...target, title: "Updated", body: "Edited", labels: [], assignees: [] });
      expect(yield* Effect.flip(api.setState({ ...target, state: "closed" }))).toMatchObject({
        operation: "setState",
        reason: "failed",
      });
      yield* api.setState({ ...target, state: "Not planned" });
      // GitHub ignores a new reason on a closed issue, so it is refused instead of sent.
      expect(
        yield* api.setState({ ...target, state: "Completed" }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { operation: "setState", reason: "failed" } });
      yield* api.setState({ ...target, state: "Open" });
      yield* api.setState({ ...target, state: "Duplicate" });
      yield* api.setState({ ...target, state: "Open" });
      yield* api.setReaction({ ...target, content: "thumbs-up", reacted: true });
      yield* api.setReaction({ ...target, content: "thumbs-up", reacted: false });

      const pullRequest = { ...target, key: "50" };
      expect(
        yield* api.update({ ...pullRequest, title: "Do not edit" }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { operation: "update", reason: "not-found" } });
      expect(
        yield* api.setState({ ...pullRequest, state: "Completed" }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { operation: "setState", reason: "not-found" },
      });
      expect(
        yield* api.comment({ ...pullRequest, body: "Do not comment" }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { operation: "comment", reason: "not-found" } });
      expect(
        yield* Effect.flip(
          api.setReaction({
            ...target,
            subjectId: "IC_other",
            content: "thumbs-up",
            reacted: true,
          }),
        ),
      ).toMatchObject({ operation: "setReaction", reason: "failed" });

      expect(writes).toEqual([
        [
          "POST",
          "https://api.github.com/repos/acme/web/issues",
          { title: "Fixture", body: "Body", labels: ["bug"], assignees: ["octocat"] },
        ],
        ["POST", "https://api.github.com/repos/acme/web/issues/42/comments", { body: "Comment" }],
        [
          "PATCH",
          "https://api.github.com/repos/acme/web/issues/42",
          { title: "Updated", body: "Edited", labels: [], assignees: [] },
        ],
        [
          "PATCH",
          "https://api.github.com/repos/acme/web/issues/42",
          { state: "closed", state_reason: "not_planned" },
        ],
        ["PATCH", "https://api.github.com/repos/acme/web/issues/42", { state: "open" }],
        [
          "PATCH",
          "https://api.github.com/repos/acme/web/issues/42",
          { state: "closed", state_reason: "duplicate" },
        ],
        ["PATCH", "https://api.github.com/repos/acme/web/issues/42", { state: "open" }],
        "AddReaction",
        "RemoveReaction",
      ]);
    }),
  );

  it.effect("asks search for the labels, assignee and order a listing names", () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const api = yield* tracker((variables) => seen.push(variables));
      // The canned answer is not a search result; only the query sent matters here.
      yield* api
        .listIssues({
          cwd: "/w",
          host: "github.com",
          scope: "acme/web",
          state: "open",
          involvement: "all",
          viewer: "mona",
          labels: ['needs "repro"'],
          assignee: "octavia",
          sort: "created",
          limit: 10,
        })
        .pipe(Effect.exit);
      expect(seen[0]).toMatchObject({
        q: 'is:issue repo:acme/web is:open label:"needs \\"repro\\"" assignee:"octavia" sort:created-desc',
      });
    }),
  );

  it.effect("offers YAML issue forms when blank issues are disabled", () =>
    Effect.gen(function* () {
      const form = {
        __typename: "Blob",
        isTruncated: false,
        text: `name: Bug report
description: Report broken behavior.
title: "[Bug]: "
labels: [bug, needs-triage]
assignees: "octocat, octavia"
body:
  - type: markdown
    attributes:
      value: Search existing issues first.
  - type: checkboxes
    attributes:
      label: Before submitting
      options:
        - label: I searched existing issues.
          required: true
  - type: dropdown
    attributes:
      label: Area
      description: Which part is affected?
      options: [Web, Server]
      default: 1
    validations:
      required: true
  - type: textarea
    attributes:
      label: Steps to reproduce
      placeholder: Start the app.
  - type: input
    attributes:
      label: Version
      value: main
  - type: upload
    attributes:
      label: Supporting files
      description: Redact secrets before uploading.
`,
      };
      const config = {
        __typename: "Blob",
        isTruncated: false,
        text: '"blank_issues_enabled": false # use a template',
      };
      const repository = {
        issueTemplates: [],
        templateDirectory: {
          __typename: "Tree",
          entries: [
            { name: "config.yml", object: config },
            { name: "bug_report.yml", object: form },
            {
              name: "empty_name.yml",
              object: { ...form, text: 'name: ""\ndescription: Empty name\nbody: []' },
            },
            {
              name: "blank_name.yml",
              object: { ...form, text: 'name: "   "\ndescription: Blank name\nbody: []' },
            },
            {
              name: "invalid.yml",
              object: { ...form, text: "name: Missing required metadata\nbody: []" },
            },
          ],
        },
      };
      const api = yield* tracker(() => {}, repository);
      const input = { cwd: "/w", host: "github.com", scope: "acme/web" };
      const result = yield* api.listTemplates!(input);
      expect(encodeTemplateList(result)).toEqual(result);
      expect(result.blankIssuesEnabled).toBe(false);
      expect(result.templates).toHaveLength(1);
      expect(result.templates[0]).toMatchObject({
        key: "bug_report.yml",
        name: "Bug report",
        about: "Report broken behavior.",
        title: "[Bug]: ",
        labels: ["bug", "needs-triage"],
        assignees: ["octocat", "octavia"],
      });
      expect(result.templates[0]?.body).toBe(`Search existing issues first.

### Before submitting

- [ ] I searched existing issues. (required)

### Area

Which part is affected?

Required.

Choose one:

- Web
- Server (default)

### Steps to reproduce

Example:
> Start the app.

### Version

main

### Supporting files

Redact secrets before uploading.`);
      config.isTruncated = true;
      expect(yield* Effect.flip(api.listTemplates!(input))).toMatchObject({
        reason: "failed",
        detail: "GitHub returned incomplete issue template contents.",
      });
    }),
  );

  it.effect("maps a detail read to the neutral issue shape", () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const api = yield* tracker((variables) => {
        seen.push(variables);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        key: "42",
      });
      expect(seen).toEqual([
        { owner: "acme", name: "web", number: 42 },
        {
          owner: "acme",
          name: "web",
          number: 42,
          labelsCursor: "labels-next",
          assigneesCursor: null,
        },
      ]);
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        title: "Composer loses focus",
        body: "Typing in the composer drops focus after a paste.",
        state: { category: "closed", name: "Duplicate", closeReason: "duplicate" },
        states: [
          { category: "open", name: "Open" },
          { category: "closed", name: "Completed", closeReason: "completed" },
          { category: "closed", name: "Not planned", closeReason: "not-planned" },
          { category: "closed", name: "Duplicate", closeReason: "duplicate" },
        ],
        author: {
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://avatars/octocat",
        },
        assignees: [{ login: "octavia" }],
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "needs repro", color: "ffffff" },
        ],
        commentCount: 3,
        viewer: "mona",
        // Triage may label, assign, close and reopen; `viewerCanUpdate: false` withholds edits.
        viewerPermissions: {
          setState: true,
          edit: false,
          labels: true,
          assignees: true,
          comment: true,
        },
        commentsCursor: "Y3Vyc29y",
      });
      // The viewer is left out of `actors` and shown as "You"; an empty group is dropped.
      expect(issue.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 2, actors: ["octavia"], viewerHasReacted: true },
      ]);
      // The closing reference wins over the cross-reference sighting of the same pull request.
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "acme/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://github.com/acme/web/pull/50",
          state: "merged",
          isDraft: false,
          closesIssue: true,
        },
      ]);
      // An event kind this page has no vocabulary for is dropped rather than guessed at.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["referenced", "acme/web#50"],
        ["closed", null],
      ]);
    }),
  );
  describe("issue statuses", () => {
    interface StatusRow {
      readonly id: string;
      readonly name: string;
      readonly category: {
        readonly key: string;
        readonly state: "OPEN" | "CLOSED";
        readonly stateReason: string | null;
      };
    }
    const status = (
      id: string,
      name: string,
      key: string,
      state: "OPEN" | "CLOSED",
      stateReason: string | null = null,
    ): StatusRow => ({ id, name, category: { key, state, stateReason } });
    const BACKLOG = status("PS_backlog", "Backlog", "backlog", "OPEN");
    const IN_REVIEW = status("PS_review", "In review", "started", "OPEN");
    const DONE = status("PS_done", "Done", "completed", "CLOSED", "COMPLETED");
    const NOT_PLANNED_STATUS = status(
      "PS_np",
      "Not planned",
      "not_planned",
      "CLOSED",
      "NOT_PLANNED",
    );
    const DUPLICATE_STATUS = status("PS_dup", "Duplicate", "duplicate", "CLOSED", "DUPLICATE");
    const REPOSITORY_STATUSES = [BACKLOG, IN_REVIEW, DONE, NOT_PLANNED_STATUS, DUPLICATE_STATUS];

    interface Seen {
      readonly operation: string;
      readonly host: string;
      readonly query: string;
      readonly variables: Record<string, unknown>;
    }

    const searchNode = (
      number: number,
      state: string,
      statusRow: StatusRow | null,
      withStatus = false,
    ) => ({
      __typename: "Issue",
      number,
      title: `Issue ${number}`,
      url: `https://github.com/acme/web/issues/${number}`,
      state,
      stateReason: state === "CLOSED" ? "COMPLETED" : null,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      closedAt: state === "CLOSED" ? "2026-07-02T00:00:00Z" : null,
      author: null,
      assignees: { nodes: [] },
      labels: { nodes: [] },
      comments: { totalCount: 0 },
      ...(statusRow === null && !withStatus ? {} : { status: statusRow }),
    });

    /** A fake GitHub keyed on the GraphQL operation name; REST writes are recorded as such. */
    function fixture(
      host: string,
      answer: (operation: string, variables: Record<string, unknown>) => unknown,
    ) {
      const seen: Seen[] = [];
      const rest: Array<readonly [string, string, unknown]> = [];
      const http = HttpClient.make((request) => {
        if (request.body._tag !== "Uint8Array") return Effect.die("Expected a JSON request.");
        const text = new TextDecoder().decode(request.body.body);
        let payload: unknown = {};
        if (request.url.endsWith("/graphql")) {
          const { query, variables } = decodeVariables(text);
          const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "";
          seen.push({ operation, host, query, variables });
          payload = answer(operation, variables);
        } else {
          rest.push([request.method, request.url, decodeBody(text)]);
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(payload), {
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      });
      return { seen, rest, http };
    }

    const COLLECTIONS = {
      repository: {
        issue: {
          labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          assignees: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    };
    const target = (host: string) => ({ cwd: "/w", host, scope: "acme/web", key: "42" });
    const listInput = (host: string) => ({
      cwd: "/w",
      host,
      scope: "acme/web",
      state: "all" as const,
      involvement: "all" as const,
      viewer: "mona",
      sort: "updated" as const,
      limit: 10,
    });

    it.effect("lists each issue under its status, open or closed by the status category", () =>
      Effect.gen(function* () {
        const { seen, http } = fixture("github.com", (operation) => ({
          data:
            operation === "IssueSearchWithStatus"
              ? {
                  search: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      searchNode(1, "OPEN", IN_REVIEW),
                      searchNode(2, "CLOSED", DONE),
                      searchNode(3, "OPEN", null, true),
                    ],
                  },
                }
              : {},
        }));
        const api = yield* GitHubIssueTracker.make.pipe(Effect.provide(transport(http)));
        const page = yield* api.listIssues(listInput("github.com"));

        expect(seen.map((entry) => entry.operation)).toEqual(["IssueSearchWithStatus"]);
        expect(page.items.map((item) => item.state)).toEqual([
          { category: "open", name: "In review" },
          { category: "closed", name: "Done", closeReason: "completed" },
          { category: "open", name: "Open" },
        ]);
      }),
    );

    it.effect("reads the repository's statuses in order and the viewer's right to set one", () =>
      Effect.gen(function* () {
        const { http } = fixture("github.com", (operation, variables) => ({
          data:
            "labelsCursor" in variables
              ? COLLECTIONS
              : operation === "IssueStatuses"
                ? {
                    repository: {
                      planningStatuses: { nodes: REPOSITORY_STATUSES },
                      issue: { viewerCanSetStatus: true, status: IN_REVIEW },
                    },
                  }
                : JSON.parse(DETAIL_RESPONSE).data,
        }));
        const api = yield* GitHubIssueTracker.make.pipe(Effect.provide(transport(http)));
        const issue = yield* api.getIssue(target("github.com"));

        expect(issue.state).toEqual({ category: "open", name: "In review" });
        expect(issue.states).toEqual([
          { category: "open", name: "Backlog" },
          { category: "open", name: "In review" },
          { category: "closed", name: "Done", closeReason: "completed" },
          { category: "closed", name: "Not planned", closeReason: "not-planned" },
          { category: "closed", name: "Duplicate", closeReason: "duplicate" },
        ]);
        // The canned issue is closed and not reopenable; only the status right allows a move.
        expect(issue.viewerPermissions.setState).toBe(true);
      }),
    );

    it.effect("keeps the four states and never names a status on another host", () =>
      Effect.gen(function* () {
        const host = "ghe.example.com";
        const { seen, rest, http } = fixture(host, (operation, variables) => ({
          data:
            operation === "IssueSearch"
              ? {
                  search: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [searchNode(1, "OPEN", null)],
                  },
                }
              : operation === "IssueNodeId"
                ? { repository: { issue: { id: "I_42", state: "OPEN", stateReason: null } } }
                : "labelsCursor" in variables
                  ? COLLECTIONS
                  : JSON.parse(DETAIL_RESPONSE).data,
        }));
        const api = yield* GitHubIssueTracker.make.pipe(Effect.provide(transport(http)));

        const page = yield* api.listIssues(listInput(host));
        const issue = yield* api.getIssue(target(host)).pipe(Effect.exit);
        yield* api.setState({ ...target(host), state: "Not planned" });

        expect(page.items[0]?.state).toEqual({ category: "open", name: "Open" });
        expect(issue._tag).toBe("Success");
        if (issue._tag === "Success") {
          expect(issue.value.states.map((state) => state.name)).toEqual([
            "Open",
            "Completed",
            "Not planned",
            "Duplicate",
          ]);
        }
        expect(seen.length).toBeGreaterThan(0);
        for (const entry of seen) {
          expect(entry.query, entry.operation).not.toMatch(
            /planningStatus|PlanningStatus|viewerCanSetStatus|setIssueStatus|\bstatus\b/,
          );
        }
        expect(rest).toEqual([
          [
            "PATCH",
            `https://${host}/api/v3/repos/acme/web/issues/42`,
            { state: "closed", state_reason: "not_planned" },
          ],
        ]);
      }),
    );

    it.effect("moves an issue to a status that keeps it open without closing it", () =>
      Effect.gen(function* () {
        let current: StatusRow = BACKLOG;
        const { seen, rest, http } = fixture("github.com", (operation, variables) => {
          if (operation === "SetIssueStatus") {
            current =
              REPOSITORY_STATUSES.find((row) => row.id === variables["statusId"]) ?? current;
            return { data: { setIssueStatus: { clientMutationId: null } } };
          }
          if (operation === "IssueNodeId") {
            return {
              data: { repository: { issue: { id: "I_42", state: "OPEN", stateReason: null } } },
            };
          }
          return {
            data: {
              repository: {
                planningStatuses: { nodes: REPOSITORY_STATUSES },
                issue: { viewerCanSetStatus: true, status: current },
              },
            },
          };
        });
        const api = yield* GitHubIssueTracker.make.pipe(Effect.provide(transport(http)));

        yield* api.setState({ ...target("github.com"), state: "In review" });

        const mutation = seen.find((entry) => entry.operation === "SetIssueStatus");
        expect(mutation?.variables).toEqual({ issueId: "I_42", statusId: "PS_review" });
        expect(rest).toEqual([]);
        expect(current.category.state).toBe("OPEN");
      }),
    );

    it.effect("closes as a duplicate over REST because the mutation needs the original issue", () =>
      Effect.gen(function* () {
        const { seen, rest, http } = fixture("github.com", (operation) => ({
          data:
            operation === "IssueNodeId"
              ? { repository: { issue: { id: "I_42", state: "OPEN", stateReason: null } } }
              : {
                  repository: {
                    planningStatuses: { nodes: REPOSITORY_STATUSES },
                    issue: { viewerCanSetStatus: true, status: BACKLOG },
                  },
                },
        }));
        const api = yield* GitHubIssueTracker.make.pipe(Effect.provide(transport(http)));

        yield* api.setState({ ...target("github.com"), state: "Duplicate" });

        expect(seen.some((entry) => entry.operation === "SetIssueStatus")).toBe(false);
        expect(rest).toEqual([
          [
            "PATCH",
            "https://api.github.com/repos/acme/web/issues/42",
            { state: "closed", state_reason: "duplicate" },
          ],
        ]);
      }),
    );

    it.effect("refuses a status name the repository lacks, naming it and the valid ones", () =>
      Effect.gen(function* () {
        const { seen, rest, http } = fixture("github.com", (operation) => ({
          data:
            operation === "IssueNodeId"
              ? { repository: { issue: { id: "I_42", state: "OPEN", stateReason: null } } }
              : {
                  repository: {
                    planningStatuses: { nodes: REPOSITORY_STATUSES },
                    issue: { viewerCanSetStatus: true, status: BACKLOG },
                  },
                },
        }));
        const api = yield* GitHubIssueTracker.make.pipe(Effect.provide(transport(http)));

        const error = yield* Effect.flip(
          api.setState({ ...target("github.com"), state: "Shipped" }),
        );

        expect(error).toMatchObject({ operation: "setState", reason: "failed" });
        expect(error.detail).toContain('"Shipped"');
        for (const row of REPOSITORY_STATUSES) expect(error.detail).toContain(`"${row.name}"`);
        expect(seen.some((entry) => entry.operation === "SetIssueStatus")).toBe(false);
        expect(rest).toEqual([]);
      }),
    );

    it.effect("falls back to the plain search when GitHub refuses the status fields", () =>
      Effect.gen(function* () {
        const { seen, http } = fixture("github.com", (operation) =>
          operation === "IssueSearchWithStatus"
            ? { errors: [{ message: "Field 'status' doesn't exist on type 'Issue'" }] }
            : {
                data: {
                  search: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [searchNode(1, "OPEN", null)],
                  },
                },
              },
        );
        const api = yield* GitHubIssueTracker.make.pipe(Effect.provide(transport(http)));

        const page = yield* api.listIssues(listInput("github.com"));

        expect(seen.map((entry) => entry.operation)).toEqual([
          "IssueSearchWithStatus",
          "IssueSearch",
        ]);
        expect(page.items[0]?.state).toEqual({ category: "open", name: "Open" });
      }),
    );
  });
});
