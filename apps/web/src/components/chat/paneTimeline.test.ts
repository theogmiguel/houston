import { describe, expect, it } from "vite-plus/test";

import { trimTimelineForDensity } from "./paneTimeline";

const entry = (kind: string, role?: string) => ({
  kind,
  ...(role === undefined ? {} : { message: { role } }),
});

const entries = [
  entry("message", "user"),
  entry("work"),
  entry("message", "assistant"),
  entry("message", "user"),
  entry("work"),
  entry("message", "assistant"),
];

describe("trimTimelineForDensity", () => {
  it("keeps the whole conversation in solo and comfortable panes", () => {
    expect(trimTimelineForDensity(entries, "solo")).toBe(entries);
    expect(trimTimelineForDensity(entries, "comfortable")).toBe(entries);
  });

  it("starts compact at the latest user turn", () => {
    expect(trimTimelineForDensity(entries, "compact")).toEqual(entries.slice(3));
  });

  it("keeps only the latest assistant message for a glance pane", () => {
    expect(trimTimelineForDensity(entries, "glance")).toEqual(entries.slice(5));
  });

  it("falls back to the tail when the density's role is absent", () => {
    const workOnly = [entry("work"), entry("work"), entry("work"), entry("work")];
    expect(trimTimelineForDensity(workOnly, "glance")).toEqual(workOnly.slice(-1));
    expect(trimTimelineForDensity(workOnly, "compact")).toEqual(workOnly.slice(-3));
  });
});
