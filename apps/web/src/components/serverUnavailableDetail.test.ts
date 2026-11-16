import { describe, expect, it } from "vite-plus/test";

import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { PrimaryEnvironmentRequestError } from "../environments/primary/auth";
import { serverUnavailableDetail, serverUnavailableOutcome } from "./serverUnavailableDetail";

const unreachable = () =>
  PrimaryEnvironmentRequestError.fromCause({
    operation: "fetch-session-state",
    cause: new TypeError("Failed to fetch"),
  });

const answered = (status: number) => {
  const request = HttpClientRequest.get("http://localhost:10443/api/auth/session");
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: HttpClientResponse.fromWeb(request, new Response(null, { status })),
    }),
  });
};

describe("serverUnavailableDetail", () => {
  it("reads as a sentence naming the host when the request got no response", () => {
    expect(serverUnavailableDetail(unreachable(), "localhost:10443")).toBe(
      "Couldn't reach the server at localhost:10443.",
    );
  });

  it("omits the address when it could not be resolved", () => {
    expect(serverUnavailableDetail(unreachable(), null)).toBe("Couldn't reach the server.");
  });

  it("names the HTTP status when the server answered", () => {
    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause: answered(503),
    });
    expect(serverUnavailableDetail(error, "localhost:10443")).toBe(
      "The server at localhost:10443 answered HTTP 503.",
    );
    expect(serverUnavailableDetail(error, null)).toBe("The server answered HTTP 503.");
  });
});

describe("serverUnavailableOutcome", () => {
  it("keeps the error tag and operation for the log", () => {
    expect(serverUnavailableOutcome(unreachable())).toBe(
      "PrimaryEnvironmentRequestError during fetch-session-state",
    );
  });
});
