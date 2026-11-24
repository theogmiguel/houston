/** Wire protocols the gateway forwards. */
export type InferenceApi = "chat-completions" | "completions" | "responses" | "messages";

export interface InferenceUsage {
  /** Every prompt token, cached ones included. */
  readonly promptTokens: number | null;
  readonly cachedPromptTokens: number | null;
  readonly completionTokens: number | null;
  readonly reasoningTokens: number | null;
}

export interface UsageMeter {
  /** Returns true when this chunk carried the response's first generated content. */
  readonly push: (chunk: Uint8Array) => boolean;
  /** Whether a stream reached its protocol's terminal event; clients may disconnect right after it. */
  readonly finished: () => boolean;
  readonly finish: () => InferenceUsage;
  /** True only for a terminal response that emitted no answer, reasoning, or tool work. */
  readonly empty: () => boolean;
  /** A small, already parsed non-streaming error body, never its raw text. */
  readonly errorBody: () => unknown;
  /** The upstream's id for a Responses API response, which later requests may reference. */
  readonly responseId: () => string | undefined;
}

// Accounting never holds more than this per SSE line or per non-streaming body.
const MAX_LINE_CHARS = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 4 * 1024 * 1024;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const field = (value: unknown, ...path: ReadonlyArray<string>): unknown => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const nonEmpty = (value: unknown) =>
  (typeof value === "string" && value.length > 0) || (Array.isArray(value) && value.length > 0);

interface Tally {
  prompt?: number;
  cached?: number;
  completion?: number;
  reasoning?: number;
  terminal?: boolean;
  responseId?: string;
}

function readResponseId(response: unknown, tally: Tally) {
  const id = field(response, "id");
  if (typeof id === "string" && id !== "") tally.responseId = id;
}

/** OpenAI chat and legacy completions. */
function readOpenAiUsage(usage: unknown, tally: Tally) {
  if (!isRecord(usage)) return;
  const prompt = count(usage.prompt_tokens);
  const completion = count(usage.completion_tokens);
  if (prompt !== undefined) tally.prompt = prompt;
  if (completion !== undefined) tally.completion = completion;
  const cached = count(field(usage, "prompt_tokens_details", "cached_tokens"));
  if (cached !== undefined) tally.cached = cached;
  const reasoning = count(field(usage, "completion_tokens_details", "reasoning_tokens"));
  if (reasoning !== undefined) tally.reasoning = reasoning;
}

function readResponsesUsage(usage: unknown, tally: Tally) {
  if (!isRecord(usage)) return;
  const prompt = count(usage.input_tokens);
  const completion = count(usage.output_tokens);
  if (prompt !== undefined) tally.prompt = prompt;
  if (completion !== undefined) tally.completion = completion;
  const cached = count(field(usage, "input_tokens_details", "cached_tokens"));
  if (cached !== undefined) tally.cached = cached;
  const reasoning = count(field(usage, "output_tokens_details", "reasoning_tokens"));
  if (reasoning !== undefined) tally.reasoning = reasoning;
}

/** Anthropic's input_tokens excludes cache reads and writes; the prompt is their sum. */
function readAnthropicUsage(usage: unknown, tally: Tally) {
  if (!isRecord(usage)) return;
  const input = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const written = count(usage.cache_creation_input_tokens);
  if (input !== undefined) tally.prompt = input + (read ?? 0) + (written ?? 0);
  if (read !== undefined) tally.cached = read;
  const completion = count(usage.output_tokens);
  if (completion !== undefined) tally.completion = completion;
}

/** Where a piece of generated text goes: the answer, the model's reasoning, or a tool call. */
export type DeltaChannel = "answer" | "reasoning" | "tool";

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** The generated text one streamed event adds, by channel. */
function readDeltas(
  api: InferenceApi,
  event: unknown,
): ReadonlyArray<readonly [DeltaChannel, string]> {
  if (!isRecord(event)) return [];
  switch (api) {
    case "completions": {
      const choices = Array.isArray(event.choices) ? event.choices : [];
      return choices.map((choice) => ["answer", asText(field(choice, "text"))] as const);
    }
    case "chat-completions": {
      const choices = Array.isArray(event.choices) ? event.choices : [];
      return choices.flatMap((choice) => {
        const delta = field(choice, "delta");
        const calls = field(delta, "tool_calls");
        return [
          ["answer", asText(field(delta, "content"))] as const,
          [
            "reasoning",
            asText(field(delta, "reasoning_content")) + asText(field(delta, "reasoning")),
          ] as const,
          ...(Array.isArray(calls)
            ? calls.map(
                (call) => ["tool", asText(field(call, "function", "arguments")) || " "] as const,
              )
            : []),
        ];
      });
    }
    case "responses": {
      const type = typeof event.type === "string" ? event.type : "";
      if (!type.endsWith(".delta")) return [];
      const delta = asText(event.delta);
      return [
        [
          type === "response.output_text.delta" || type === "response.refusal.delta"
            ? "answer"
            : type.includes("reasoning")
              ? "reasoning"
              : "tool",
          delta,
        ] as const,
      ];
    }
    case "messages": {
      if (event.type !== "content_block_delta") return [];
      const delta = field(event, "delta");
      const kind = field(delta, "type");
      return kind === "text_delta"
        ? [["answer", asText(field(delta, "text"))] as const]
        : kind === "thinking_delta"
          ? [["reasoning", asText(field(delta, "thinking"))] as const]
          : [["tool", asText(field(delta, "partial_json")) || " "] as const];
    }
  }
}

/** Reads one streamed event; returns true when it carries generated content. */
function readEvent(api: InferenceApi, event: unknown, tally: Tally): boolean {
  if (!isRecord(event)) return false;
  switch (api) {
    case "chat-completions":
    case "completions": {
      if (event.usage !== undefined && event.usage !== null) readOpenAiUsage(event.usage, tally);
      const choices = Array.isArray(event.choices) ? event.choices : [];
      if (choices.some((choice) => typeof field(choice, "finish_reason") === "string")) {
        tally.terminal = true;
      }
      return choices.some((choice) => {
        if (api === "completions") return nonEmpty(field(choice, "text"));
        const delta = field(choice, "delta");
        return (
          nonEmpty(field(delta, "content")) ||
          nonEmpty(field(delta, "reasoning_content")) ||
          nonEmpty(field(delta, "reasoning")) ||
          nonEmpty(field(delta, "tool_calls"))
        );
      });
    }
    case "responses": {
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "response.created" || type === "response.completed") {
        readResponseId(event.response, tally);
      }
      if (
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed"
      ) {
        readResponsesUsage(field(event, "response", "usage"), tally);
        tally.terminal = true;
      }
      return type.endsWith(".delta") && nonEmpty(event.delta);
    }
    case "messages": {
      if (event.type === "message_start")
        readAnthropicUsage(field(event, "message", "usage"), tally);
      if (event.type === "message_delta") {
        // Cumulative output; message_start already carried the prompt.
        const completion = count(field(event, "usage", "output_tokens"));
        if (completion !== undefined) tally.completion = completion;
      }
      if (event.type === "message_stop") tally.terminal = true;
      return event.type === "content_block_delta";
    }
  }
}

function readBody(api: InferenceApi, body: unknown, tally: Tally): boolean {
  const usage = field(body, "usage");
  if (api === "responses") {
    readResponsesUsage(usage, tally);
    readResponseId(body, tally);
  } else if (api === "messages") readAnthropicUsage(usage, tally);
  else readOpenAiUsage(usage, tally);
  const bodyEvent =
    api === "messages" && isRecord(body) && body.stop_reason !== undefined
      ? { ...body, type: "message_stop" }
      : body;
  return readEvent(api, bodyEvent, tally);
}

/**
 * Tees a response body into usage counts. Never throws: anything it cannot read reports as
 * unknown (null), and an oversized line or body is dropped rather than buffered.
 */
export function makeUsageMeter(
  api: InferenceApi,
  streaming: boolean,
  /** Sees each piece of generated text as it streams, for the gateway's watchdog. */
  onDelta?: (channel: DeltaChannel, text: string) => void,
): UsageMeter {
  const decoder = new TextDecoder();
  const tally: Tally = {};
  let pending = "";
  let skippingLine = false;
  let bodyTooLarge = false;
  let sawContent = false;
  let errorBody: unknown;

  const readLine = (line: string): boolean => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (data === "[DONE]") tally.terminal = true;
    if (data === "" || data === "[DONE]") return false;
    const event = parseJson(data);
    if (onDelta !== undefined) {
      for (const [channel, piece] of readDeltas(api, event)) {
        if (piece.length > 0) onDelta(channel, piece);
      }
    }
    return readEvent(api, event, tally);
  };

  const push = (chunk: Uint8Array): boolean => {
    const text = decoder.decode(chunk, { stream: true });
    if (!streaming) {
      if (bodyTooLarge) return false;
      if (pending.length + text.length > MAX_BODY_CHARS) {
        bodyTooLarge = true;
        pending = "";
      } else {
        pending += text;
      }
      return false;
    }
    let content = false;
    let start = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
      const piece = text.slice(start, newline);
      start = newline + 1;
      if (skippingLine) {
        skippingLine = false;
        pending = "";
        continue;
      }
      const line = (pending + piece).replace(/\r$/, "");
      pending = "";
      if (readLine(line)) content = true;
    }
    if (!skippingLine) {
      pending += text.slice(start);
      if (pending.length > MAX_LINE_CHARS) {
        skippingLine = true;
        pending = "";
      }
    }
    if (content && !sawContent) {
      sawContent = true;
      return true;
    }
    return false;
  };

  const finish = (): InferenceUsage => {
    const rest = decoder.decode();
    if (streaming) {
      if (!skippingLine) readLine((pending + rest).trim());
    } else if (!bodyTooLarge && pending.length + rest.length <= MAX_BODY_CHARS) {
      const body = parseJson(pending + rest);
      if (readBody(api, body, tally)) sawContent = true;
      errorBody = body;
    }
    pending = "";
    return {
      promptTokens: tally.prompt ?? null,
      cachedPromptTokens: tally.cached ?? null,
      completionTokens: tally.completion ?? null,
      reasoningTokens: tally.reasoning ?? null,
    };
  };

  return {
    push,
    finished: () => tally.terminal === true,
    empty: () => tally.terminal === true && !sawContent,
    errorBody: () => errorBody,
    finish,
    responseId: () => tally.responseId,
  };
}
