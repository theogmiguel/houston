import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerTaskStatus } from "./composer-task-status";

const steps = [
  { id: "read", text: "Read the package manifest", status: "completed" },
  { id: "edit", text: "Add a clamp helper", status: "running" },
  { id: "test", text: "Run the tests", status: "pending" },
] as const;

function card(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>("[data-composer-task-status]");
  if (element === null) throw new Error("task status card missing");
  return element;
}

it("renders nothing while the agent has no tasks", async () => {
  await using screen = await render(<ComposerTaskStatus steps={[]} />, { router: false });

  expect(screen.container.querySelector("[data-composer-task-status]")).toBeNull();
});

it("starts collapsed, naming the running step and the progress", async () => {
  await using screen = await render(<ComposerTaskStatus steps={steps} />, { router: false });

  expect(card(screen.container).dataset["composerTaskStatus"]).toBe("collapsed");
  const trigger = screen.getByRole("button", { name: /^Tasks/ });
  expect(trigger.element().getAttribute("aria-expanded")).toBe("false");
  expect(screen.container.textContent).toContain("Add a clamp helper");
  expect(screen.container.textContent).toContain("1/3");
  await expect.element(screen.getByText("Read the package manifest")).not.toBeInTheDocument();
});

it("opens every step from the header and closes again", async () => {
  await using screen = await render(<ComposerTaskStatus steps={steps} />, { router: false });
  const trigger = screen.getByRole("button", { name: /^Tasks/ });

  await trigger.click();

  expect(card(screen.container).dataset["composerTaskStatus"]).toBe("expanded");
  expect(trigger.element().getAttribute("aria-expanded")).toBe("true");
  await expect.element(screen.getByText("Read the package manifest")).toBeVisible();
  await expect.element(screen.getByText("Run the tests")).toBeVisible();
  expect(screen.container.textContent).toContain("now");

  await trigger.click();

  expect(card(screen.container).dataset["composerTaskStatus"]).toBe("collapsed");
  await expect.element(screen.getByText("Run the tests")).not.toBeInTheDocument();
});

it("marks a finished list complete without a running step", async () => {
  const finished = steps.map((step) => ({ ...step, status: "completed" as const }));
  await using screen = await render(<ComposerTaskStatus steps={finished} />, { router: false });

  expect(screen.container.textContent).toContain("3/3");
  expect(screen.container.querySelector("[data-streaming-glyph]")).toBeNull();
  expect(screen.container.textContent).not.toContain("now");
  await screen.getByRole("button", { name: /^Tasks/ }).click();
  await expect.element(screen.getByText("Run the tests")).toBeVisible();
});
