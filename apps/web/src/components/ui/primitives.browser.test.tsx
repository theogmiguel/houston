import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Badge } from "./badge";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
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

  it("maps the hover utility to the neutral hover token in both themes", async () => {
    await using screen = await render(
      <div>
        <div data-testid="hover-utility" className="bg-hover" />
        <div data-testid="hover-token" style={{ backgroundColor: "var(--hover)" }} />
      </div>,
      { router: false },
    );

    const utility = screen.container.querySelector('[data-testid="hover-utility"]')!;
    const token = screen.container.querySelector('[data-testid="hover-token"]')!;
    const root = document.documentElement;
    root.classList.remove("dark");
    try {
      expect(getComputedStyle(utility).backgroundColor).toBe(
        getComputedStyle(token).backgroundColor,
      );
      expect(getComputedStyle(utility).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      root.classList.add("dark");
      expect(getComputedStyle(utility).backgroundColor).toBe(
        getComputedStyle(token).backgroundColor,
      );
    } finally {
      root.classList.remove("dark");
    }
  });

  it("exposes the board palette on the canonical tokens", () => {
    const root = document.documentElement;
    const read = (name: string) => getComputedStyle(root).getPropertyValue(name).trim();
    const paper = {
      "--rail": "#ececf0",
      "--content": "#ffffff",
      "--card": "#ffffff",
      "--raised": "#ffffff",
      "--term": "#ffffff",
      "--code-bg": "#f7f7fa",
      "--t1": "#1d1d1f",
      "--t2": "#424245",
      "--houston": "#5b5b60",
      "--border": "rgba(0, 0, 0, 0.09)",
      "--hover": "rgba(0, 0, 0, 0.045)",
      "--sel": "rgba(0, 0, 0, 0.09)",
      "--accent": "#2563eb",
      "--accent-hover": "#1d4ed8",
      "--accent-ink": "#1d4ed8",
      "--warn": "#b45309",
      "--stop": "#c0362c",
      "--ok": "#1d7a3a",
      "--add-bg": "rgba(29, 122, 58, 0.09)",
      "--del-bg": "rgba(192, 54, 44, 0.08)",
      "--pane": "#ffffff",
      "--pane-head": "#f7f7fa",
      "--composer": "#ffffff",
    };
    const graphite = {
      "--rail": "#08080a",
      "--content": "#18181b",
      "--card": "#1f1f23",
      "--raised": "#1f1f23",
      "--term": "#18181b",
      "--code-bg": "#1a1a1e",
      "--t1": "rgba(255, 255, 255, 0.92)",
      "--t2": "rgba(255, 255, 255, 0.66)",
      "--houston": "rgba(255, 255, 255, 0.52)",
      "--border": "rgba(255, 255, 255, 0.09)",
      "--hover": "rgba(255, 255, 255, 0.05)",
      "--sel": "rgba(255, 255, 255, 0.09)",
      "--accent": "#2563eb",
      "--accent-hover": "#1d4ed8",
      "--accent-ink": "#64a0ff",
      "--warn": "#f5a524",
      "--stop": "#ff6b61",
      "--ok": "#30d158",
      "--add-bg": "rgba(48, 209, 88, 0.1)",
      "--del-bg": "rgba(255, 107, 97, 0.1)",
      "--pane": "#18181b",
      "--pane-head": "#1f1f23",
      // The composer is one card with the thread surface's card fill.
      "--composer": "#1f1f23",
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

  it("moves one indicator onto the pressed segment with transform", async () => {
    await using screen = await render(
      <ToggleGroup aria-label="Mode" defaultValue={["chat"]}>
        <Toggle value="chat">Chat</Toggle>
        <Toggle value="plan">Plan</Toggle>
      </ToggleGroup>,
      { router: false },
    );

    const group = screen.getByRole("group", { name: "Mode" }).element();
    const indicator = screen.container.querySelector<HTMLElement>(
      '[data-slot="toggle-group-indicator"]',
    )!;
    const chat = screen.getByRole("button", { name: "Chat" }).element();
    const plan = screen.getByRole("button", { name: "Plan" }).element();
    const placement = (item: Element) => {
      const groupRect = group.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      return {
        x: itemRect.left - groupRect.left,
        y: itemRect.top - groupRect.top,
        width: itemRect.width,
      };
    };
    const placed = () => {
      const match = /^translate\(([-\d.]+)px, ([-\d.]+)px\)$/u.exec(indicator.style.transform);
      return match === null
        ? null
        : { x: Number(match[1]), y: Number(match[2]), width: parseFloat(indicator.style.width) };
    };
    const expectPlacedOn = (item: Element) => {
      const target = placement(item);
      expect(placed()).not.toBeNull();
      expect(placed()!.x).toBeCloseTo(target.x);
      expect(placed()!.y).toBeCloseTo(target.y);
      expect(placed()!.width).toBeCloseTo(target.width);
    };

    expect(indicator.getAttribute("aria-hidden")).toBe("true");
    expectPlacedOn(chat);
    expect(getComputedStyle(indicator).transitionProperty).toContain("transform");

    await userEvent.click(plan);

    expectPlacedOn(plan);
  });

  it("keeps the checkbox mark mounted so it fades and scales", async () => {
    await using screen = await render(
      <div>
        <Checkbox aria-label="Include" />
      </div>,
      { router: false },
    );

    const indicator = screen.container.querySelector<HTMLElement>(
      '[data-slot="checkbox-indicator"]',
    )!;

    expect(indicator).not.toBeNull();
    expect(getComputedStyle(indicator).opacity).toBe("0");
    expect(getComputedStyle(indicator).transitionProperty).toContain("opacity");
  });
});
