import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatHeaderPanelControls, type PanelLayoutControlsProps } from "./PanelLayoutControls";

function controls(rightPanelOpen: boolean): PanelLayoutControlsProps {
  return {
    terminalAvailable: true,
    terminalOpen: false,
    terminalShortcutLabel: null,
    threadPanelOpen: false,
    threadPanelPresentation: "inline",
    threadPanelShortcutLabel: null,
    rightPanelAvailable: true,
    rightPanelOpen,
    rightPanelShortcutLabel: null,
    onToggleTerminal: () => {},
    onToggleThreadPanel: () => {},
    onToggleRightPanel: () => {},
  };
}

/** A viewport for one test, restoring the previous size on dispose. */
async function viewport(width: number, height = 900): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, height);
  return { [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height) };
}

function labels(container: HTMLElement): Array<string> {
  return [...container.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent ?? "",
  );
}

it("keeps the terminal and right panel toggles in the header while the right panel is open", async () => {
  await using _viewport = await viewport(1440);
  await using screen = await render(<ChatHeaderPanelControls {...controls(true)} />);

  expect(labels(screen.container)).toEqual([
    "Toggle thread details panel",
    "Toggle terminal drawer",
    "Toggle right panel",
  ]);
});

it("shows every panel toggle in the header while the right panel is closed", async () => {
  await using _viewport = await viewport(1440);
  await using screen = await render(<ChatHeaderPanelControls {...controls(false)} />);

  expect(labels(screen.container)).toEqual([
    "Toggle thread details panel",
    "Toggle terminal drawer",
    "Toggle right panel",
  ]);
});

it("folds the layout controls into a More menu below the drawer breakpoint, keeping the side panel toggle", async () => {
  await using _viewport = await viewport(800);
  await using screen = await render(
    <ChatHeaderPanelControls {...controls(false)} threadPanelShortcutLabel="Ctrl+I" />,
  );

  expect(labels(screen.container)).toEqual(["More layout controls", "Toggle right panel"]);

  await screen.getByRole("button", { name: "More layout controls" }).click();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: /Toggle thread details/ }))
    .toBeVisible();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: /Toggle terminal drawer/ }))
    .toBeVisible();
});

it("toggles the terminal and details from the More menu", async () => {
  await using _viewport = await viewport(800);
  const calls: string[] = [];
  await using screen = await render(
    <ChatHeaderPanelControls
      {...controls(false)}
      onToggleTerminal={() => calls.push("terminal")}
      onToggleThreadPanel={() => calls.push("details")}
    />,
  );

  await screen.getByRole("button", { name: "More layout controls" }).click();
  await page.getByRole("menuitemcheckbox", { name: /Toggle terminal drawer/ }).click();
  expect(calls).toEqual(["terminal"]);

  await page.getByRole("menuitemcheckbox", { name: /Toggle thread details/ }).click();
  expect(calls).toEqual(["terminal", "details"]);
});

it("keeps a popover-presented details toggle in the header as the card's anchor", async () => {
  await using _viewport = await viewport(800);
  await using screen = await render(
    <ChatHeaderPanelControls
      {...controls(false)}
      threadPanelPresentation="popover"
      threadPanelPopoverHandle={PopoverCreateHandle()}
    />,
  );

  expect(labels(screen.container)).toEqual([
    "More layout controls",
    "Toggle thread details panel",
    "Toggle right panel",
  ]);
});
