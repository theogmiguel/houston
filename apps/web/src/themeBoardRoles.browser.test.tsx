import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

const THEME_COLORS = {
  "--app-theme-canvas": "rgb(40, 10, 30)",
  "--app-theme-sidebar": "rgb(60, 20, 45)",
  "--app-theme-surface": "rgb(70, 25, 55)",
  "--app-theme-text": "rgb(250, 230, 240)",
  "--app-theme-toolbar": "rgb(50, 15, 35)",
  "--app-theme-surface-raised": "rgb(80, 30, 60)",
  "--app-theme-accent-surface": "rgb(90, 35, 70)",
  "--app-theme-message-surface": "rgb(100, 40, 80)",
  "--app-theme-message-action": "rgb(220, 60, 150)",
  "--app-theme-sidebar-row-selected": "rgb(110, 45, 90)",
} as const;

function paint(role: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${role})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

function applyTheme(dark: boolean): Disposable {
  const root = document.documentElement;
  root.dataset.themeId = "board-roles-probe";
  root.classList.toggle("dark", dark);
  for (const [name, value] of Object.entries(THEME_COLORS)) root.style.setProperty(name, value);
  return {
    [Symbol.dispose]() {
      delete root.dataset.themeId;
      root.classList.remove("dark");
      for (const name of Object.keys(THEME_COLORS)) root.style.removeProperty(name);
    },
  };
}

function namedElementDuringReveal(): Disposable & { readonly element: HTMLElement } {
  const element = document.createElement("div");
  element.style.viewTransitionName = "houston-mobile-composer";
  document.body.append(element);
  return {
    element,
    [Symbol.dispose]() {
      element.remove();
      delete document.documentElement.dataset.themeReveal;
    },
  };
}

describe("theme reach", () => {
  it("keeps Houston's own board colors when no theme is applied", () => {
    expect(paint("--rail")).toBe("rgb(236, 236, 239)");
    expect(paint("--content")).toBe("rgb(245, 245, 247)");
  });

  it("paints each board role with the theme role upstream shows on that surface", () => {
    using _theme = applyTheme(false);
    expect(paint("--rail")).toBe(THEME_COLORS["--app-theme-sidebar"]);
    expect(paint("--content")).toBe(THEME_COLORS["--app-theme-toolbar"]);
    expect(paint("--pane")).toBe(THEME_COLORS["--app-theme-canvas"]);
    expect(paint("--composer")).toBe(THEME_COLORS["--app-theme-surface-raised"]);
    expect(paint("--sel")).toBe(THEME_COLORS["--app-theme-accent-surface"]);
    expect(paint("--t1")).toBe(THEME_COLORS["--app-theme-text"]);
    expect(paint("--bubble")).toBe(THEME_COLORS["--app-theme-message-surface"]);
    expect(paint("--send")).toBe(THEME_COLORS["--app-theme-message-action"]);
    expect(paint("--control-fill")).toBe(THEME_COLORS["--app-theme-canvas"]);
    expect(paint("--row-current")).toBe(THEME_COLORS["--app-theme-sidebar-row-selected"]);
    expect(paint("--thumb")).toBe(THEME_COLORS["--app-theme-canvas"]);
  });

  it("keeps a dark theme's thread on its canvas, as upstream draws it", () => {
    using _theme = applyTheme(true);
    expect(paint("--pane")).toBe(THEME_COLORS["--app-theme-canvas"]);
    expect(paint("--content")).toBe(THEME_COLORS["--app-theme-toolbar"]);
  });

  it("draws Houston's bubble and send button from its own card and ink without a theme", () => {
    expect(paint("--bubble")).toBe(paint("--card"));
    expect(paint("--send")).toBe(paint("--t1"));
    expect(paint("--control-fill")).toBe(paint("--field"));
    expect(paint("--row-current")).toBe(paint("--accent-muted"));
    expect(paint("--thumb")).toBe("rgb(255, 255, 255)");
  });

  it("drops other view-transition names while a theme reveal runs", () => {
    using named = namedElementDuringReveal();
    expect(getComputedStyle(named.element).viewTransitionName).toBe("houston-mobile-composer");

    document.documentElement.dataset.themeReveal = "true";
    expect(getComputedStyle(named.element).viewTransitionName).toBe("none");
  });
});
