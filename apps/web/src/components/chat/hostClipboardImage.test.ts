import { describe, expect, it } from "@effect/vitest";

import { isClipboardImagePaste } from "./hostClipboardImage";

function clipboardData(input: {
  readonly files?: File[];
  readonly data?: Record<string, string>;
}): DataTransfer {
  return {
    files: input.files ?? [],
    types: Object.keys(input.data ?? {}),
    getData: (type: string) => input.data?.[type] ?? "",
  } as unknown as DataTransfer;
}

describe("isClipboardImagePaste", () => {
  it("reads the host clipboard for an empty image paste", () => {
    expect(isClipboardImagePaste(clipboardData({}))).toBe(true);
  });

  it("reads the host clipboard when only an image type is advertised", () => {
    expect(isClipboardImagePaste(clipboardData({ data: { "image/png": "" } }))).toBe(true);
  });

  it("reads the host clipboard for a browser's image-only HTML copy", () => {
    expect(
      isClipboardImagePaste(
        clipboardData({
          data: {
            "text/plain": "",
            "text/html": '<meta charset="utf-8"><img src="https://example.com/cat.png" alt="cat">',
          },
        }),
      ),
    ).toBe(true);
  });

  it("still reads the host clipboard when the engine refuses an unadvertised flavor", () => {
    const data = {
      files: [],
      types: [],
      getData: () => {
        throw new Error("flavor not advertised");
      },
    } as unknown as DataTransfer;

    expect(isClipboardImagePaste(data)).toBe(true);
  });

  it("keeps plain text with the editor", () => {
    expect(isClipboardImagePaste(clipboardData({ data: { "text/plain": "hello" } }))).toBe(false);
  });

  it("keeps rich text that has visible content with the editor", () => {
    expect(
      isClipboardImagePaste(clipboardData({ data: { "text/html": "<p>Hello <b>there</b></p>" } })),
    ).toBe(false);
  });

  it("keeps a paste whose webview already exposed the image file", () => {
    const image = new File(["png"], "cat.png", { type: "image/png" });
    expect(isClipboardImagePaste(clipboardData({ files: [image] }))).toBe(false);
  });
});
