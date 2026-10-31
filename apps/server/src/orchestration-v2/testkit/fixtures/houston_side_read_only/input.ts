// The prompts and thread ids the composed read-only recordings expect. Each transcript keeps its
// recording's prompt; only the permission rules (OpenCode) or the second source turn (Codex)
// differ from the recording named in its transcript_start metadata.
import { ProviderInstanceId, ThreadId, type ModelSelection } from "@t3tools/contracts";

import {
  OPENCODE2_MODEL_SELECTION,
  OPENCODE2_SIMPLE_PROMPT,
  OPENCODE_MODEL_SELECTION,
  SIMPLE_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
  THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
} from "../shared.ts";

export const houstonSideReadOnly = {
  codex: {
    transcriptFile: new URL("./codex_transcript.ndjson", import.meta.url),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    } satisfies ModelSelection,
    sourcePrompt: THREAD_FORK_NATIVE_PRIOR_TURN_ALPHA_PROMPT,
    asidePrompt: THREAD_FORK_NATIVE_PRIOR_TURN_REPEAT_PROMPT,
  },
  opencode: {
    transcriptFile: new URL("./opencode_transcript.ndjson", import.meta.url),
    modelSelection: OPENCODE_MODEL_SELECTION,
    prompt: SIMPLE_PROMPT,
    threadId: ThreadId.make("thread:opencode-side"),
  },
  opencode2: {
    transcriptFile: new URL("./opencode2_transcript.ndjson", import.meta.url),
    modelSelection: OPENCODE2_MODEL_SELECTION,
    prompt: OPENCODE2_SIMPLE_PROMPT,
    threadId: ThreadId.make("thread:opencode2-side"),
  },
} as const;
