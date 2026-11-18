import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import { IssueTrackerKind } from "@houston-app/contracts";
import type { StandaloneIssueTrackerApi } from "@houston-app/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@houston-app/source-control-core/server/IssueTrackerHost";

import * as LinearApi from "./LinearApi.ts";
import * as LinearIssueTracker from "./LinearIssueTracker.ts";

const user = (id: string, displayName: string) => ({
  id,
  name: displayName,
  displayName,
  email: `${displayName}@acme.test`,
  avatarUrl: null,
});
const ADA = user("usr_ada", "ada");
const GRACE = user("usr_grace", "grace");

const state = (name: string, type: string, position = 0) => ({
  id: `st_${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  type,
  position,
});

const issue = (
  identifier: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: `iss_${identifier}`,
  identifier,
  number: Number(identifier.split("-")[1]),
  title: `Issue ${identifier}`,
  url: `https://linear.app/acme/issue/${identifier}`,
  description: "body",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  state: state("In Progress", "started"),
  // The detail query also asks for the team's workflow; a listing ignores it.
  team: {
    key: identifier.split("-")[0],
    states: {
      nodes: [
        state("Canceled", "canceled", 4),
        state("Done", "completed", 3),
        state("In Progress", "started", 2),
        state("Todo", "unstarted", 1),
      ],
    },
  },
  creator: ADA,
  assignee: GRACE,
  labels: { nodes: [{ id: "lbl_bug", name: "Bug", color: "#f00" }] },
  ...overrides,
});

/** An issue as the detail query answers it, with nothing hanging off it. */
const bareDetail = (identifier: string) =>
  issue(identifier, {
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reactions: [],
    attachments: { nodes: [] },
    history: { nodes: [] },
  });

/** Answers each GraphQL document by its operation name, the way Linear would. */
function fakeLinear(
  answers: Record<string, (variables: Record<string, unknown>) => unknown>,
  stored: string | null = "lin_api_stored",
) {
  const requests: Array<{
    readonly authorization: string | undefined;
    readonly operation: string;
  }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body;
        const text =
          body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : String(body._tag);
        const parsed = JSON.parse(text) as { query: string; variables: Record<string, unknown> };
        const operation = /^(?:query|mutation) (\w+)/.exec(parsed.query)?.[1] ?? "?";
        requests.push({ authorization: request.headers.authorization, operation });
        const answer = answers[operation];
        const response =
          answer === undefined
            ? new Response(
                JSON.stringify({ errors: [{ message: `No answer for ${operation}` }] }),
                {
                  status: 400,
                  headers: { "content-type": "application/json" },
                },
              )
            : new Response(JSON.stringify({ data: answer(parsed.variables) }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: { get: () => Effect.succeed(Option.fromNullishOr(stored)) },
    }),
  );
  // Every optional write is implemented here; the type says so for the calls below.
  const tracker = LinearIssueTracker.make.pipe(
    Effect.map((api) => api as Required<StandaloneIssueTrackerApi>),
    Effect.provide(LinearApi.layer.pipe(Layer.provide(Layer.merge(http, host)))),
  );
  return { tracker, requests };
}

const target = { cwd: "/w/web", host: "linear.app", scope: "ENG" };

describe("LinearIssueTracker", () => {
  it.effect("parses Linear issue links with their workspace and team", () =>
    Effect.gen(function* () {
      const api = yield* fakeLinear({}).tracker;
      for (const suffix of ["", "/issue-title", "/old-title?view=all#comment"]) {
        expect(api.parseIssueUrl(new URL(`https://linear.app/acme/issue/ENG-1${suffix}`))).toEqual({
          host: "linear.app",
          workspace: "acme",
          scope: "ENG",
          key: "ENG-1",
        });
      }
      expect(
        api.parseIssueUrl(new URL("https://linear.app/other-workspace/issue/ENG-1")),
      ).toMatchObject({
        workspace: "other-workspace",
        key: "ENG-1",
      });
      for (const url of [
        "http://linear.app/acme/issue/ENG-1",
        "https://example.com/acme/issue/ENG-1",
        "https://linear.app.example.com/acme/issue/ENG-1",
        "https://linear.app:444/acme/issue/ENG-1",
        "https://linear.app/acme/team/ENG-1",
        "https://linear.app//issue/ENG-1",
        "https://linear.app/acme/issue/",
        "https://linear.app/acme/issue/ENG-0",
        "https://linear.app/acme/issue/eng-1",
        "https://linear.app/acme/issue/ENG-1extra",
      ]) {
        expect(api.parseIssueUrl(new URL(url)), url).toBeNull();
      }
    }),
  );

  it.effect("lists a team's issues as summaries keyed by identifier", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeLinear({
        HoustonViewer: () => ({ viewer: ADA, teams: { nodes: [] } }),
        HoustonIssues: (variables) => {
          expect(variables.filter).toMatchObject({
            team: { key: { eq: "ENG" } },
            state: { type: { nin: ["completed", "canceled", "duplicate"] } },
            assignee: { displayName: { eq: "ada" } },
          });
          expect(variables.orderBy).toBe("updatedAt");
          return {
            issues: {
              nodes: [
                issue("ENG-2", {
                  state: state("Done", "completed"),
                  completedAt: "2026-07-03T00:00:00.000Z",
                }),
                issue("ENG-1"),
              ],
              pageInfo: { hasNextPage: true, endCursor: "cur_2" },
            },
          };
        },
      });
      const api = yield* tracker;
      expect(api.kind).toBe(IssueTrackerKind.make("linear"));
      expect(api.standalone).toMatchObject({ host: "linear.app", scopeNoun: "team" });

      const page = yield* api.listIssues({
        ...target,
        state: "open",
        involvement: "assigned",
        viewer: "ada",
        sort: "updated",
        limit: 50,
      });
      expect(page.nextCursor).toBe("cur_2");
      expect(page.items.map((item) => [item.key, item.displayKey, item.state])).toEqual([
        ["ENG-2", "ENG-2", { category: "closed", name: "Done", closeReason: "completed" }],
        ["ENG-1", "ENG-1", { category: "open", name: "In Progress" }],
      ]);
      expect(page.items[0]).toMatchObject({
        closedAt: "2026-07-03T00:00:00.000Z",
        author: { login: "ada", name: "ada" },
        assignees: [{ login: "grace", name: "grace" }],
        labels: [{ name: "Bug", color: "#f00" }],
      });
      // The stored key goes in as-is, not as a bearer token.
      expect(requests.map((request) => request.authorization)).toEqual(["lin_api_stored"]);
    }),
  );

  it.effect("narrows a listing by labels and assignee and asks for its order", () =>
    Effect.gen(function* () {
      let sent: Record<string, unknown> = {};
      const { tracker } = fakeLinear({
        HoustonViewer: () => ({ viewer: ADA, teams: { nodes: [] } }),
        HoustonIssues: (variables) => {
          sent = variables;
          return {
            issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          };
        },
      });
      const api = yield* tracker;
      yield* api.listIssues({
        ...target,
        state: "open",
        involvement: "assigned",
        viewer: "ada",
        labels: ["Bug", "Needs triage"],
        assignee: "grace",
        sort: "created",
        limit: 50,
      });
      // Each narrows without replacing "assigned to me", which stays its own clause.
      expect(sent.filter).toMatchObject({
        assignee: { displayName: { eq: "ada" } },
        and: [
          { assignee: { displayName: { eq: "grace" } } },
          { labels: { some: { name: { eq: "Bug" } } } },
          { labels: { some: { name: { eq: "Needs triage" } } } },
        ],
      });
      expect(sent.orderBy).toBe("createdAt");
    }),
  );

  it.effect("reads an issue with its comments, reactions, history and linked pull requests", () =>
    Effect.gen(function* () {
      const { tracker } = fakeLinear({
        HoustonViewer: () => ({ viewer: ADA, teams: { nodes: [] } }),
        HoustonIssue: () => ({
          issue: issue("ENG-7", {
            comments: {
              nodes: [
                {
                  id: "cmt_1",
                  body: "hi",
                  createdAt: "2026-07-02T01:00:00.000Z",
                  url: "https://linear.app/acme/issue/ENG-7#comment-cmt_1",
                  user: GRACE,
                  reactions: [{ id: "r1", emoji: "👍", user: ADA }],
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cmt_cur" },
            },
            reactions: [
              { id: "r2", emoji: "🚀", user: GRACE },
              { id: "r3", emoji: "🚀", user: ADA },
              { id: "r4", emoji: "🤷", user: GRACE },
            ],
            attachments: {
              nodes: [
                {
                  url: "https://github.com/acme/web/pull/12",
                  title: "Fix it",
                  sourceType: "github",
                  metadata: { status: "merged" },
                },
                { url: "https://example.test/doc", title: "Doc", sourceType: null, metadata: {} },
              ],
            },
            history: {
              nodes: [
                {
                  id: "h1",
                  createdAt: "2026-07-01T01:00:00.000Z",
                  actor: GRACE,
                  fromState: state("Todo", "unstarted"),
                  toState: state("Done", "completed"),
                  fromAssignee: null,
                  toAssignee: ADA,
                  addedLabels: [{ id: "lbl_bug", name: "Bug", color: "#f00" }],
                  removedLabels: null,
                  fromTitle: null,
                  toTitle: null,
                },
              ],
            },
          }),
        }),
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "eng-7" });
      expect(detail.viewer).toBe("ada");
      // The team's own workflow, in Linear's order, with the category each state falls in.
      expect(detail.states.map((entry) => [entry.name, entry.category])).toEqual([
        ["Todo", "open"],
        ["In Progress", "open"],
        ["Done", "closed"],
        ["Canceled", "closed"],
      ]);
      expect(detail.commentsCursor).toBe("cmt_cur");
      expect(detail.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      ]);
      // Grouped per emoji, the viewer left out of the names; an emoji outside the vocabulary is dropped.
      expect(detail.reactions).toEqual([
        { content: "rocket", count: 2, actors: ["grace"], viewerHasReacted: true },
      ]);
      expect(detail.events.map((event) => [event.kind, event.detail])).toEqual([
        ["closed", "Done"],
        ["labeled", "Bug"],
        ["assigned", "ada"],
      ]);
      expect(detail.linkedPullRequests).toEqual([
        expect.objectContaining({ repository: "acme/web", number: 12, state: "merged" }),
      ]);

      const missing = yield* Effect.flip(api.getIssue({ ...target, key: "123" }));
      expect(missing.reason).toBe("not-found");
    }),
  );

  it.effect("moves an issue to one of its team's states, without a key or outside the team", () =>
    Effect.gen(function* () {
      const updates: Array<Record<string, unknown>> = [];
      const { tracker } = fakeLinear(
        {
          HoustonTeam: () => ({
            teams: {
              nodes: [
                {
                  id: "team_eng",
                  key: "ENG",
                  name: "Engineering",
                  states: {
                    nodes: [
                      state("Canceled", "canceled", 3),
                      state("Done", "completed", 2),
                      state("Todo", "unstarted", 1),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  templates: { nodes: [] },
                },
              ],
            },
            issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          }),
          HoustonIssueUpdate: (variables) => {
            updates.push(variables);
            return { issueUpdate: { success: true } };
          },
        },
        null,
      );
      const api = yield* tracker;
      const unauthenticated = yield* Effect.flip(
        api.setState({ ...target, key: "ENG-1", state: "Done" }),
      );
      expect(unauthenticated.reason).toBe("unauthenticated");

      const connected = fakeLinear({
        HoustonTeam: () => ({
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                states: {
                  nodes: [
                    state("Canceled", "canceled", 3),
                    state("Done", "completed", 2),
                    state("Todo", "unstarted", 1),
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                templates: { nodes: [] },
              },
            ],
          },
          issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        HoustonIssue: (variables) => ({ issue: bareDetail(String(variables.id)) }),
        HoustonIssueUpdate: (variables) => {
          updates.push(variables);
          return { issueUpdate: { success: true } };
        },
      });
      const live = yield* connected.tracker;
      // An identifier from another team resolves in Linear, so the team is checked before writing.
      const foreign = yield* Effect.flip(live.setState({ ...target, key: "OPS-3", state: "Done" }));
      expect(foreign.detail).toContain("OPS");
      // A move names one of the team's own states; nothing is asked for as "open" or "closed".
      yield* live.setState({ ...target, key: "ENG-1", state: "Canceled" });
      yield* live.setState({ ...target, key: "ENG-1", state: "Todo" });
      const unknown = yield* Effect.flip(
        live.setState({ ...target, key: "ENG-1", state: "closed" }),
      );
      expect(unknown.detail).toContain('no "closed" state');
      expect(updates.map((update) => update.input)).toEqual([
        { stateId: "st_canceled" },
        { stateId: "st_todo" },
      ]);
    }),
  );

  it("offers plain templates as drafts and form or rich ones as links into Linear", () => {
    const labels = new Map([["lbl_bug", "Bug"]]);
    const plain = LinearIssueTracker.toTemplate(
      {
        id: "tpl_1",
        name: "Bug report",
        description: "For bugs",
        content: "## Steps",
        type: "issue",
        hasFormFields: false,
        templateData: { title: "Bug: ", labelIds: ["lbl_bug", "lbl_unknown"], assigneeId: null },
      },
      "ENG",
      labels,
    );
    expect(plain).toEqual({
      template: {
        key: "tpl_1",
        name: "Bug report",
        about: "For bugs",
        title: "Bug: ",
        body: "## Steps",
        labels: ["Bug"],
        assignees: [],
      },
    });
    const form = LinearIssueTracker.toTemplate(
      {
        id: "tpl_2",
        name: "Intake",
        description: null,
        content: null,
        type: "issue",
        hasFormFields: true,
        templateData: {},
      },
      "ENG",
      labels,
    );
    expect(form).toEqual({
      link: { name: "Intake", about: "", url: "https://linear.app/team/ENG/new?template=tpl_2" },
    });
  });
});
