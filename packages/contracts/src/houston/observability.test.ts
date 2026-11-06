import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HoustonObservabilityPreset, isAgentHost } from "./observability.ts";

const decode = Schema.decodeUnknownExit(HoustonObservabilityPreset);
const agent = (host: string) => decode({ _tag: "DatadogAgent", host, port: 4318 });

// Inputs that parse as a URL but would send traces to another host, or build a broken URL.
const REFUSED = [
  "a:b]@evil.com#[",
  "1:2]@evil.com/[::1",
  "::1]/x?[",
  "localhost:4318",
  "http://127.0.0.1",
  "127.0.0.1/v1",
  "agent local",
  "user@agent.local",
  "[::1]",
  "agent.local?x",
  " agent.local",
  "",
];
const ACCEPTED = ["127.0.0.1", "localhost", "Agent.Local", "dd-agent.internal", "::1", "fe80::1"];

describe("Datadog Agent host", () => {
  it("is a bare host name or IP address that http://<host> parses back to", () => {
    for (const host of REFUSED) expect(isAgentHost(host), host).toBe(false);
    for (const host of ACCEPTED) expect(isAgentHost(host), host).toBe(true);
  });

  it("is checked by the preset schema, with an error naming the value and the expected shape", () => {
    for (const host of ACCEPTED) expect(Exit.isSuccess(agent(host)), host).toBe(true);
    const refused = agent("a:b]@evil.com#[");
    expect(Exit.isFailure(refused)).toBe(true);
    const message = String(Exit.isFailure(refused) ? refused.cause : "");
    expect(message).toContain('"a:b]@evil.com#["');
    expect(message).toContain("host name or IP address");
  });
});
