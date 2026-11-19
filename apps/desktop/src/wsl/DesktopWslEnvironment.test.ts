import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { ManagedPolicyFileError } from "@houston-app/shared/managedPolicyFile";

import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import { makeIsAvailable, parseResolvedPath, parseWslUserHome } from "./DesktopWslEnvironment.ts";

describe("parseResolvedPath", () => {
  it("preserves spaces and apostrophes in the resolved login-shell PATH", () => {
    const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
    expect(parseResolvedPath(`nodePath:/usr/bin/node\nresolvedPath:${resolvedPath}\n`)).toBe(
      resolvedPath,
    );
  });

  it("accepts CRLF output without retaining the carriage return", () => {
    expect(parseResolvedPath("resolvedPath:/usr/local/bin:/usr/bin\r\n")).toBe(
      "/usr/local/bin:/usr/bin",
    );
  });
});

describe("parseWslUserHome", () => {
  it("accepts an absolute Linux home", () => {
    expect(parseWslUserHome("/home/theo")).toEqual({ ok: true, home: "/home/theo" });
  });

  it("names a home that is not absolute", () => {
    const result = parseWslUserHome(String.raw`C:\Users\theo`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(JSON.stringify(String.raw`C:\Users\theo`));
  });

  it("names a home that contains a control character", () => {
    for (const raw of ["/home/theo\n", "/home/theo\0", "/home/theo\r"]) {
      const result = parseWslUserHome(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(JSON.stringify(raw));
    }
  });

  it("rejects an empty home", () => {
    expect(parseWslUserHome("").ok).toBe(false);
  });
});

// Path.layer joins with POSIX separators here, so the test windir is a POSIX path.
const WSL_EXE = "/windows/System32/wsl.exe";

const isAvailable = (policy?: Parameters<typeof DesktopManagedPolicy.layerTest>[0]) =>
  makeIsAvailable("win32", "/windows").pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: (path) => Effect.succeed(path === WSL_EXE) }),
        Path.layer,
        DesktopManagedPolicy.layerTest(policy),
      ),
    ),
  );

describe("makeIsAvailable", () => {
  it.effect("turns WSL off on a machine with a managed policy, even an invalid one", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* isAvailable());
      assert.isFalse(yield* isAvailable({ schemaVersion: 1, organization: "Example Corp" }));
      assert.isFalse(
        yield* isAvailable(new ManagedPolicyFileError({ path: "/test", reason: "bad JSON" })),
      );
    }),
  );
});
