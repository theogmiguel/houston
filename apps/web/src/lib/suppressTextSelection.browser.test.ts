import { describe, expect, it } from "vite-plus/test";

import { suppressTextSelection } from "./suppressTextSelection";

/** A style object that keeps only what was set under each spelling. */
function recordingElement(): { element: HTMLElement; set: Map<string, string> } {
  const set = new Map<string, string>();
  const style = {
    getPropertyValue: (property: string) => set.get(property) ?? "",
    setProperty: (property: string, value: string) => void set.set(property, value),
    removeProperty: (property: string) => {
      set.delete(property);
      return "";
    },
  } as unknown as CSSStyleDeclaration;
  const element = { style, ownerDocument: document } as unknown as HTMLElement;
  return { element, set };
}

describe("suppressTextSelection", () => {
  it("sets the prefixed property and restores both", () => {
    const { element, set } = recordingElement();
    const release = suppressTextSelection(element);
    expect(set.get("-webkit-user-select")).toBe("none");
    expect(set.get("user-select")).toBe("none");
    release();
    expect(set.size).toBe(0);
  });

  it("restores values that were already set", () => {
    const { element, set } = recordingElement();
    set.set("-webkit-user-select", "text");
    const release = suppressTextSelection(element);
    release();
    expect(set.get("-webkit-user-select")).toBe("text");
    expect(set.has("user-select")).toBe(false);
  });

  it("clears a selection the press already painted", () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "selected before the drag";
    document.body.append(paragraph);
    document.getSelection()?.selectAllChildren(paragraph);
    const release = suppressTextSelection(document.body);
    expect(document.getSelection()?.toString()).toBe("");
    release();
    paragraph.remove();
  });
});
