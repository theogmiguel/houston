import { describe, expect, it } from "vite-plus/test";

import { relabelDiffSeparators, separatorLabel } from "./diffSeparatorLabels";

function containerWith(...texts: string[]): HTMLElement {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  for (const text of texts) {
    const span = document.createElement("span");
    span.setAttribute("data-unmodified-lines", "");
    span.textContent = text;
    root.append(span);
  }
  return host;
}

const labels = (host: HTMLElement) =>
  [...host.shadowRoot!.querySelectorAll("[data-unmodified-lines]")].map((e) => e.textContent);

describe("separatorLabel", () => {
  it("names the action with the count when it is known", () => {
    expect(separatorLabel(12)).toBe("Show 12 more lines");
    expect(separatorLabel(1)).toBe("Show 1 more line");
  });

  it("names the control when the count is unknown", () => {
    expect(separatorLabel(null)).toBe("Expand context");
  });
});

describe("relabelDiffSeparators", () => {
  it("rewrites both statements the viewer produces", () => {
    const host = containerWith(
      "18 unmodified lines",
      "1 unmodified line",
      "More unchanged context may be available",
    );
    relabelDiffSeparators(host);
    expect(labels(host)).toEqual(["Show 18 more lines", "Show 1 more line", "Expand context"]);
  });

  it("is idempotent and leaves unrecognised text alone", () => {
    const host = containerWith("18 unmodified lines", "something else");
    relabelDiffSeparators(host);
    relabelDiffSeparators(host);
    expect(labels(host)).toEqual(["Show 18 more lines", "something else"]);
  });
});
