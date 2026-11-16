import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ScrollToEndButton } from "./TimelineOverlays";

const STANDARD_EASE = "cubic-bezier(0.2, 0, 0, 1)";
const EXIT_EASE = "cubic-bezier(0.4, 0, 1, 1)";

const button = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".chat-scroll-to-bottom")!;

it("rises into place while open and leaves on the exit role", async () => {
  await using screen = await render(
    <ScrollToEndButton open={true} bottom={8} summary={null} onScrollToEnd={() => {}} />,
    { router: false },
  );

  const open = getComputedStyle(button(screen.container));
  expect(open.transitionProperty).toBe("opacity, translate");
  expect(open.transitionDuration).toBe("0.22s");
  expect(open.transitionTimingFunction).toBe(STANDARD_EASE);
  expect(open.opacity).toBe("1");

  await screen.rerender(
    <ScrollToEndButton open={false} bottom={8} summary={null} onScrollToEnd={() => {}} />,
  );

  const closed = getComputedStyle(button(screen.container));
  expect(closed.transitionProperty).toBe("opacity, translate");
  expect(closed.transitionDuration).toBe("0.14s");
  expect(closed.transitionTimingFunction).toBe(EXIT_EASE);
  await vi.waitFor(() => expect(getComputedStyle(button(screen.container)).opacity).toBe("0"));
});
