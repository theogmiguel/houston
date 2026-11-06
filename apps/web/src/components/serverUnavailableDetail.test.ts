import { describe, expect, it } from "vite-plus/test";

import { PrimaryEnvironmentRequestError } from "../environments/primary/auth";
import { serverUnavailableDetail } from "./serverUnavailableDetail";

describe("serverUnavailableDetail", () => {
  it("names no HTTP status when the request got no response", () => {
    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause: new TypeError("Failed to fetch"),
    });
    expect(serverUnavailableDetail(error, "127.0.0.1:3773")).toBe(
      "Tried 127.0.0.1:3773 · PrimaryEnvironmentRequestError during fetch-session-state",
    );
  });

  it("omits the address when it could not be resolved", () => {
    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause: new TypeError("Failed to fetch"),
    });
    expect(serverUnavailableDetail(error, null)).toBe(
      "PrimaryEnvironmentRequestError during fetch-session-state",
    );
  });
});
