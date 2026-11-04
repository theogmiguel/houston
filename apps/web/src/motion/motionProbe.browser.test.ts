import { describe, expect, it, vi } from "vite-plus/test";

import { installMotionProbe } from "./motionProbe";

describe("motion probe", () => {
  it("records a burst of motion by surface, ignoring colour-only transitions", async () => {
    installMotionProbe();
    window.__houstonMotionEpisodes = [];
    const box = document.createElement("div");
    box.dataset.slot = "probe-box";
    box.style.cssText =
      "width:40px;height:40px;opacity:1;color:black;transition:opacity 60ms linear,color 60ms linear";
    document.body.append(box);
    using _cleanup = { [Symbol.dispose]: () => box.remove() };
    box.getBoundingClientRect();
    box.style.opacity = "0";
    box.style.color = "red";
    await vi.waitFor(() => expect(window.__houstonMotionEpisodes?.length).toBe(1));
    const [episode] = window.__houstonMotionEpisodes!;
    expect(episode!.surfaces).toBe("probe-box");
    expect(episode!.properties).toBe("opacity");
    expect(episode!.frames).toBeGreaterThan(0);
  });
});
