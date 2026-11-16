import { assert } from "@effect/vitest";
import { ProviderDriverKind } from "@houston-app/contracts";
import * as Effect from "effect/Effect";

import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import {
  findReplayFixture,
  runReplayFixture,
} from "../orchestration-v2/testkit/ProviderReplayFixtures.ts";

/** The domain events of the replayed two-turn Claude conversation, in commit order. */
export const replayedTurnEvents = Effect.gen(function* () {
  const fixture = findReplayFixture("multi_turn");
  const driver = fixture?.providers.find(
    (provider) => provider.driver === ProviderDriverKind.make("claudeAgent"),
  );
  assert.isDefined(fixture);
  assert.isDefined(driver);
  const result = yield* runReplayFixture({
    fixtureName: fixture.name,
    buildInput: fixture.buildInput,
    driver,
    harness: ClaudeOrchestratorReplayHarness,
  });
  return result.storedEvents.map((stored) => stored.event);
});
