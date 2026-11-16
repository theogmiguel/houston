import { describe, expect, it } from "vite-plus/test";

import { quickComposerEnterSubmits, quickComposerHint } from "./quickComposerKeys";

const enter = { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false };

describe("quickComposerEnterSubmits", () => {
  it.each([
    ["enter", "one line", false, true],
    ["enter", "two\nlines", false, true],
    ["mod-enter", "one line", false, false],
    ["mod-enter", "one line", true, true],
    ["mod-enter-multiline", "one line", false, true],
    ["mod-enter-multiline", "two\nlines", false, false],
    ["mod-enter-multiline", "two\nlines", true, true],
  ] as const)("honors %s for %j (ctrl %s)", (sendShortcut, prompt, ctrlKey, expected) => {
    expect(quickComposerEnterSubmits({ ...enter, ctrlKey }, sendShortcut, prompt)).toBe(expected);
  });

  it("never submits on Shift+Enter or another key", () => {
    expect(quickComposerEnterSubmits({ ...enter, shiftKey: true }, "enter", "x")).toBe(false);
    expect(quickComposerEnterSubmits({ ...enter, key: "a" }, "enter", "x")).toBe(false);
  });
});

describe("quickComposerHint", () => {
  it.each([
    ["enter", /^Enter starts the thread\./],
    ["mod-enter", /^Ctrl\/Cmd\+Enter starts the thread\. Enter adds a line\./],
    ["mod-enter-multiline", /Ctrl\/Cmd\+Enter/],
  ] as const)("describes %s", (sendShortcut, expected) => {
    expect(quickComposerHint(sendShortcut)).toMatch(expected);
  });
});
