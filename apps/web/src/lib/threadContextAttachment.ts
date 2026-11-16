import type { EnvironmentId, OrchestrationV2ThreadTranscript } from "@houston-app/contracts";
import { toKindScopedComposerContextId } from "@houston-app/shared/composerContextReferences";
import { threadTranscriptHeader } from "@houston-app/shared/threadTranscript";
import * as DateTime from "effect/DateTime";

const NON_TITLE_CHARACTER = /[^\p{L}\p{N}._ -]/gu;

export function threadContextAttachment(
  environmentId: EnvironmentId,
  transcript: OrchestrationV2ThreadTranscript,
): File {
  const updatedAt = DateTime.formatIso(transcript.updatedAt);
  const name = toKindScopedComposerContextId(
    "thread",
    `${environmentId}:${transcript.threadId}:${updatedAt}`,
  );
  const title = transcript.title.replace(NON_TITLE_CHARACTER, "_").slice(0, 64) || "Thread";
  return new File(
    [
      threadTranscriptHeader(environmentId, transcript),
      ...transcript.items.map((row) => `${JSON.stringify(row)}\n`),
    ],
    `${title}-${name.slice(-16)}.jsonl`,
    { type: "application/x-ndjson" },
  );
}
