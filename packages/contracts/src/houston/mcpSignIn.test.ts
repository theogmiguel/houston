import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationV2TurnItem, OrchestrationV2TurnItemJson } from "../orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "../rpc.ts";
import {
  HOUSTON_MCP_SERVER_NAME_MAX_LENGTH,
  HoustonMcpSignInCompleteInput,
  HoustonMcpSignInCompleteResult,
  HoustonMcpSignInError,
  HoustonMcpSignInStartInput,
  HoustonMcpSignInStartResult,
} from "./mcpSignIn.ts";

const base = {
  id: "turn-item:notice:1",
  threadId: "thread:1",
  runId: "run:1",
  nodeId: "node:1",
  providerThreadId: "provider-thread:1",
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: "2026-10-29T12:00:00.000Z",
  completedAt: "2026-10-29T12:00:00.000Z",
  updatedAt: "2026-10-29T12:00:00.000Z",
  createdBy: "provider",
  creationSource: "provider",
  type: "system_notice",
  message: "The notion MCP server needs you to sign in.",
};

const decodeTurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

describe("system_notice mcpSignIn", () => {
  const decodeJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
  const encodeJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
  const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
  const encodeItem = Schema.encodeSync(OrchestrationV2TurnItem);

  it("round-trips the server name on both the wire and the stored shape", () => {
    const stored = decodeJson({ ...base, mcpSignIn: { server: "notion" } }) as {
      mcpSignIn?: unknown;
    };
    expect(stored.mcpSignIn).toEqual({ server: "notion" });
    const wire = decodeItem(encodeItem(stored as never)) as { mcpSignIn?: unknown };
    expect(wire.mcpSignIn).toEqual({ server: "notion" });
    expect((encodeJson(stored as never) as { mcpSignIn?: unknown }).mcpSignIn).toEqual({
      server: "notion",
    });
  });

  it("still decodes a notice stored without it", () => {
    const stored = decodeJson(base) as { mcpSignIn?: unknown };
    expect(stored.mcpSignIn).toBeUndefined();
    expect(
      (decodeItem(encodeItem(stored as never)) as { mcpSignIn?: unknown }).mcpSignIn,
    ).toBeUndefined();
  });

  it("refuses a server name above the bound", () => {
    const tooLong = {
      ...base,
      mcpSignIn: { server: "x".repeat(HOUSTON_MCP_SERVER_NAME_MAX_LENGTH + 1) },
    };
    expect(() => decodeTurnItemJson(tooLong)).toThrow();
  });
});

describe("MCP sign-in RPC contracts", () => {
  const ids = { threadId: "thread:1", providerThreadId: "provider-thread:1", server: "notion" };

  it("registers both methods under the houston namespace", () => {
    expect(WS_METHODS.houstonMcpSignInStart).toBe("houston.mcpSignIn.start");
    expect(WS_METHODS.houstonMcpSignInComplete).toBe("houston.mcpSignIn.complete");
    expect(WsRpcGroup.requests.has(WS_METHODS.houstonMcpSignInStart)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.houstonMcpSignInComplete)).toBe(true);
  });

  it("accepts a start input and refuses an empty or over-long server", () => {
    const decode = Schema.decodeUnknownSync(HoustonMcpSignInStartInput);
    expect(decode(ids).server).toBe("notion");
    expect(() => decode({ ...ids, server: "  " })).toThrow();
    expect(() =>
      decode({ ...ids, server: "x".repeat(HOUSTON_MCP_SERVER_NAME_MAX_LENGTH + 1) }),
    ).toThrow();
  });

  it("start returns a page or a signed-in time, never both required", () => {
    const decode = Schema.decodeUnknownSync(HoustonMcpSignInStartResult);
    expect(
      decode({ authorizationUrl: "https://auth.example.com/a", signedInAt: null }),
    ).toBeDefined();
    expect(
      decode({ authorizationUrl: null, signedInAt: "2026-10-29T12:00:00.000Z" }),
    ).toBeDefined();
    expect(() => decode({ authorizationUrl: "javascript:alert(1)", signedInAt: null })).toThrow();
  });

  it("complete takes the pasted address and returns only a timestamp", () => {
    const decodeInput = Schema.decodeUnknownSync(HoustonMcpSignInCompleteInput);
    expect(
      decodeInput({ ...ids, callbackUrl: "http://127.0.0.1:1/cb?code=a&state=b" }),
    ).toBeDefined();
    expect(() => decodeInput({ ...ids, callbackUrl: "" })).toThrow();
    expect(Object.keys(HoustonMcpSignInCompleteResult.fields)).toEqual(["signedInAt"]);
  });

  it("carries no cause on the error", () => {
    const error = new HoustonMcpSignInError({
      kind: "session-ended",
      server: "notion",
      message: "ended",
    });
    expect(Object.keys(error)).not.toContain("cause");
  });
});
