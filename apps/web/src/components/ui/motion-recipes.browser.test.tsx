import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import {
  MOTION_DISCLOSURE_ROTATE,
  MOTION_FEEDBACK,
  MOTION_FEEDBACK_OPACITY,
  MOTION_RISE_IN,
  MOTION_RISE_OUT,
} from "./motion-recipes";
import { overlayMotion, overlayMotionFromEdge } from "./overlayMotion";

function probe(container: HTMLElement, name: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-probe="${name}"]`);
  if (element === null) throw new Error(`The ${name} probe is missing.`);
  return element;
}

const STANDARD_EASE = "cubic-bezier(0.2, 0, 0, 1)";
const EXIT_EASE = "cubic-bezier(0.4, 0, 1, 1)";

it("eases colour and opacity feedback on the feedback role", async () => {
  await using screen = await render(
    <div>
      <span data-probe="colour" className={MOTION_FEEDBACK} />
      <span data-probe="opacity" className={MOTION_FEEDBACK_OPACITY} />
    </div>,
    { router: false },
  );

  const colour = getComputedStyle(probe(screen.container, "colour"));
  expect(colour.transitionProperty).toContain("color");
  expect(colour.transitionDuration).toBe("0.1s");
  expect(colour.transitionTimingFunction).toBe(STANDARD_EASE);

  const opacity = getComputedStyle(probe(screen.container, "opacity"));
  expect(opacity.transitionProperty).toBe("opacity");
  expect(opacity.transitionDuration).toBe("0.1s");
  expect(opacity.transitionTimingFunction).toBe(STANDARD_EASE);
});

it("turns a disclosure chevron on the disclosure role", async () => {
  await using screen = await render(
    <span data-probe="chevron" className={MOTION_DISCLOSURE_ROTATE} />,
    { router: false },
  );

  const chevron = getComputedStyle(probe(screen.container, "chevron"));
  expect(chevron.transitionProperty).toContain("transform");
  expect(chevron.transitionDuration).toBe("0.2s");
  expect(chevron.transitionTimingFunction).toBe(STANDARD_EASE);
});

it("keeps the rising control's enter and exit roles distinct", async () => {
  await using screen = await render(
    <div>
      <span data-probe="entering" className={MOTION_RISE_IN} />
      <span data-probe="leaving" className={MOTION_RISE_OUT} />
    </div>,
    { router: false },
  );

  const entering = getComputedStyle(probe(screen.container, "entering"));
  expect(entering.transitionProperty).toBe("opacity, translate");
  expect(entering.transitionDuration).toBe("0.22s");
  expect(entering.transitionTimingFunction).toBe(STANDARD_EASE);
  expect(entering.opacity).toBe("1");

  const leaving = getComputedStyle(probe(screen.container, "leaving"));
  expect(leaving.transitionProperty).toBe("opacity, translate");
  expect(leaving.transitionDuration).toBe("0.14s");
  expect(leaving.transitionTimingFunction).toBe(EXIT_EASE);
  expect(leaving.opacity).toBe("0");
});

it("grows an overlay from its anchor or from the composer edge", async () => {
  await using screen = await render(
    <div>
      <div data-probe="anchored" className={overlayMotion} />
      <div data-probe="edge" className={overlayMotionFromEdge} />
    </div>,
    { router: false },
  );

  const anchored = getComputedStyle(probe(screen.container, "anchored"));
  expect(anchored.transitionProperty).toBe("opacity, scale");
  expect(anchored.transitionDuration).toBe("0.15s");

  const edge = getComputedStyle(probe(screen.container, "edge"));
  expect(edge.transitionProperty).toBe("opacity, scale");
  expect(edge.transformOrigin).toBe(anchored.transformOrigin);
  expect(probe(screen.container, "edge").className).toContain("origin-bottom");
});
