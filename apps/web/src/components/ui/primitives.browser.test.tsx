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
    expect(getComputedStyle(badge).borderRadius).toBe("6px");
  });

  it("exposes the board palette on the canonical tokens", () => {
    const root = document.documentElement;
    const read = (name: string) => getComputedStyle(root).getPropertyValue(name).trim();
    const paper = {
      "--rail": "#ececef",
      "--content": "#f5f5f7",
      "--card": "#ffffff",
      "--raised": "#ffffff",
      "--term": "#ffffff",
      "--code-bg": "#f7f7f9",
      "--t1": "#1d1d1f",
      "--t2": "#424245",
      "--t3": "#5b5b60",
      "--border": "rgba(0, 0, 0, 0.09)",
      "--hover": "rgba(0, 0, 0, 0.045)",
      "--sel": "rgba(0, 0, 0, 0.09)",
      "--accent": "#0a63e0",
      "--accent-hover": "#0954be",
      "--accent-ink": "#0a5cd1",
      "--warn": "#b45309",
      "--stop": "#c0362c",
      "--ok": "#1d7a3a",
      "--add-bg": "rgba(29, 122, 58, 0.09)",
      "--del-bg": "rgba(192, 54, 44, 0.08)",
      "--pane": "#ffffff",
      "--pane-head": "#f7f7f9",
      "--composer": "#ffffff",
    };
    const graphite = {
      "--rail": "#1c1c1f",
      "--content": "#161618",
      "--card": "#202023",
      "--raised": "#26262a",
      "--term": "#0f0f11",
      "--code-bg": "#18181b",
      "--t1": "rgba(255, 255, 255, 0.92)",
      "--t2": "rgba(255, 255, 255, 0.66)",
      "--t3": "rgba(255, 255, 255, 0.52)",
      "--border": "rgba(255, 255, 255, 0.09)",
      "--hover": "rgba(255, 255, 255, 0.05)",
      "--sel": "rgba(255, 255, 255, 0.09)",
      "--accent": "#2f6fe8",
      "--accent-hover": "#4f85ec",
      "--accent-ink": "#64a0ff",
      "--warn": "#f5a524",
      "--stop": "#ff6b61",
      "--ok": "#30d158",
      "--add-bg": "rgba(48, 209, 88, 0.1)",
      "--del-bg": "rgba(255, 107, 97, 0.1)",
      "--pane": "#0f0f11",
      "--pane-head": "#18181b",
      "--composer": "#18181b",
    };
    root.classList.remove("dark");
    try {
      for (const [name, value] of Object.entries(paper)) expect(read(name), name).toBe(value);
      root.classList.add("dark");
      for (const [name, value] of Object.entries(graphite)) expect(read(name), name).toBe(value);
    } finally {
      root.classList.remove("dark");
    }
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
