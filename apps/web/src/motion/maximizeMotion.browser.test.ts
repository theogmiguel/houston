import { describe, expect, it, vi } from "vite-plus/test";

import { animateMaximizeMorph, finishMaximizeMorph } from "./maximizeMotion";
import { configureMotion } from "./registry";

function surface(): { root: HTMLElement; cell: HTMLElement; neighbour: HTMLElement } {
  const root = document.createElement("div");
  root.style.cssText = "position:relative;width:600px;height:300px";
  const frame = document.createElement("div");
  frame.style.cssText = "position:absolute;left:0;top:0;width:600px;height:300px";
  const cell = document.createElement("div");
  cell.dataset.gridCell = "";
  frame.append(cell);
  const neighbour = document.createElement("div");
  neighbour.style.cssText = "position:absolute;left:300px;top:0;width:300px;height:300px";
  root.append(frame, neighbour);
  document.body.append(root);
  return { root, cell, neighbour };
}

function motionGuard() {
  return {
    [Symbol.dispose]: () => {
      configureMotion({ off: false });
      document.body.replaceChildren();
    },
  };
}

const HALF = { x: 0, y: 0, width: 300, height: 300 };
const FULL = { x: 0, y: 0, width: 600, height: 300 };

describe("grid maximize morph", () => {
  it("carries the box on a stand-in card and never blanks the chat", () => {
    using _guard = motionGuard();
    const { root, cell, neighbour } = surface();
    animateMaximizeMorph(root, cell, HALF, FULL, true);
    const card = root.querySelector<HTMLElement>("[data-grid-morph-card]");
    expect(card).not.toBeNull();
    expect(card!.getAnimations().length).toBe(2);
    // Only the card moves: the chat is laid out at its new size and shows from the first frame.
    expect(cell.getAnimations().length).toBe(0);
    expect(getComputedStyle(cell).opacity).toBe("1");
    expect(cell.dataset.maximizeMorph).toBe("");
    expect(neighbour.getAnimations().length).toBe(0);
  });

  it("shows the neighbours from the first frame of a restore", () => {
    using _guard = motionGuard();
    const { root, cell, neighbour } = surface();
    animateMaximizeMorph(root, cell, FULL, HALF, false);
    expect(root.querySelector("[data-grid-morph-card]")).not.toBeNull();
    expect(neighbour.getAnimations().length).toBe(0);
    expect(cell.getAnimations().length).toBe(0);
    expect(getComputedStyle(neighbour).opacity).toBe("1");
  });

  it("removes the stand-in and hands the card back once it ends", async () => {
    using _guard = motionGuard();
    const { root, cell } = surface();
    animateMaximizeMorph(root, cell, FULL, HALF, false);
    const animations = root.getAnimations({ subtree: true });
    for (const animation of animations) animation.finish();
    await vi.waitFor(() => {
      expect(root.querySelector("[data-grid-morph-card]")).toBeNull();
      expect(cell.dataset.maximizeMorph).toBeUndefined();
      expect(root.dataset.maximizeMorph).toBeUndefined();
    });
  });

  it("settles a running morph before starting the next one", () => {
    using _guard = motionGuard();
    const { root, cell } = surface();
    animateMaximizeMorph(root, cell, HALF, FULL, true);
    animateMaximizeMorph(root, cell, FULL, HALF, false);
    expect(root.querySelectorAll("[data-grid-morph-card]").length).toBe(1);
    finishMaximizeMorph(root);
    expect(root.querySelector("[data-grid-morph-card]")).toBeNull();
  });

  it("snaps when motion is off", () => {
    using _guard = motionGuard();
    configureMotion({ off: true });
    const { root, cell } = surface();
    animateMaximizeMorph(root, cell, HALF, FULL, true);
    expect(root.querySelector("[data-grid-morph-card]")).toBeNull();
    expect(cell.getAnimations().length).toBe(0);
  });
});
