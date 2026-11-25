import { HOUSTON_GATEWAY_PROVIDER_ENV } from "./gatewayExtensionSource.ts";

/** Turns kept verbatim after a prefix-reusing compaction, within Pi's keepRecentTokens. */
const PI_HOUSTON_COMPACTION_KEEP_TURNS = 2;
/** Below this much free context for the summary, Pi's own compaction runs instead. */
const PI_HOUSTON_COMPACTION_MIN_OUTPUT_TOKENS = 8_192;

export const PI_HOUSTON_COMPACTION_INSTRUCTION = `\
Stop working on the task for a moment. Your context is about to be compacted: everything above this message, except the most recent turns, will be replaced by a summary that you write now. Do not call any tools. If an earlier summary appears above, carry its information forward.

Write a structured context checkpoint that you will use to continue the work, in this exact format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Every constraint, preference, or requirement the user stated]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, commands, and error messages. Never include secrets, credentials, tokens, passwords, or their values; name only the approved way to retrieve them again.`;

/**
 * Managed Pi compaction that reuses the inference server's prompt cache: the summary request is the
 * last request sent for this session plus one user instruction, so only the instruction is prefilled.
 * Anything that would break the prefix falls through to Pi's own compaction.
 */
export const PI_HOUSTON_CACHE_COMPACTION_SNIPPET = `\
const COMPACTION_KEEP_TURNS = ${PI_HOUSTON_COMPACTION_KEEP_TURNS};
const COMPACTION_MIN_OUTPUT_TOKENS = ${PI_HOUSTON_COMPACTION_MIN_OUTPUT_TOKENS};
const COMPACTION_INSTRUCTION = ${JSON.stringify(PI_HOUSTON_COMPACTION_INSTRUCTION)};
const PREFIX_MISMATCH = "houston-compaction-prefix-mismatch";

function isManagedModel<M extends { provider: string; api: string }>(model: M | undefined): model is M {
  const provider = process.env[${JSON.stringify(HOUSTON_GATEWAY_PROVIDER_ENV)}];
  return provider !== undefined && model?.provider === provider && model?.api === "openai-completions";
}

// Output caps do not enter the prompt, so they may differ between the two requests.
function requestShape(payload: Record<string, unknown>): string {
  const { messages: _messages, max_tokens: _max, max_completion_tokens: _maxCompletion, ...rest } = payload;
  return JSON.stringify(rest);
}

function extendsRequest(previous: unknown, next: unknown): boolean {
  if (typeof previous !== "object" || previous === null || typeof next !== "object" || next === null) return false;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const prefix = before.messages;
  const messages = after.messages;
  if (!Array.isArray(prefix) || !Array.isArray(messages) || messages.length <= prefix.length) return false;
  if (requestShape(before) !== requestShape(after)) return false;
  return prefix.every((message, index) => JSON.stringify(message) === JSON.stringify(messages[index]));
}

type ProjectedEntry = { sourceEntry: { id: string; type: string }; messages: Array<{ role: string }> };

/** The last COMPACTION_KEEP_TURNS assistant turns, with the user prompt that opened the oldest one. */
function keptBoundaryIndex(entries: ReadonlyArray<ProjectedEntry>, piKeptId: string): number | undefined {
  const piIndex = entries.findIndex((entry) => entry.sourceEntry.id === piKeptId);
  if (piIndex === -1) return undefined;
  let turns = 0;
  let boundary = -1;
  for (let index = entries.length - 1; index > piIndex; index -= 1) {
    if (!entries[index]!.messages.some((message) => message.role === "assistant")) continue;
    turns += 1;
    boundary = index;
    if (turns === COMPACTION_KEEP_TURNS) break;
  }
  if (boundary === -1) return piIndex;
  for (let index = boundary - 1; index > piIndex; index -= 1) {
    const messages = entries[index]!.messages;
    if (messages.length === 0) continue;
    if (messages.some((message) => message.role === "user")) boundary = index;
    break;
  }
  return boundary;
}

function compactionFileLists(
  entries: ReadonlyArray<ProjectedEntry>,
  boundary: number,
  branchEntries: ReadonlyArray<{ type: string; details?: unknown }>,
) {
  const read = new Set<string>();
  const modified = new Set<string>();
  const previous = branchEntries.findLast((entry) => entry.type === "compaction");
  const details = previous?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
  if (Array.isArray(details?.readFiles)) for (const file of details.readFiles) if (typeof file === "string") read.add(file);
  if (Array.isArray(details?.modifiedFiles)) for (const file of details.modifiedFiles) if (typeof file === "string") modified.add(file);
  const add = (name: unknown, args: unknown) => {
    const path = (args as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string" || path.length === 0) return;
    if (name === "read") read.add(path);
    if (name === "write" || name === "edit") modified.add(path);
  };
  for (const entry of entries.slice(0, boundary)) {
    for (const message of entry.messages as Array<Record<string, any>>) {
      if (message.role === "toolResult") for (const call of message.nestedCalls?.calls ?? []) add(call.name, call.arguments);
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) if (block?.type === "toolCall") add(block.name, block.arguments);
    }
  }
  const readFiles = [...read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(\`<read-files>\\n\${readFiles.join("\\n")}\\n</read-files>\`);
  if (modifiedFiles.length > 0) sections.push(\`<modified-files>\\n\${modifiedFiles.join("\\n")}\\n</modified-files>\`);
  return { readFiles, modifiedFiles, text: sections.length === 0 ? "" : \`\\n\\n\${sections.join("\\n\\n")}\` };
}

function registerHoustonCacheCompaction(pi: ExtensionAPI) {
  if (process.env[${JSON.stringify(HOUSTON_GATEWAY_PROVIDER_ENV)}] === undefined) return;
  let lastRequest: unknown;

  pi.on("before_provider_request", (event, ctx) => {
    if (isManagedModel(ctx.model)) lastRequest = event.payload;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    const previous = lastRequest;
    if (!isManagedModel(model) || previous === undefined || event.signal.aborted) return;
    const projection = ctx.sessionManager.buildSessionProjection();
    const entries = projection.entries as unknown as ProjectedEntry[];
    const boundary = keptBoundaryIndex(entries, event.preparation.firstKeptEntryId);
    if (boundary === undefined) return;
    const instruction = event.customInstructions
      ? \`\${COMPACTION_INSTRUCTION}\\n\\nAdditional focus: \${event.customInstructions}\`
      : COMPACTION_INSTRUCTION;
    // chars/4 overestimates tokens, as Pi's own estimate does.
    const promptTokens = event.preparation.tokensBefore + Math.ceil(instruction.length / 4);
    const maxTokens = Math.min(model.maxTokens, model.contextWindow - promptTokens);
    if (!(maxTokens >= COMPACTION_MIN_OUTPUT_TOKENS)) return;

    const messages = [
      ...convertToLlm(projection.messages),
      { role: "user" as const, content: [{ type: "text" as const, text: instruction }], timestamp: Date.now() },
    ];
    const thinkingLevel = pi.getThinkingLevel();
    let mismatch = false;
    let response;
    try {
      response = await ctx.modelRegistry.streamSimple(model, { messages }, {
        signal: event.signal,
        maxTokens,
        sessionId: ctx.sessionManager.getSessionId(),
        ...(model.reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
        onPayload: (payload: unknown) => {
          if (extendsRequest(previous, payload)) return undefined;
          mismatch = true;
          throw new Error(PREFIX_MISMATCH);
        },
      }).result();
    } catch {
      return event.signal.aborted ? { cancel: true } : undefined;
    }
    if (event.signal.aborted) return { cancel: true };
    if (mismatch || response.stopReason !== "stop" || response.content.some((block) => block.type === "toolCall")) return;
    const summary = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (summary.length === 0) return;
    const files = compactionFileLists(entries, boundary, event.branchEntries);
    return {
      compaction: {
        summary: summary + files.text,
        firstKeptEntryId: entries[boundary]!.sourceEntry.id,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
        details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
      },
    };
  });
}
`;
