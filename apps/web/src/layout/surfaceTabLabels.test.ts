import { ThreadId, type PreviewSessionSnapshot } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "../rightPanelStore";
import { surfaceTabTitle, terminalTabTitle } from "./surfaceTabLabels";

const browser = (resourceId: string | null): RightPanelSurface =>
  resourceId === null
    ? { id: "browser:new", kind: "preview", resourceId: null }
    : { id: `browser:${resourceId}`, kind: "preview", resourceId };

const snapshot = (navStatus: unknown) => ({ navStatus }) as unknown as PreviewSessionSnapshot;

describe("terminalTabTitle", () => {
  it("shows the command a terminal runs", () => {
    expect(terminalTabTitle("term-1", "Terminal 1 · pnpm dev")).toBe("pnpm dev");
  });

  it("falls back to Terminal when the label is the default or missing", () => {
    expect(terminalTabTitle("term-1", "Terminal 1")).toBe("Terminal");
    expect(terminalTabTitle("term-1", undefined)).toBe("Terminal");
  });
});

describe("surfaceTabTitle", () => {
  it("names fixed surfaces", () => {
    expect(surfaceTabTitle({ id: "diff", kind: "diff" }, null)).toBe("Diff");
    expect(surfaceTabTitle({ id: "files", kind: "files" }, null)).toBe("Files");
    expect(surfaceTabTitle({ id: "pull-requests", kind: "pull-requests" }, null)).toBe(
      "Pull requests",
    );
    expect(
      surfaceTabTitle({ id: "side-chat:t", kind: "side-chat", threadId: ThreadId.make("t") }, null),
    ).toBe("Side chat");
  });

  it("names a file by its last path segment on either separator", () => {
    const file = (relativePath: string): RightPanelSurface => ({
      id: `file:${relativePath}`,
      kind: "file",
      relativePath,
      revealLine: null,
      revealRequestId: 0,
    });
    expect(surfaceTabTitle(file("src/a/b.ts"), null)).toBe("b.ts");
    expect(surfaceTabTitle(file("src\\a\\c.ts"), null)).toBe("c.ts");
    expect(surfaceTabTitle(file("d.ts"), null)).toBe("d.ts");
  });

  it("names a task by its key, which the right panel's own tab also shows", () => {
    expect(
      surfaceTabTitle({ id: "task:e:k", kind: "task", environmentId: "e", taskKey: "ABC-1" }, null),
    ).toBe("ABC-1");
  });

  it("names a pull request by its number", () => {
    expect(
      surfaceTabTitle(
        {
          id: "pull-request:r#7",
          kind: "pull-request",
          projectId: "p",
          repository: "o/r",
          number: 7,
        },
        null,
      ),
    ).toBe("#7");
  });

  it("names a browser by its page title, then its host, then Browser (a session with no page yet)", () => {
    expect(
      surfaceTabTitle(
        browser("1"),
        snapshot({ _tag: "Loaded", title: "Docs", url: "https://x.dev/p" }),
      ),
    ).toBe("Docs");
    expect(
      surfaceTabTitle(browser("1"), snapshot({ _tag: "Loaded", title: " ", url: "https://x.dev/p" })),
    ).toBe("x.dev");
    expect(surfaceTabTitle(browser("1"), snapshot({ _tag: "Idle" }))).toBe("Browser");
    expect(surfaceTabTitle(browser(null), null)).toBe("Browser");
    expect(
      surfaceTabTitle(browser("1"), snapshot({ _tag: "Loaded", title: "", url: "not a url" })),
    ).toBe("Browser");
  });

  it("names a device by its title, then its target, then Device", () => {
    expect(surfaceTabTitle({ id: "device", kind: "device", title: "Pixel" }, null)).toBe("Pixel");
    expect(
      surfaceTabTitle(
        {
          id: "device:a",
          kind: "device",
          target: { hostId: "h", deviceId: "d", name: "iPhone", platform: "ios" },
        } as RightPanelSurface,
        null,
      ),
    ).toBe("iPhone");
    expect(surfaceTabTitle({ id: "device", kind: "device" }, null)).toBe("Device");
  });
});
