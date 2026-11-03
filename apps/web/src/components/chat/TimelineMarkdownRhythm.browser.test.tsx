import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";

it("keeps the timeline's block gap between paragraphs but not at a message's edges", async () => {
  await using screen = await render(
    <div className="messages-timeline-scroll">
      <div className="chat-markdown">
        <p>First</p>
        <p>Middle</p>
        <p>Last</p>
      </div>
    </div>,
    { router: false },
  );

  const [first, middle, last] = screen.container.querySelectorAll("p");
  // An edge margin would sit inside a user bubble's padding and double it.
  expect(getComputedStyle(first!).marginTop).toBe("0px");
  expect(getComputedStyle(last!).marginBottom).toBe("0px");
  expect(getComputedStyle(middle!).marginTop).toBe("12px");
  expect(getComputedStyle(middle!).marginBottom).toBe("12px");
});
