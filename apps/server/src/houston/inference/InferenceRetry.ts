type JsonObject = Record<string, unknown>;

const OPTIONAL_FIELDS = new Set([
  "stream_options",
  "metadata",
  "store",
  "parallel_tool_calls",
  "response_format",
  "text",
  "include",
  "prompt_cache_key",
  "safety_identifier",
  "reasoning",
  "reasoning_effort",
  "verbosity",
  "service_tier",
  "user",
  "seed",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "n",
  "modalities",
  "audio",
  "prediction",
  "web_search_options",
]);

function record(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function recoverField(rawError: Uint8Array, rawBody: Uint8Array): Uint8Array | undefined {
  try {
    return rejectedField(
      JSON.parse(Buffer.from(rawError).toString("utf8")),
      JSON.parse(Buffer.from(rawBody).toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

/** Only exact structured rejection evidence allows removing one optional top-level field. */
export function rejectedField(error: unknown, body: JsonObject): Uint8Array | undefined {
  const wrapper = record(error);
  const detail = record(wrapper?.error) ?? wrapper;
  if (detail === undefined) return;
  const candidates = [detail.param, ...(Array.isArray(detail.loc) ? [detail.loc.at(-1)] : [])];
  const field = candidates.find(
    (candidate) =>
      typeof candidate === "string" && OPTIONAL_FIELDS.has(candidate) && candidate in body,
  );
  if (typeof field !== "string") return;
  const compatible = { ...body };
  delete compatible[field];
  // Remove the injected usage request with a rejected stream_options object.
  return new TextEncoder().encode(JSON.stringify(compatible));
}
