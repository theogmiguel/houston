import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@houston-app/shared/composerContextClipboard";

import { readTextFromClipboard, writeTextToClipboard } from "./useCopyToClipboard";

describe("writeTextToClipboard", () => {
  it("reserves plain text even when an extra flavor attempts to replace it", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    await expect(
      writeTextToClipboard("original", "message", {
        "text/plain": "replacement",
        "text/html": "<b>original</b>",
      }),
    ).resolves.toBe(true);
    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    expect(await items[0]!.data["text/plain"]!.text()).toBe("original");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps caller-built rich HTML when attaching a context fragment", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    const fragment = JSON.stringify({ version: 1, source: {}, records: [] });
    const rich = "<p><strong>Message</strong></p>";

    await expect(
      writeTextToClipboard("Message", "message", {
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment,
        "text/html": rich,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    const html = await items[0]!.data["text/html"]!.text();
    expect(html).toContain(rich);
    expect(html).toContain("data-houston-context-fragment=");
  });
});

describe("readTextFromClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads through navigator.clipboard when it is available", async () => {
    const readText = vi.fn().mockResolvedValue("native");
    const readClipboardText = vi.fn().mockResolvedValue("host");
    vi.stubGlobal("window", { hostBridge: { readClipboardText } });
    vi.stubGlobal("navigator", { clipboard: { readText } });

    await expect(readTextFromClipboard("terminal input")).resolves.toBe("native");
    expect(readClipboardText).not.toHaveBeenCalled();
  });

  it("falls back to the host when WebKitGTK refuses the browser read", async () => {
    const readText = vi.fn().mockRejectedValue(new Error("not allowed"));
    const readClipboardText = vi.fn().mockResolvedValue("host");
    vi.stubGlobal("window", { hostBridge: { readClipboardText } });
    vi.stubGlobal("navigator", { clipboard: { readText } });

    await expect(readTextFromClipboard("terminal input")).resolves.toBe("host");
    expect(readClipboardText).toHaveBeenCalledTimes(1);
  });

  it("uses the host when the browser exposes no clipboard reader", async () => {
    const readClipboardText = vi.fn().mockResolvedValue("host");
    vi.stubGlobal("window", { hostBridge: { readClipboardText } });
    vi.stubGlobal("navigator", {});

    await expect(readTextFromClipboard("terminal input")).resolves.toBe("host");
  });

  it("names the missing reader when neither path is available", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    await expect(readTextFromClipboard("terminal input")).rejects.toThrow(/unavailable/);
  });
});
