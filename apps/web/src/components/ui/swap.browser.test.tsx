import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { Swap } from "./swap";

function layers(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="swap-layer"]')];
}

function content(container: HTMLElement): HTMLElement[] {
  return layers(container).map((layer) => layer.firstElementChild as HTMLElement);
}

it("renders the first key as the only active layer", async () => {
  await using screen = await render(
    <Swap swapKey="first" contentClassName="h-20">
      <p>First view</p>
    </Swap>,
    { router: false },
  );

  expect(layers(screen.container)).toHaveLength(1);
  expect(layers(screen.container)[0]!.dataset["state"]).toBe("active");
  expect(screen.container.textContent).toBe("First view");
  expect(getComputedStyle(content(screen.container)[0]!).transitionProperty).toContain("opacity");
});

it("keeps the previous layer mounted out of flow until its exit ends", async () => {
  await using screen = await render(
    <Swap swapKey="first" contentClassName="flex flex-col">
      <div style={{ height: 80 }}>Tall first view</div>
    </Swap>,
    { router: false },
  );

  await screen.rerender(
    <Swap swapKey="second" contentClassName="flex flex-col">
      <div style={{ height: 20 }}>Short second view</div>
    </Swap>,
  );

  const active = layers(screen.container).find((layer) => layer.dataset["state"] === "active")!;
  const exiting = layers(screen.container).find((layer) => layer.dataset["state"] === "exiting")!;

  expect(active.textContent).toBe("Short second view");
  expect(exiting.textContent).toBe("Tall first view");
  expect(getComputedStyle(exiting).position).toBe("absolute");
  expect(exiting.getAttribute("aria-hidden")).toBe("true");
  expect(Math.round(screen.container.getBoundingClientRect().height)).toBe(20);

  await vi.waitFor(() => {
    expect(layers(screen.container)).toHaveLength(1);
    expect(layers(screen.container)[0]!.dataset["state"]).toBe("active");
  });
});

it("does not swap when only the content of the same key changes", async () => {
  await using screen = await render(
    <Swap swapKey="settings" contentClassName="flex flex-col">
      <p>General</p>
    </Swap>,
    { router: false },
  );

  await screen.rerender(
    <Swap swapKey="settings" contentClassName="flex flex-col">
      <p>General</p>
      <p>Updated copy</p>
    </Swap>,
  );

  expect(layers(screen.container)).toHaveLength(1);
  expect(layers(screen.container)[0]!.dataset["state"]).toBe("active");
  expect(screen.container.textContent).toBe("GeneralUpdated copy");
});
