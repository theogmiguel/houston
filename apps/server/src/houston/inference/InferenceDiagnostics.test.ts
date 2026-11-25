import { expect, it } from "@effect/vitest";
import {
  inferenceFailureCause,
  inferenceFailureAdvice,
  unsupportedOptionalField,
} from "./InferenceDiagnostics.ts";

it("uses bounded failure categories and safe advice", () => {
  expect(inferenceFailureCause("transport", 500)).toBe("transport");
  expect(inferenceFailureCause("cancelled")).toBe("cancelled");
  expect(inferenceFailureCause("watchdog", 200, "loop")).toBe("watchdog-loop");
  expect(inferenceFailureCause("watchdog", 200, "idle")).toBe("watchdog-idle");
  expect(inferenceFailureCause("empty", 200)).toBe("empty-completed");
  expect(inferenceFailureCause("unknown", 422)).toBe("tool-format");
  expect(inferenceFailureCause("unknown", 413)).toBe("context-overflow");
  expect(inferenceFailureCause("unknown", 501)).toBe("unsupported-field");
  expect(inferenceFailureCause("unknown", 500)).toBe("unknown");
  const privateText = "private prompt secret";
  expect(inferenceFailureAdvice(inferenceFailureCause("unknown", 500))).not.toContain(privateText);
});

it("recognizes exactly known unsupported optional fields", () => {
  expect(
    unsupportedOptionalField({ error: { type: "invalid_request_error", param: "stream_options" } }),
  ).toBe("stream_options");
  expect(
    unsupportedOptionalField({
      type: "validation_error",
      details: [{ loc: ["body", "metadata"] }],
    }),
  ).toBe("metadata");
  expect(unsupportedOptionalField({ message: "stream_options is unsupported" })).toBeUndefined();
  expect(
    unsupportedOptionalField({ error: { type: "invalid_request_error", param: "tools" } }),
  ).toBeUndefined();
  expect(unsupportedOptionalField(null)).toBeUndefined();
});
