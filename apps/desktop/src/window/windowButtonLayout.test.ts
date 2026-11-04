import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { normalizeWindowButtonLayout, readWindowButtonLayout } from "./windowButtonLayout.ts";

describe("normalizeWindowButtonLayout", () => {
  it("unquotes the value gsettings prints", () => {
    assert.strictEqual(
      normalizeWindowButtonLayout("'appmenu:minimize,maximize,close'\n"),
      "appmenu:minimize,maximize,close",
    );
  });

  it("treats an empty setting as no layout", () => {
    assert.isNull(normalizeWindowButtonLayout("''"));
    assert.isNull(normalizeWindowButtonLayout("   "));
  });

  it("passes an unquoted value through", () => {
    assert.strictEqual(normalizeWindowButtonLayout("close:minimize"), "close:minimize");
  });
});

describe("readWindowButtonLayout", () => {
  it.effect("reads the GNOME preference on Linux", () => {
    const run = vi.fn(async () => ({ status: 0, stdout: "'appmenu:close'\n" }));
    return readWindowButtonLayout("linux", run).pipe(
      Effect.tap((layout) => Effect.sync(() => assert.strictEqual(layout, "appmenu:close"))),
      Effect.tap(() => Effect.sync(() => assert.strictEqual(run.mock.calls.length, 1))),
    );
  });

  it.effect("reports null when the command fails", () => {
    const run = vi.fn(async (): Promise<never> => {
      throw new Error("gsettings: not found");
    });
    return readWindowButtonLayout("linux", run).pipe(
      Effect.tap((layout) => Effect.sync(() => assert.isNull(layout))),
    );
  });

  it.effect("reports null when gsettings exits unsuccessfully", () =>
    readWindowButtonLayout("linux", async () => ({ status: 1, stdout: "" })).pipe(
      Effect.tap((layout) => Effect.sync(() => assert.isNull(layout))),
    ),
  );

  it.effect("does not inspect other platforms", () => {
    const run = vi.fn(async () => ({ status: 0, stdout: "'minimize,close'" }));
    return readWindowButtonLayout("win32", run).pipe(
      Effect.tap((layout) => Effect.sync(() => assert.isNull(layout))),
      Effect.tap(() => Effect.sync(() => assert.strictEqual(run.mock.calls.length, 0))),
    );
  });
});
