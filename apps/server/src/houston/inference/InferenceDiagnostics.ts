import { type InferenceFailureCause } from "@houston-app/contracts/houston/inference";

export type InferenceSignal = "transport" | "cancelled" | "empty" | "tool" | "watchdog" | "unknown";
export type InferenceWatchdog = "loop" | "reasoning-limit" | "idle";

export function inferenceFailureCause(
  signal: InferenceSignal,
  status?: number,
  watchdog?: InferenceWatchdog,
): InferenceFailureCause {
  if (watchdog === "idle" || signal === "transport")
    return watchdog ? `watchdog-${watchdog}` : "transport";
  if (watchdog !== undefined) return `watchdog-${watchdog}`;
  if (signal === "cancelled") return "cancelled";
  if (signal === "empty") return "empty-completed";
  if (signal === "tool" || status === 422) return "tool-format";
  if (status === 413) return "context-overflow";
  if (status === 501 || status === 426 || (status !== undefined && status >= 400 && status < 500)) {
    return "unsupported-field";
  }
  return "unknown";
}

/** General guidance only: no upstream text, request bodies, or credentials cross this boundary. */
export function inferenceFailureAdvice(cause: InferenceFailureCause): string {
  switch (cause) {
    case "transport":
      return "Check that the model server is running and reachable.";
    case "cancelled":
      return "The request was stopped before it completed.";
    case "context-overflow":
      return "Compact the conversation or reduce its prompt and output budget.";
    case "unsupported-field":
      return "Check the model server's supported request fields and protocol.";
    case "tool-format":
      return "Check the server's tool-call format and schema compatibility.";
    case "empty-completed":
      return "The server completed without content; check its response protocol and model profile.";
    case "watchdog-loop":
      return "The model repeated itself; try a different model or reasoning profile.";
    case "watchdog-reasoning-limit":
      return "The model reasoned without answering; lower reasoning or choose another model.";
    case "watchdog-idle":
      return "The server stopped producing output; check its health and loaded model.";
    case "unknown":
    default:
      return "Inspect the model server's error logs for the request failure.";
  }
}

/** A bounded, exact optional-field rejection. Never treats a body substring as proof of safety. */
export function unsupportedOptionalField(
  errorBody: unknown,
): "stream_options" | "metadata" | undefined {
  if (typeof errorBody !== "object" || errorBody === null || Array.isArray(errorBody))
    return undefined;
  const body = errorBody as Readonly<Record<string, unknown>>;
  const error =
    typeof body.error === "object" && body.error !== null && !Array.isArray(body.error)
      ? (body.error as Readonly<Record<string, unknown>>)
      : body;
  const recognized = new Set([
    "invalid_request_error",
    "validation_error",
    "invalid_request",
    "value_error",
  ]);
  if (typeof error.type !== "string" || !recognized.has(error.type)) return undefined;
  const params = typeof error.param === "string" ? error.param : undefined;
  if (params === "stream_options" || params === "metadata") return params;
  const details = Array.isArray(error.details) ? error.details : [];
  const loc =
    details.length === 1 && typeof details[0] === "object" && details[0] !== null
      ? (details[0] as Readonly<Record<string, unknown>>).loc
      : undefined;
  return Array.isArray(loc) &&
    loc.length === 2 &&
    loc[0] === "body" &&
    (loc[1] === "stream_options" || loc[1] === "metadata")
    ? loc[1]
    : undefined;
}
