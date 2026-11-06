import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../test/render";

function timelineLaneMaxWidth(container: Element): string {
  const lane = container.querySelector(".chat-content-lane");
  if (lane === null) throw new Error("expected a .chat-content-lane inside the timeline");
  return getComputedStyle(lane).maxWidth;
}

function setChatWidth(width: string): Disposable {
  document.documentElement.dataset.chatWidth = width;
  return {
    [Symbol.dispose]: () => {
      delete document.documentElement.dataset.chatWidth;
    },
  };
}

describe("chat width setting", () => {
  it.each([
    { width: "comfortable", expected: ["760px"] },
    { width: "wide", expected: ["1152px"] },
    // `max-width: 100%` reads back as "100%" or "none" depending on the layout state.
    { width: "full", expected: ["100%", "none"] },
  ])("sizes the message timeline lane for $width", async ({ width, expected }) => {
    using _width = setChatWidth(width);
    await using screen = await render(
      <div className="messages-timeline-scroll">
        <div className="chat-content-lane" />
      </div>,
    );

    expect(expected).toContain(timelineLaneMaxWidth(screen.container));
  });

  it.each(["comfortable", "wide", "full"])(
    "gives the timeline lane and the composer the same edges at %s width",
    async (width) => {
      using _width = setChatWidth(width);
      await using screen = await render(
        <div style={{ width: 1128 }}>
          <div className="messages-timeline-scroll">
            <div className="chat-content-lane" data-testid="lane">
              <div style={{ height: 8 }} />
            </div>
          </div>
          <div className="mx-auto w-full max-w-(--chat-content-max-width)" data-testid="composer">
            <div style={{ height: 8 }} />
          </div>
        </div>,
      );

      const lane = screen.container.querySelector<HTMLElement>("[data-testid=lane]")!;
      const composer = screen.container.querySelector<HTMLElement>("[data-testid=composer]")!;
      expect(lane.getBoundingClientRect().left).toBe(composer.getBoundingClientRect().left);
      expect(lane.getBoundingClientRect().right).toBe(composer.getBoundingClientRect().right);
    },
  );
});
