import { describe, expect, it, vi } from "vite-plus/test";

import { animateCellMove, cancelCellMoves, measureCells } from "./paneMotion";
import { configureMotion } from "./registry";

function surface(): { root: HTMLElement; a: HTMLElement; b: HTMLElement } {
  const root = document.createElement("div");
  root.style.cssText = "position:relative;width:600px;height:300px;display:flex";
  const a = document.createElement("div");
  a.dataset.gridCell = "";
  a.dataset.threadId = "thread-a";
  a.style.cssText = "position:absolute;left:0;top:0;width:300px;height:300px";
  const b = document.createElement("div");
  b.dataset.gridCell = "";
  b.dataset.threadId = "thread-b";
  b.style.cssText = "position:absolute;left:300px;top:0;width:300px;height:300px";
  root.append(a, b);
  document.body.append(root);
  return { root, a, b };
}

function motionGuard() {
  return {
    [Symbol.dispose]: () => {
      configureMotion({ off: false });
      document.body.replaceChildren();
    },
  };
}

describe("grid cell FLIP", () => {
  it("measures each cell's offset inside the surface", () => {
    using _guard = motionGuard();
    const { root } = surface();
    const cells = measureCells(root);
    expect(cells.get("thread-a")).toMatchObject({ x: 0, y: 0 });
    expect(cells.get("thread-b")).toMatchObject({ x: 300, y: 0 });
  });

  it("translates a cell from its old place and clears the transform after", async () => {
    using _guard = motionGuard();
    const { root, a, b } = surface();
    const before = measureCells(root);
    a.style.left = "300px";
    b.style.left = "0px";
    animateCellMove(root, before);
    expect(a.getAnimations().length).toBe(1);
    expect(b.getAnimations().length).toBe(1);
    const animations = [...a.getAnimations(), ...b.getAnimations()];
    await Promise.all(animations.map((animation) => animation.finished));
    await vi.waitFor(() => {
      expect(a.style.transform).toBe("");
    });
  });

  it("leaves the surface's attributes alone while cells move", () => {
    using _guard = motionGuard();
    const { root, a, b } = surface();
    const before = measureCells(root);
    const attributes = [...root.attributes].map((attribute) => `${attribute.name}=${attribute.value}`);
    a.style.left = "300px";
    b.style.left = "0px";
    animateCellMove(root, before);
    expect(a.getAnimations().length).toBe(1);
    // Any style change on the surface restyles every cell's chat on the first and last frame.
    expect([...root.attributes].map((attribute) => `${attribute.name}=${attribute.value}`)).toEqual(
      attributes,
    );
  });

  it("does nothing under reduced motion", () => {
    using _guard = motionGuard();
    configureMotion({ off: true });
    const { root, a, b } = surface();
    const before = measureCells(root);
    a.style.left = "300px";
    b.style.left = "0px";
    animateCellMove(root, before);
    expect(a.getAnimations().length).toBe(0);
  });

  it("cancels moves when the surface goes away", () => {
    using _guard = motionGuard();
    const { root, a, b } = surface();
    const before = measureCells(root);
    a.style.left = "300px";
    b.style.left = "0px";
    animateCellMove(root, before);
    cancelCellMoves(root);
    expect(a.getAnimations().length).toBe(0);
  });
});
