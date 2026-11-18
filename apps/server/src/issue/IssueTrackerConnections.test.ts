import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  IssueTrackerKind,
  type IssueTrackerProjectBinding,
  type ProjectId,
} from "@houston-app/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
  type TrackerIssueDetail,
} from "@houston-app/source-control-core/server/IssueTracker";

import * as HoustonSecrets from "../houston/secrets/HoustonSecrets.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as IssueTrackerConnections from "./IssueTrackerConnections.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const LINEAR = IssueTrackerKind.make("linear");
const SECRET_NAME = "issue-tracker-linear-token";
const GOOD = "lin_api_good";

function issue(key: string): TrackerIssueDetail {
  return {
    key,
    displayKey: key,
    title: `Issue ${key}`,
    url: `https://linear.app/acme/issue/${key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    body: "",
    viewer: null,
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    states: [
      { category: "open", name: "open" },
      { category: "closed", name: "closed" },
    ],
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
  };
}

function tracker(): StandaloneIssueTrackerApi {
  return {
    kind: LINEAR,
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: true,
      templates: true,
      linkedPullRequests: true,
      events: true,
      search: true,
    },
    standalone: {
      tracker: LINEAR,
      displayName: "Linear",
      host: "linear.app",
      scopeNoun: "team",
      credential: { label: "Personal API key", helpUrl: null },
    },
    parseIssueUrl: () => null,
    listProperties: (scope) =>
      scope === "ENG"
        ? Effect.succeed([
            { id: "title", name: "Name", type: "title", options: [] },
            { id: "status", name: "Status", type: "status", options: ["Todo", "Done"] },
          ])
        : Effect.fail(
            new IssueTrackerError({
              tracker: LINEAR,
              operation: "listProperties",
              reason: "not-found",
              detail: "No such team.",
            }),
          ),
    probeCredential: (token) =>
      token === GOOD
        ? Effect.succeed({ account: "ada", scopes: [{ key: "ENG", name: "Engineering" }] })
        : Effect.fail(
            new IssueTrackerError({
              tracker: LINEAR,
              operation: "probeCredential",
              reason: "unauthenticated",
              detail: "Linear rejected the API key.",
            }),
          ),
    getViewer: () => Effect.succeed("ada"),
    listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
    getIssue: (input) => Effect.succeed(issue(input.key)),
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
  };
}

function makeConnections(input: {
  readonly secrets: HoustonSecrets.MemorySecrets;
  readonly bindings?: ReadonlyMap<ProjectId, IssueTrackerProjectBinding>;
}) {
  const written: Array<{
    readonly projectId: ProjectId;
    readonly binding: IssueTrackerProjectBinding | null;
  }> = [];
  const removedTrackers: IssueTrackerKind[] = [];
  const layer = IssueTrackerConnections.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          IssueTrackerRegistry.IssueTrackerRegistry,
          IssueTrackerRegistry.fromTrackers([tracker()]),
        ),
        HoustonSecrets.layerMemory(input.secrets),
        Layer.succeed(
          IssueTrackerBindings.IssueTrackerBindingsRepository,
          IssueTrackerBindings.IssueTrackerBindingsRepository.of({
            list: Effect.succeed(new Map(input.bindings ?? [])),
            set: (write) =>
              Effect.sync(() => {
                written.push({ projectId: write.projectId, binding: write.binding });
              }),
            removeTracker: (trackerKind) =>
              Effect.sync(() => {
                removedTrackers.push(trackerKind);
              }),
            removeProject: () => Effect.void,
          }),
        ),
      ),
    ),
  );
  return {
    service: Effect.provide(IssueTrackerConnections.IssueTrackerConnections, layer),
    written,
    removedTrackers,
  };
}

describe("IssueTrackerConnections", () => {
  it.effect("stores an accepted key in the secret store and never returns it", () =>
    Effect.gen(function* () {
      const secrets = HoustonSecrets.makeMemory();
      const { service } = makeConnections({ secrets });
      const connections = yield* service;

      const connection = yield* connections.connect({ tracker: LINEAR, token: GOOD });
      expect(connection).toMatchObject({ connected: true, account: "ada" });
      expect(secrets.entries.get(SECRET_NAME)).toBe(GOOD);

      const listed = yield* connections.list;
      expect(listed.trackers[0]).toMatchObject({
        tracker: "linear",
        connected: true,
        account: "ada",
        scopes: [{ key: "ENG", name: "Engineering" }],
      });
      expect(JSON.stringify(listed)).not.toContain(GOOD);

      const rejected = yield* Effect.flip(connections.connect({ tracker: LINEAR, token: "bad" }));
      expect(rejected).toMatchObject({ reason: "rejected" });
      expect(secrets.entries.get(SECRET_NAME)).toBe(GOOD);
    }),
  );

  it.effect("refuses a key over the size bound and stores nothing", () =>
    Effect.gen(function* () {
      const secrets = HoustonSecrets.makeMemory();
      const { service } = makeConnections({ secrets });
      const connections = yield* service;

      const refused = yield* Effect.flip(
        connections.connect({ tracker: LINEAR, token: "x".repeat(4_097) }),
      );
      expect(refused.reason).toBe("rejected");
      expect(refused.detail).toContain("4097");
      expect(refused.detail).toContain("4096");
      expect(secrets.entries.size).toBe(0);
      expect(secrets.calls.filter((call) => call.op === "set")).toEqual([]);
    }),
  );

  it.effect("binds a project and clears its binding when the tracker disconnects", () =>
    Effect.gen(function* () {
      const secrets = HoustonSecrets.makeMemory();
      const { service, written, removedTrackers } = makeConnections({ secrets });
      const connections = yield* service;
      yield* connections.connect({ tracker: LINEAR, token: GOOD });

      const projectId = "p" as ProjectId;
      yield* connections.bindProject({
        projectId,
        binding: { tracker: LINEAR, scope: "ENG" },
      });
      expect(written).toEqual([{ projectId, binding: { tracker: LINEAR, scope: "ENG" } }]);

      const disconnected = yield* connections.connect({ tracker: LINEAR, token: null });
      expect(disconnected).toMatchObject({ connected: false, account: null, scopes: [] });
      expect(secrets.entries.has(SECRET_NAME)).toBe(false);
      expect(removedTrackers).toEqual([LINEAR]);
    }),
  );

  it.effect("lists a scope's properties for the binding pickers", () =>
    Effect.gen(function* () {
      const secrets = HoustonSecrets.makeMemory();
      const { service } = makeConnections({ secrets });
      const connections = yield* service;
      const listed = yield* connections.properties({ tracker: LINEAR, scope: "ENG" });
      expect(
        listed.properties.map((property) => [property.id, property.type, property.options]),
      ).toEqual([
        ["title", "title", []],
        ["status", "status", ["Todo", "Done"]],
      ]);
      const refused = yield* Effect.flip(connections.properties({ tracker: LINEAR, scope: "OPS" }));
      expect(refused.reason).toBe("failed");
      expect(refused.detail).toContain("No such team");
    }),
  );

  it.effect("reports a stored key the tracker refuses as status, not a failure", () =>
    Effect.gen(function* () {
      const secrets = HoustonSecrets.makeMemory();
      secrets.entries.set(SECRET_NAME, "expired");
      const { service } = makeConnections({ secrets });

      const listed = yield* (yield* service).list;
      expect(listed.trackers[0]).toMatchObject({
        connected: true,
        account: null,
        detail: "Linear rejected the API key.",
      });
    }),
  );
});
