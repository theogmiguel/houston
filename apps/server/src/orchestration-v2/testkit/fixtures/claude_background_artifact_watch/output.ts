import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@houston-app/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_ARTIFACT_WATCH_PROMPT } from "./input.ts";

const ARTIFACT_WATCH_TASK_ID = "sv0woix3h";
const ARTIFACT_WATCH_DESCRIPTION =
  "live updates for artifact https://claude.ai/artifact/EXAMPLEID (auto-armed on publish)";

// Claude arms an artifact watch as monitor_ws, not an agent. It belongs in the background roster.
export function assertClaudeBackgroundArtifactWatchOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_BACKGROUND_ARTIFACT_WATCH_PROMPT]);

  assert.lengthOf(projection.subagents, 0, "an artifact watch must not project a subagent");
  assert.lengthOf(
    projection.nodes.filter((node) => node.kind === "subagent"),
    0,
    "an artifact watch must not project a subagent node",
  );

  const rosterUpdates = result.domainEvents.flatMap((event) =>
    event.type === "provider-thread.updated" ? [event.payload.pendingBackgroundTasks ?? []] : [],
  );
  const artifactWatchRosterUpdates = rosterUpdates.filter((tasks) =>
    tasks.some((task) => task.taskId === ARTIFACT_WATCH_TASK_ID),
  );
  assert.isAbove(
    artifactWatchRosterUpdates.length,
    0,
    "the artifact watch must appear in the pending background roster",
  );
  for (const tasks of artifactWatchRosterUpdates) {
    assert.deepEqual(tasks, [
      {
        taskId: ARTIFACT_WATCH_TASK_ID,
        description: ARTIFACT_WATCH_DESCRIPTION,
        kind: "monitor",
      },
    ]);
  }
}
