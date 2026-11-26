import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type EnvironmentId,
  type PeerLinkError,
  ProjectId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
} from "@houston-app/contracts";
import {
  PEER_LINK_SEARCH_MAX_MATCHES,
  PEER_LINK_SEARCH_MAX_TEXT_LENGTH,
  type PeerLinkSearchEvent,
} from "@houston-app/contracts/houston/peerLinkSearch";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerNoWorkspaces } from "./workspaceToolkit/workspaceToolkit.testkit.ts";
import * as PeerLinkSearch from "./peerLinkSearch.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const desk = descriptorOf("environment-desk", "Desk");

const project = ProjectId.make("project:peer");

/** What a fake peer's thread search was asked, and how it answers. */
interface FakePeerSearch {
  readonly queries: Ref.Ref<ReadonlyArray<{ readonly query: string; readonly limit?: number }>>;
  readonly answer: (query: string) => Effect.Effect<ReadonlyArray<ThreadSearch.ThreadSearchHit>>;
}

const hit = (n: number, extra: Partial<ThreadSearch.ThreadSearchHit> = {}) =>
  ({
    threadId: ThreadId.make(`thread:peer-${n}`),
    projectId: project,
    title: `Thread ${n}`,
    source: "title",
    ...extra,
  }) satisfies ThreadSearch.ThreadSearchHit;

/** A peer serving only the thread toolkit, whose search answers as `fake` says. */
const serveSearchPeer = (descriptor: ExecutionEnvironmentDescriptor, fake: FakePeerSearch) =>
  servePeer(
    descriptor,
    McpHttpServer.layerThreadToolkit.pipe(
      Layer.provide(
        Layer.mock(ThreadSearch.ThreadSearch)({
          searchThreads: (input) =>
            Ref.update(fake.queries, (seen) => [
              ...seen,
              { query: input.query, ...(input.limit === undefined ? {} : { limit: input.limit }) },
            ]).pipe(
              Effect.andThen(fake.answer(input.query)),
              Effect.map((matches) => ({ matches })),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
        }),
      ),
      Layer.provide(layerNoWorkspaces),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "houston-peer-search-box-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    ),
  );

const newFake = (answer: FakePeerSearch["answer"]) =>
  Ref.make<FakePeerSearch["queries"] extends Ref.Ref<infer A> ? A : never>([]).pipe(
    Effect.map((queries): FakePeerSearch => ({ queries, answer })),
  );

/** A second socket, so two fake peers can answer at once. */
const apart = <A, E, R>(serve: Effect.Effect<A, E, R>) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) => serve.pipe(Effect.provideContext(server))),
  );

const makeLaptop = (options?: { readonly timeoutMs?: number }) =>
  Effect.gen(function* () {
    const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const searchLayer = PeerLinkSearch.layerWith(options).pipe(
      Layer.provide(PeerForwarding.layer),
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
        }),
      ),
    );
    const search = Context.get(
      yield* Layer.build(Layer.fresh(searchLayer)),
      PeerLinkSearch.PeerLinkSearch,
    );
    return {
      links: Context.get(linking, PeerLinks.PeerLinks),
      sql: Context.get(linking, SqlClient.SqlClient),
      settings: Context.get(linking, ServerSettings.ServerSettingsService),
      search,
    };
  });

const collect = (stream: Stream.Stream<PeerLinkSearchEvent, PeerLinkError>) =>
  Stream.runCollect(stream).pipe(Effect.map((events) => Array.from(events)));

const machineOf = (events: ReadonlyArray<PeerLinkSearchEvent>, environmentId: EnvironmentId) => {
  const found = events.find(
    (event) => event.type === "machine" && event.machine.environmentId === environmentId,
  );
  if (found?.type !== "machine") throw new Error(`no answer from ${environmentId}`);
  return found.machine;
};

it.effect("tags each linked machine's matches and bounds their count and text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const longText = "x".repeat(PEER_LINK_SEARCH_MAX_TEXT_LENGTH + 20);
      const fake = yield* newFake(() =>
        Effect.succeed([
          hit(0, { title: longText, snippet: longText }),
          ...Array.from({ length: PEER_LINK_SEARCH_MAX_MATCHES + 4 }, (_, n) => hit(n + 1)),
        ]),
      );
      const b = yield* serveSearchPeer(box, fake);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");

      const events = yield* collect(a.search.search({ query: "migration" }));

      expect(events[0]).toEqual({
        type: "started",
        enabled: true,
        machines: [{ environmentId: box.environmentId, label: "Box" }],
      });
      const machine = machineOf(events, box.environmentId);
      expect(machine).toMatchObject({ label: "Box", status: "ok" });
      expect(machine.matches).toHaveLength(PEER_LINK_SEARCH_MAX_MATCHES);
      // The first match's title and excerpt were cut to the text bound.
      expect(machine.matches[0]?.title).toHaveLength(PEER_LINK_SEARCH_MAX_TEXT_LENGTH);
      expect(machine.matches[0]?.snippet).toHaveLength(PEER_LINK_SEARCH_MAX_TEXT_LENGTH);
      // Each trimmed bound names itself, its value, the amount received and what was asked.
      expect(machine.limits).toContainEqual({
        limit: "matches",
        max: PEER_LINK_SEARCH_MAX_MATCHES,
        actual: PEER_LINK_SEARCH_MAX_MATCHES + 5,
        detail: expect.stringContaining("migration"),
      });
      expect(machine.limits).toContainEqual({
        limit: "textLength",
        max: PEER_LINK_SEARCH_MAX_TEXT_LENGTH,
        actual: longText.length,
        detail: expect.stringContaining("migration"),
      });
      // Only what the user typed went out, with the per-machine bound as its limit.
      expect(yield* Ref.get(fake.queries)).toEqual([
        { query: "migration", limit: PEER_LINK_SEARCH_MAX_MATCHES },
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live("a slow machine does not hold back another, and is named with its limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const slowFake = yield* newFake(() => Effect.never);
      const quickFake = yield* newFake(() => Effect.succeed([hit(1)]));
      const slow = yield* serveSearchPeer(desk, slowFake);
      const quick = yield* apart(serveSearchPeer(box, quickFake));
      const a = yield* makeLaptop({ timeoutMs: 400 });
      // Linked first, so a search that took machines in turn would answer for it first.
      yield* linkTo(a.links, slow, "full-access");
      yield* linkTo(a.links, quick, "full-access");

      const startedAt = yield* Clock.currentTimeMillis;
      const arrivals: Array<{ readonly id: string; readonly at: number }> = [];
      yield* a.search.search({ query: "release" }).pipe(
        Stream.runForEach((event) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              arrivals.push({
                id: event.type === "machine" ? event.machine.environmentId : event.type,
                at: now - startedAt,
              });
            }),
          ),
        ),
      );

      expect(arrivals.map((arrival) => arrival.id)).toEqual([
        "started",
        box.environmentId,
        desk.environmentId,
      ]);
      // The quick machine answered well before the slow one's bound ran out.
      expect(arrivals[1]!.at).toBeLessThan(300);
      expect(arrivals[2]!.at).toBeGreaterThanOrEqual(390);
      const events = yield* collect(a.search.search({ query: "release", environmentIds: [desk.environmentId] }));
      expect(machineOf(events, desk.environmentId)).toMatchObject({
        status: "timed_out",
        matches: [],
        limits: [
          {
            limit: "timeoutMs",
            max: 400,
            actual: 400,
            detail: expect.stringContaining("release"),
          },
        ],
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("sends nothing to any machine while Linked environments is off here", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* newFake(() => Effect.succeed([hit(1)]));
      const b = yield* serveSearchPeer(box, fake);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");
      yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: false });
      yield* Ref.set(b.bearers, []);
      yield* Ref.set(b.probes, 0);

      const events = yield* collect(a.search.search({ query: "release" }));

      expect(events).toEqual([{ type: "started", enabled: false, machines: [] }]);
      // Nothing reached the peer: no search, no bearer token, not even a descriptor probe.
      expect(yield* Ref.get(fake.queries)).toEqual([]);
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      expect(yield* Ref.get(b.probes)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live("reports an expired link as expired without calling the machine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* newFake(() => Effect.succeed([hit(1)]));
      const b = yield* serveSearchPeer(box, fake);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, b, "full-access");
      yield* a.sql`UPDATE peer_environment_links SET expires_at = '2020-01-01T00:00:00.000Z'`;
      yield* Ref.set(b.bearers, []);

      const events = yield* collect(a.search.search({ query: "release" }));

      expect(machineOf(events, box.environmentId)).toMatchObject({
        status: "expired",
        matches: [],
        message: expect.stringContaining("expired"),
      });
      expect(yield* Ref.get(fake.queries)).toEqual([]);
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("names a machine that is off or does not answer, and keeps the others", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* newFake(() => Effect.succeed([hit(1)]));
      const off = yield* serveSearchPeer(box, fake);
      const a = yield* makeLaptop();
      yield* linkTo(a.links, off, "full-access");
      yield* off.settings.updateSettings({ linkedEnvironmentsEnabled: false });

      const events = yield* collect(a.search.search({ query: "release" }));
      expect(machineOf(events, box.environmentId)).toMatchObject({ status: "off", matches: [] });

      yield* off.settings.updateSettings({ linkedEnvironmentsEnabled: true });
      yield* a.sql`UPDATE peer_environment_links SET urls_json = '["http://127.0.0.1:9"]'`;
      const unreachable = yield* collect(a.search.search({ query: "release" }));
      expect(machineOf(unreachable, box.environmentId)).toMatchObject({
        status: "unreachable",
        matches: [],
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
