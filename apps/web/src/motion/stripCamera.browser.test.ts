import { describe, expect, it } from "vite-plus/test";

import {
  endUserStripScroll,
  moveStripCamera,
  noteUserStripScroll,
  settleStripCamera,
  stripCameraPosition,
  userStripScrollAge,
} from "./stripCamera";
import { configureMotion } from "./registry";

function mountStrip() {
  const scroller = document.createElement("div");
  scroller.style.cssText = "width:400px;height:200px;overflow-x:scroll;overflow-y:hidden";
  const stage = document.createElement("div");
  stage.style.cssText = "width:2000px;height:200px";
  scroller.append(stage);
  document.body.append(scroller);
  return {
    scroller,
    stage,
    [Symbol.dispose]: () => {
      settleStripCamera();
      endUserStripScroll();
      configureMotion({ off: false });
      scroller.remove();
    },
  };
}

describe("moveStripCamera", () => {
  it("lands the scroller on the target at once and animates the stage back to rest", () => {
    using strip = mountStrip();
    moveStripCamera(strip.scroller, strip.stage, 600);
    expect(strip.scroller.scrollLeft).toBe(600);
    expect(strip.stage.getAnimations()).toHaveLength(1);
    expect(stripCameraPosition(strip.scroller)).toBeLessThan(600);
  });

  it("moves without animating when motion is off", () => {
    using strip = mountStrip();
    configureMotion({ off: true });
    moveStripCamera(strip.scroller, strip.stage, 300);
    expect(strip.scroller.scrollLeft).toBe(300);
    expect(strip.stage.getAnimations()).toHaveLength(0);
    expect(stripCameraPosition(strip.scroller)).toBe(300);
  });

  it("clamps a target past the end of the strip to where the browser lands", () => {
    using strip = mountStrip();
    configureMotion({ off: true });
    moveStripCamera(strip.scroller, strip.stage, 99_999);
    expect(strip.scroller.scrollLeft).toBe(1600);
  });

  it("drops outside scroll writes while a camera move owns the strip", () => {
    using strip = mountStrip();
    moveStripCamera(strip.scroller, strip.stage, 600);
    strip.scroller.scrollLeft = 10;
    expect(strip.scroller.scrollLeft).toBe(600);
  });

  it("takes the in-between position when settled, so the next input carries on from the eye", () => {
    using strip = mountStrip();
    moveStripCamera(strip.scroller, strip.stage, 600);
    const shown = stripCameraPosition(strip.scroller);
    settleStripCamera();
    expect(strip.stage.getAnimations()).toHaveLength(0);
    expect(strip.scroller.scrollLeft).toBeCloseTo(shown, 0);
    strip.scroller.scrollLeft = 20;
    expect(strip.scroller.scrollLeft).toBe(20);
  });
});

describe("user strip scroll", () => {
  it("ages from the last user scroll and ends with a camera move", () => {
    using strip = mountStrip();
    expect(userStripScrollAge()).toBeGreaterThan(1e6);
    noteUserStripScroll();
    expect(userStripScrollAge()).toBeLessThan(1000);
    configureMotion({ off: true });
    moveStripCamera(strip.scroller, strip.stage, 100);
    expect(userStripScrollAge()).toBeGreaterThan(1e6);
  });

  it("ends when the user's scroll was handled", () => {
    using _strip = mountStrip();
    noteUserStripScroll();
    endUserStripScroll();
    expect(userStripScrollAge()).toBeGreaterThan(1e6);
  });
});
