// Spans per 1,000 pumped provider events, so a span added on the per-event path fails here. The
// ceilings are the counts measured when the guard was added; raise one only for a span worth its
// cost per event, and lower it when a span is removed.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import { materializeReplayTranscriptWorkspace } from "@houston-app/provider-testing/replayTranscript";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { findReplayFixture, runReplayFixture } from "./ProviderReplayFixtures.ts";
import type { OrchestratorV2ProviderReplayHarness } from "./ProviderReplayHarness.ts";

// A name not listed may reach this many spans per 1,000 events: below one per event.
const UNLISTED_CEILING = 100;
// Room for platform differences such as git command counts; one more span per event adds 1,000.
const SLACK = 1.05;
const TOTAL_SLACK = 1.02;

// Today's spans per 1,000 events at or above UNLISTED_CEILING. The ingestion path's
// reportTurnTerminal, EventSink.write and MessageDeliveryWriter.observe run once per event.
const CASES = [
  {
    fixture: "subagent",
    driver: "claudeAgent",
    total: 17_249,
    ceilings: {
      sqlite: 4731,
      "sql.transaction": 1299,
      BEGIN: 1299,
      COMMIT: 1299,
      reportTurnTerminal: 1000,
      "orchestrationV2.EventSink.write": 985,
      "MessageDeliveryWriter.observe": 985,
      "ProjectionStore.getThread": 358,
      "VcsProcess.run": 343,
      "VcsProcess.runUnbounded": 343,
      "VcsProcess.spawn": 343,
      "processRunner.runProcessCore": 343,
      "GitVcsDriver.gitCommand": 313,
      "ProjectionStore.isNodeStored": 209,
      "ProviderEventIngestor.syncSubagentThreadModel": 164,
      "VcsDriverRegistry.detect": 134,
      "VcsProjectConfig.resolveKind": 134,
      "ProjectionStore.getRuntimeRecoveryProjection": 119,
      "EventStoreV2.append": 104,
      "EffectOutbox.enqueue": 104,
    },
  },
  {
    fixture: "subagent",
    driver: "codex",
    total: 14_152,
    ceilings: {
      sqlite: 3064,
      "sql.transaction": 1239,
      BEGIN: 1239,
      COMMIT: 1239,
      "orchestrationV2.EventSink.write": 1009,
      reportTurnTerminal: 1000,
      "MessageDeliveryWriter.observe": 991,
      "ProjectionStore.isNodeStored": 275,
      "ProjectionStore.getThread": 229,
      "VcsProcess.run": 211,
      "VcsProcess.runUnbounded": 211,
      "VcsProcess.spawn": 211,
      "processRunner.runProcessCore": 211,
      "GitVcsDriver.gitCommand": 193,
      "CodexAppServerClient.handleServerNotification": 174,
      "ProviderEventIngestor.syncSubagentThreadModel": 110,
    },
  },
] as const satisfies ReadonlyArray<{
  readonly fixture: string;
  readonly driver: "claudeAgent" | "codex";
  readonly total: number;
  readonly ceilings: Readonly<Record<string, number>>;
}>;

// Counts every event a provider session runtime yields to the session manager's pump.
const countingEvents = <Transcript extends ProviderReplayTranscriptOf, Error>(
  harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>,
  counter: { events: number },
): OrchestratorV2ProviderReplayHarness<Transcript, Error> => ({
  ...harness,
  makeProviderAdapterRegistryLayer: (transcript, options) =>
    Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.map(Effect.service(ProviderAdapterRegistry.ProviderAdapterRegistryV2), (registry) => ({
        ...registry,
        get: (instanceId) =>
          registry.get(instanceId).pipe(
            Effect.map((adapter) => ({
              ...adapter,
              openSession: (input) =>
                adapter.openSession(input).pipe(
                  Effect.map((runtime) => ({
                    ...runtime,
                    events: runtime.events.pipe(
                      Stream.tap(() =>
                        Effect.sync(() => {
                          counter.events++;
                        }),
                      ),
                    ),
                  })),
                ),
            })),
          ),
      })),
    ).pipe(Layer.provide(harness.makeProviderAdapterRegistryLayer(transcript, options))),
});

type ProviderReplayTranscriptOf = Parameters<
  OrchestratorV2ProviderReplayHarness["decodeTranscript"]
>[0];

const HARNESS_SPANS = new Set(["runOrchestratorReplayFixture", "awaitDispatch"]);

// Counts spans by name, leaving out the scenario's own projection polls, the database setup
// (migrations and read-model repair run once per database, not per event) and everything under them.
const countingTracer = () => {
  const counts = new Map<string, number>();
  const excluded = new WeakSet<Tracer.AnySpan>();
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const parent = span.parent._tag === "Some" ? span.parent.value : undefined;
      // Only a call the scenario makes; a parentless one is session work (withoutTurnContext).
      const fromHarness =
        parent?._tag === "Span" &&
        (HARNESS_SPANS.has(parent.name) || parent.name.startsWith("scenario."));
      if (
        (parent !== undefined && excluded.has(parent)) ||
        options.name === "Sqlite.setup" ||
        (options.name === "OrchestratorV2.getThreadProjection" && fromHarness)
      ) {
        excluded.add(span);
      } else {
        counts.set(options.name, (counts.get(options.name) ?? 0) + 1);
      }
      return span;
    },
  });
  return { counts, tracer };
};

describe("span volume", () => {
  it.effect.each(CASES)("$fixture/$driver stays within its spans per 1,000 events", (testCase) => {
    const fixture = findReplayFixture(testCase.fixture)!;
    const provider = fixture.providers.find((candidate) => candidate.driver === testCase.driver)!;
    const recording = countingTracer();
    const counter = { events: 0 };
    const input = {
      fixtureName: fixture.name,
      buildInput: fixture.buildInput,
      driver: provider,
    };
    const run =
      testCase.driver === "codex"
        ? runReplayFixture({
            ...input,
            harness: countingEvents(CodexOrchestratorReplayHarness, counter),
            materializeWorkspace: (transcript, workspace) =>
              Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
          })
        : runReplayFixture({
            ...input,
            harness: countingEvents(ClaudeOrchestratorReplayHarness, counter),
          });
    return run.pipe(
      Effect.withTracer(recording.tracer),
      Effect.tap(() =>
        Effect.sync(() => {
          assert.isAbove(counter.events, 50);
          const ceilings: Readonly<Record<string, number>> = testCase.ceilings;
          let total = 0;
          for (const [name, count] of recording.counts) {
            const per1k = Math.round((count * 1000) / counter.events);
            total += per1k;
            const ceiling = ceilings[name];
            if (ceiling === undefined) {
              assert.isBelow(per1k, UNLISTED_CEILING, `${name}: ${per1k} spans per 1,000 events`);
            } else {
              assert.isAtMost(per1k, Math.ceil(ceiling * SLACK), `${name}: ${per1k} per 1,000`);
            }
          }
          assert.isAtMost(total, Math.ceil(testCase.total * TOTAL_SLACK), "spans per 1,000 events");
        }),
      ),
    );
  });
});
