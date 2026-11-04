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
  it("carries the box on a stand-in card and hides the chat until it is under way", () => {
    using _guard = motionGuard();
    const { root, cell, neighbour } = surface();
    animateMaximizeMorph(root, cell, HALF, FULL, true, [neighbour]);
    const card = root.querySelector<HTMLElement>("[data-grid-morph-card]");
    expect(card).not.toBeNull();
    expect(card!.getAnimations().length).toBe(2);
    // The chat itself never scales: only its opacity and a small rise animate.
    const [content] = cell.getAnimations();
    const keyframes = (content!.effect as KeyframeEffect).getKeyframes();
    expect(keyframes.map((frame) => Number(frame.opacity))).toEqual([0, 1]);
    expect(keyframes.some((frame) => String(frame.transform).includes("scale"))).toBe(false);
    expect(cell.dataset.maximizeMorph).toBe("");
    expect(neighbour.getAnimations().length).toBe(1);
  });

  it("removes the stand-in and hands the card back once it ends", async () => {
    using _guard = motionGuard();
    const { root, cell, neighbour } = surface();
    animateMaximizeMorph(root, cell, FULL, HALF, false, [neighbour]);
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
    const { root, cell, neighbour } = surface();
    animateMaximizeMorph(root, cell, HALF, FULL, true, [neighbour]);
    animateMaximizeMorph(root, cell, FULL, HALF, false, [neighbour]);
    expect(root.querySelectorAll("[data-grid-morph-card]").length).toBe(1);
    expect(neighbour.style.visibility).toBe("hidden");
    finishMaximizeMorph(root);
    expect(root.querySelector("[data-grid-morph-card]")).toBeNull();
  });

  it("snaps when motion is off", () => {
    using _guard = motionGuard();
    configureMotion({ off: true });
    const { root, cell, neighbour } = surface();
    animateMaximizeMorph(root, cell, HALF, FULL, true, [neighbour]);
    expect(root.querySelector("[data-grid-morph-card]")).toBeNull();
    expect(cell.getAnimations().length).toBe(0);
  });
});
