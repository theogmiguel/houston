import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
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
    gridLayoutControl: <button type="button">Grid layout</button>,
    onToggleTerminal: () => {},
    onToggleThreadPanel: () => {},
    onToggleRightPanel: () => {},
  };
}

function labels(container: HTMLElement): Array<string> {
  return [...container.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent ?? "",
  );
}

it("keeps the thread details toggle beside the grid control while the right panel is open", async () => {
  await using screen = await render(<ChatHeaderPanelControls {...controls(true)} />);

  expect(labels(screen.container)).toEqual(["Toggle thread details panel", "Grid layout"]);
});

it("shows every panel toggle in the header while the right panel is closed", async () => {
  await using screen = await render(<ChatHeaderPanelControls {...controls(false)} />);

  expect(labels(screen.container)).toEqual([
    "Toggle thread details panel",
    "Toggle terminal drawer",
    "Toggle right panel",
    "Grid layout",
  ]);
});
