import { assert, describe, it } from "@effect/vitest";

import {
  decideServerAttachment,
  type PersistedServerRuntimeState,
} from "./DesktopServerAttachment.ts";

const CURRENT_VERSION = "0.1.6";

const record = (
  overrides: Partial<PersistedServerRuntimeState> = {},
): PersistedServerRuntimeState => ({
  version: 1,
  pid: 4242,
  port: 3773,
  origin: "http://127.0.0.1:3773",
  serverVersion: CURRENT_VERSION,
  ...overrides,
});

describe("decideServerAttachment", () => {
  it("starts a server when no runtime record exists", () => {
    assert.deepStrictEqual(
      decideServerAttachment({
        record: null,
        processAlive: false,
        healthy: false,
        currentServerVersion: CURRENT_VERSION,
      }),
      { _tag: "NoRecord" },
    );
  });

  it("starts a server when the recorded pid is dead", () => {
    assert.deepStrictEqual(
      decideServerAttachment({
        record: record(),
        processAlive: false,
        healthy: true,
        currentServerVersion: CURRENT_VERSION,
      }),
      { _tag: "Dead", pid: 4242 },
    );
  });

  it("refuses a live server that does not answer its health endpoint", () => {
    assert.deepStrictEqual(
      decideServerAttachment({
        record: record(),
        processAlive: true,
        healthy: false,
        currentServerVersion: CURRENT_VERSION,
      }),
      { _tag: "Unhealthy", pid: 4242, origin: "http://127.0.0.1:3773" },
    );
  });

  it("attaches to a live, healthy server of the same version", () => {
    assert.deepStrictEqual(
      decideServerAttachment({
        record: record(),
        processAlive: true,
        healthy: true,
        currentServerVersion: CURRENT_VERSION,
      }),
      {
        _tag: "Attach",
        pid: 4242,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        serverVersion: CURRENT_VERSION,
        versionSkew: false,
      },
    );
  });

  it("attaches across a version skew instead of replacing a server it does not own", () => {
    assert.deepStrictEqual(
      decideServerAttachment({
        record: record({ serverVersion: "0.0.9" }),
        processAlive: true,
        healthy: true,
        currentServerVersion: CURRENT_VERSION,
      }),
      {
        _tag: "Attach",
        pid: 4242,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        serverVersion: "0.0.9",
        versionSkew: true,
      },
    );
  });

  it("treats a record without a version as skewed", () => {
    const decision = decideServerAttachment({
      record: { version: 1, pid: 4242, port: 3773, origin: "http://127.0.0.1:3773" },
      processAlive: true,
      healthy: true,
      currentServerVersion: CURRENT_VERSION,
    });
    assert.strictEqual(decision._tag, "Attach");
    if (decision._tag === "Attach") {
      assert.isNull(decision.serverVersion);
      assert.isTrue(decision.versionSkew);
    }
  });

  it("refuses an origin that is not HTTP", () => {
    assert.deepStrictEqual(
      decideServerAttachment({
        record: record({ origin: "file:///tmp/server" }),
        processAlive: true,
        healthy: true,
        currentServerVersion: CURRENT_VERSION,
      }),
      { _tag: "InvalidOrigin", pid: 4242, origin: "file:///tmp/server" },
    );
  });
});
