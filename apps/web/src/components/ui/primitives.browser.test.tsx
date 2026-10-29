import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { Badge } from "./badge";
import { Button } from "./button";
import { Input } from "./input";
import { Kbd } from "./kbd";
import { SelectButton } from "./select";
import { Switch } from "./switch";
import { Toggle, ToggleGroup } from "./toggle-group";

function height(element: Element): number {
  return element.getBoundingClientRect().height;
}

function width(element: Element): number {
  return element.getBoundingClientRect().width;
}

describe("Houston primitives", () => {
  it("draw the control ladder at 28px with the 13px body", async () => {
    await using screen = await render(
      <div>
        <Button>Create thread</Button>
        <Button size="sm">Approve</Button>
        <Input aria-label="Thread title" />
        <SelectButton>Claude Opus</SelectButton>
        <Kbd>Ctrl</Kbd>
        <Badge>Worktree</Badge>
      </div>,
      { router: false },
    );

    const button = screen.getByRole("button", { name: "Create thread" }).element();
    const small = screen.getByRole("button", { name: "Approve" }).element();
    const field = screen.container.querySelector('[data-slot="input-control"]')!;
    const select = screen.getByRole("button", { name: "Claude Opus" }).element();
    const kbd = screen.container.querySelector('[data-slot="kbd"]')!;
    const badge = screen.container.querySelector('[data-slot="badge"]')!;

    expect(height(button)).toBe(28);
    expect(getComputedStyle(button).fontSize).toBe("13px");
    expect(getComputedStyle(button).borderRadius).toBe("6px");
    expect(height(small)).toBe(22);
    expect(height(field)).toBe(28);
    expect(height(select)).toBe(28);
    expect(height(kbd)).toBe(18);
    expect(height(badge)).toBe(20);
  });

  it("draws switches at 36 × 20 with a 22px compact variant", async () => {
    await using screen = await render(
      <div>
        <Switch aria-label="Keep server running" />
        <Switch aria-label="Compact switch" size="sm" />
      </div>,
      { router: false },
    );

    const toggle = screen.getByRole("switch", { name: "Keep server running" }).element();
    const compact = screen.getByRole("switch", { name: "Compact switch" }).element();

    expect(width(toggle)).toBe(36);
    expect(height(toggle)).toBe(20);
    expect(width(compact)).toBe(30);
    expect(height(compact)).toBe(18);
  });

  it("draws the segmented control on the 24px rung", async () => {
    await using screen = await render(
      <ToggleGroup aria-label="Mode">
        <Toggle value="chat">Chat</Toggle>
        <Toggle value="plan">Plan</Toggle>
      </ToggleGroup>,
      { router: false },
    );

    const group = screen.getByRole("group", { name: "Mode" }).element();
    const chat = screen.getByRole("button", { name: "Chat" }).element();

    expect(getComputedStyle(group).padding).toBe("2px");
    expect(getComputedStyle(group).borderRadius).toBe("6px");
    expect(height(chat)).toBe(24);
    expect(getComputedStyle(chat).borderRadius).toBe("4px");
  });
});
