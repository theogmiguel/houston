import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CursorOrchestratorReplayHarness } from "../Adapters/CursorAdapterV2.testkit.ts";
import { messageRestartInput } from "./fixtures/message_steering/input.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";

describe("Cursor replay fixtures", () => {
  itRunsReplayFixtures("cursor", (input) =>
    runReplayFixture({ ...input, harness: CursorOrchestratorReplayHarness }),
  );

  // Houston (AD-040): Cursor's steering recording replays as restart_active.
  const cursorSteeringProvider = findReplayFixture("message_steering_restart")?.providers.find(
    (provider) => provider.driver === "cursor",
  );
  it.effect("executes explicit Cursor restart_active through the recorded SDK boundary", () =>
    cursorSteeringProvider === undefined
      ? Effect.die(new Error("message_steering_restart has no cursor recording"))
      : runReplayFixture({
          fixtureName: "message_steering_restart",
          buildInput: messageRestartInput,
          driver: cursorSteeringProvider,
          harness: CursorOrchestratorReplayHarness,
        }),
  );
});
