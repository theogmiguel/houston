import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ComposerSurface } from "./ComposerSurface";

function shadowToken(): string {
  const probe = document.createElement("div");
  probe.className = "shadow-composer";
  document.body.append(probe);
  const shadow = getComputedStyle(probe).boxShadow;
  probe.remove();
  return shadow;
}

describe("ComposerSurface.Main", () => {
  it("draws a 1px border and the composer shadow in both palettes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      using _reset = { [Symbol.dispose]: () => document.documentElement.classList.remove("dark") };
      await using screen = await render(
        <ComposerSurface.Main>
          <p>Ask anything</p>
        </ComposerSurface.Main>,
      );
      const main = screen.container.querySelector<HTMLElement>(
        "[data-chat-composer-main-surface]",
      )!;
      const style = getComputedStyle(main);
      expect(style.borderTopWidth, dark ? "dark" : "light").toBe("1px");
      expect(style.borderTopStyle).toBe("solid");
      expect(style.boxShadow).toBe(shadowToken());
      expect(style.boxShadow).not.toBe("none");
    }
  });
});
