import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginLayoutResize,
  endLayoutResize,
  isLayoutResizing,
  onLayoutResizeEnd,
  resetLayoutResizeForTest,
} from "./layoutResize";

afterEach(() => resetLayoutResizeForTest());

describe("layout resize", () => {
  it("stays active until the last resize ends", () => {
    beginLayoutResize();
    beginLayoutResize();
    endLayoutResize();
    expect(isLayoutResizing()).toBe(true);
    endLayoutResize();
    expect(isLayoutResizing()).toBe(false);
  });

  it("tells surfaces once, on the release", () => {
    const listener = vi.fn();
    const stop = onLayoutResizeEnd(listener);
    beginLayoutResize();
    endLayoutResize();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    beginLayoutResize();
    endLayoutResize();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores an end without a start", () => {
    const listener = vi.fn();
    const stop = onLayoutResizeEnd(listener);
    endLayoutResize();
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});
