import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AcpRequestError } from "effect-acp/errors";

import { ProviderInstanceId } from "@houston-app/contracts";
import type * as AcpSessionRuntime from "@houston-app/provider-acp/server/AcpSessionRuntime";
import { deleteTemporaryAcpSession, normalizeAcpRegistryWebUrl } from "./probe.ts";

describe("normalizeAcpRegistryWebUrl", () => {
  it("keeps web URLs in their serialized form", () => {
    expect(normalizeAcpRegistryWebUrl("https://Example.test/login")).toBe(
      "https://example.test/login",
    );
    expect(normalizeAcpRegistryWebUrl("http://localhost:8080")).toBe("http://localhost:8080/");
  });

  it("refuses unparseable, non-web and oversized values", () => {
    expect(normalizeAcpRegistryWebUrl("not a url")).toBeUndefined();
    expect(normalizeAcpRegistryWebUrl("file:///etc/passwd")).toBeUndefined();
    expect(normalizeAcpRegistryWebUrl(`https://example.test/${"a".repeat(2_048)}`)).toBeUndefined();
  });
});

const probeStarted = (
  agentCapabilities: Record<string, unknown>,
): AcpSessionRuntime.AcpSessionRuntimeStartResult =>
  ({
    sessionId: "probe-session",
    initializeResult: { protocolVersion: 2, agentCapabilities, authMethods: [] },
    sessionSetupResult: { sessionId: "probe-session" },
    modelConfigId: undefined,
  }) as unknown as AcpSessionRuntime.AcpSessionRuntimeStartResult;

describe("deleteTemporaryAcpSession", () => {
  const instanceId = ProviderInstanceId.make("probe-test");
  const deleting = (deleted: string[], failure?: Error) => ({
    deleteSession: (sessionId: string) =>
      failure === undefined
        ? Effect.sync(() => {
            deleted.push(sessionId);
            return {};
          })
        : Effect.fail(
            new AcpRequestError({
              method: "session/delete",
              code: -32603,
              errorMessage: failure.message,
            }),
          ),
  });

  it.effect("deletes the session when the agent advertises deletion", () =>
    Effect.gen(function* () {
      const deleted: string[] = [];
      yield* deleteTemporaryAcpSession({
        runtime: deleting(deleted),
        started: probeStarted({ sessionCapabilities: { delete: {} } }),
        instanceId,
      });
      expect(deleted).toEqual(["probe-session"]);
    }),
  );

  it.effect("leaves the session when the agent does not advertise deletion", () =>
    Effect.gen(function* () {
      const deleted: string[] = [];
      yield* deleteTemporaryAcpSession({
        runtime: deleting(deleted),
        started: probeStarted({}),
        instanceId,
      });
      expect(deleted).toEqual([]);
    }),
  );

  it.effect("ignores a delete failure", () =>
    Effect.gen(function* () {
      const deleted: string[] = [];
      const result = yield* deleteTemporaryAcpSession({
        runtime: deleting(deleted, new Error("delete failed")),
        started: probeStarted({ sessionCapabilities: { delete: {} } }),
        instanceId,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Success");
      expect(deleted).toEqual([]);
    }),
  );
});
