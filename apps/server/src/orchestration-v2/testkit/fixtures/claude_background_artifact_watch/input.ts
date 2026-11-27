import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_BACKGROUND_ARTIFACT_WATCH_PROMPT =
  "Publish a live artifact, then answer exactly: artifact watch fixture complete";

export function claudeBackgroundArtifactWatchInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_BACKGROUND_ARTIFACT_WATCH_PROMPT }],
  };
}
