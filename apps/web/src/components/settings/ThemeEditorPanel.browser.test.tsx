import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { THEME_CSS_MAX_LENGTH } from "@houston-app/contracts";

import { act, render } from "../../../test/render";
import {
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  removeCustomTheme,
  THEME_FILE_VERSION,
  type ThemeDefinition,
} from "../../themePalette";
import { applyThemeCss } from "../../themeCss";
import { ThemeEditorPanel } from "./ThemeEditorPanel";

function dragHeader(panel: HTMLElement, toX: number, toY: number) {
  const header = panel.querySelector<HTMLElement>("h2")!.closest<HTMLElement>(".cursor-grab")!;
  const rect = panel.getBoundingClientRect();
  const start = { clientX: rect.left + 40, clientY: rect.top + 10 };
  const init = { bubbles: true, button: 0, pointerId: 1 };
  header.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...start }));
  header.dispatchEvent(
    new PointerEvent("pointermove", { ...init, clientX: toX + 40, clientY: toY + 10 }),
  );
  header.dispatchEvent(new PointerEvent("pointerup", init));
}

function dragResizeHandle(panel: HTMLElement, byX: number) {
  const handle = panel.querySelector<HTMLElement>(".cursor-se-resize")!;
  const rect = handle.getBoundingClientRect();
  const init = { bubbles: true, button: 0, pointerId: 2 };
  const start = { clientX: rect.left + 4, clientY: rect.top + 4 };
  handle.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...start }));
  handle.dispatchEvent(
    new PointerEvent("pointermove", {
      ...init,
      clientX: start.clientX + byX,
      clientY: start.clientY,
    }),
  );
  handle.dispatchEvent(new PointerEvent("pointerup", init));
}

function pointerAt(target: HTMLElement, type: string, xFraction: number) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: 3,
      clientX: rect.left + rect.width * xFraction,
      clientY: rect.top + rect.height / 2,
    }),
  );
}

async function renderPanel() {
  await page.viewport(1280, 900);
  const stack = new AsyncDisposableStack();
  // Synthetic pointer ids are not active pointers, so the browser would reject capture.
  stack.use(vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => {}));
  // Tailwind is not loaded here; give the panel its fixed, card-sized box.
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = "[data-theme-editor-panel]{position:fixed;width:400px;height:300px}";
  stack.defer(() => style.remove());
  const screen = stack.use(
    await render(
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={() => true}
        editingTheme={null}
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    ),
  );
  const panel = screen.getByRole("dialog", { name: "Create theme" });
  await expect.element(panel).toBeVisible();
  return {
    panel: panel.element() as HTMLElement,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("ThemeEditorPanel", () => {
  it("keeps its left edge when resized after the window shrank", async () => {
    await using view = await renderPanel();
    dragHeader(view.panel, 700, 40);
    await expect.poll(() => view.panel.style.left).toBe("700px");

    await page.viewport(600, 900);
    await expect.poll(() => Number.parseFloat(view.panel.style.left)).toBeLessThan(600);
    const clampedLeft = view.panel.style.left;

    dragResizeHandle(view.panel, -100);
    await expect.poll(() => view.panel.style.width).not.toBe("");
    expect(view.panel.style.left).toBe(clampedLeft);
  });

  it("returns to where the user left it when the window shrinks and grows back", async () => {
    await page.viewport(1280, 900);
    // Synthetic pointer ids are not active pointers, so the browser would reject capture.
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});
    // Tailwind is not loaded here; give the panel its fixed, card-sized box.
    const style = document.head.appendChild(document.createElement("style"));
    style.textContent = "[data-theme-editor-panel]{position:fixed;width:400px;height:300px}";
    using _style = { [Symbol.dispose]: () => style.remove() };
    await using screen = await render(
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={() => true}
        editingTheme={null}
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    );
    const panel = screen.getByRole("dialog", { name: "Create theme" });
    await expect.element(panel).toBeVisible();

    dragHeader(panel.element() as HTMLElement, 700, 40);
    await expect.poll(() => (panel.element() as HTMLElement).style.left).toBe("700px");

    await page.viewport(600, 900);
    await expect
      .poll(() => Number.parseFloat((panel.element() as HTMLElement).style.left))
      .toBeLessThan(600);

    await page.viewport(1280, 900);
    await expect.poll(() => (panel.element() as HTMLElement).style.left).toBe("700px");
  });

  it("restores the colors from before the picker opened when Escape closes it", async () => {
    await using _view = await renderPanel();
    const hex = page.getByRole("textbox", { name: "Accent hex value" });
    const original = (hex.element() as HTMLInputElement).value;
    await userEvent.click(page.getByRole("button", { name: "Choose Accent color" }));
    const hue = page.getByRole("slider", { name: "Accent hue" });
    await expect.element(hue).toBeInTheDocument();
    const hueSlider = hue.element() as HTMLElement;

    await act(async () => {
      pointerAt(hueSlider, "pointerdown", 0.5);
      pointerAt(hueSlider, "pointerup", 0.5);
    });
    await expect.element(hex).not.toHaveValue(original);

    await act(async () => {
      pointerAt(hueSlider, "pointerdown", 0.25);
      hueSlider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      // The drag keeps going while the picker animates out.
      pointerAt(hueSlider, "pointermove", 0.75);
      pointerAt(hueSlider, "pointerup", 0.75);
    });
    expect((hex.element() as HTMLInputElement).value).toBe(original);
  });

  describe("custom CSS", () => {
    // Tailwind is not loaded here, so the footer sits below the viewport; click it directly.
    const save = (screen: Awaited<ReturnType<typeof render>>) =>
      act(async () => {
        (screen.getByRole("button", { name: "Save changes" }).element() as HTMLElement).click();
      });

    const css = "[data-theme-editor-css-probe] { color: rgb(9, 8, 7); }";

    async function renderEditor(
      editingTheme: ThemeDefinition | null,
      onSaved: ComponentProps<typeof ThemeEditorPanel>["onSaved"] = () => true,
    ) {
      await page.viewport(1280, 900);
      const style = document.head.appendChild(document.createElement("style"));
      // Tailwind is not loaded here, so the panel needs room for the whole form.
      style.textContent = "[data-theme-editor-panel]{position:fixed;width:400px;height:880px}";
      const probe = document.body.appendChild(document.createElement("div"));
      probe.dataset.themeEditorCssProbe = "";
      const screen = await render(
        <ThemeEditorPanel
          open
          onOpenChange={() => {}}
          onSaved={onSaved}
          editingTheme={editingTheme}
          initialAppearance="dark"
          restoreTheme={() => {}}
        />,
      );
      return {
        screen,
        probe,
        async [Symbol.asyncDispose]() {
          await screen[Symbol.asyncDispose]();
          probe.remove();
          style.remove();
          applyThemeCss(undefined);
        },
      };
    }

    it("is collapsed when empty, and typing previews the CSS live", async () => {
      await using view = await renderEditor(null);
      const trigger = view.screen.getByRole("button", { name: "Custom CSS" });
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      await userEvent.click(trigger);
      const field = view.screen.getByRole("textbox", { name: "Custom CSS" });
      await expect.element(field).toHaveValue("");
      await userEvent.fill(field, css);
      await expect.poll(() => getComputedStyle(view.probe).color).toBe("rgb(9, 8, 7)");
    });

    it("names the limit and the length when the CSS is over it, and does not save", async () => {
      const onSaved = vi.fn(() => true);
      await using view = await renderEditor(null, onSaved);
      await userEvent.click(view.screen.getByRole("button", { name: "Custom CSS" }));
      const field = view.screen.getByRole("textbox", { name: "Custom CSS" });
      const long = "x".repeat(THEME_CSS_MAX_LENGTH + 1);
      await userEvent.fill(field, long);
      await expect
        .element(
          view.screen.getByText(`${THEME_CSS_MAX_LENGTH + 1} of ${THEME_CSS_MAX_LENGTH}`, {
            exact: false,
          }),
        )
        .toBeVisible();
      await userEvent.fill(view.screen.getByRole("textbox", { name: "Theme name" }), "Too long");
      await userEvent.click(view.screen.getByRole("button", { name: "Create theme" }));
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("says that rules loading files are ignored, and still applies the safe rules", async () => {
      await using view = await renderEditor(null);
      await userEvent.click(view.screen.getByRole("button", { name: "Custom CSS" }));
      await userEvent.fill(
        view.screen.getByRole("textbox", { name: "Custom CSS" }),
        `${css} [data-theme-editor-css-probe] { background-image: url(https://example.com/a.png); }`,
      );
      await expect.element(view.screen.getByText("load files", { exact: false })).toBeVisible();
      await expect.poll(() => getComputedStyle(view.probe).color).toBe("rgb(9, 8, 7)");
      expect(getComputedStyle(view.probe).backgroundImage).toBe("none");
    });

    it("opens a theme's saved CSS and keeps it when the theme is saved", async () => {
      invalidateCustomThemes();
      const installed = installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "css-editor-test",
          name: "CSS editor test",
          appearance: "dark",
          colors: { canvas: "#101010", accent: "#7aa2f7" },
          css,
        }),
      );
      using _theme = { [Symbol.dispose]: () => removeCustomTheme(installed.id) };
      const saved: ThemeDefinition[] = [];
      await using view = await renderEditor(installed, (theme) => {
        saved.push(theme);
        return true;
      });
      const trigger = view.screen.getByRole("button", { name: "Custom CSS" });
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      await expect
        .element(view.screen.getByRole("textbox", { name: "Custom CSS" }))
        .toHaveValue(css);
      await save(view.screen);
      expect(saved[0]?.css).toBe(css);
    });

    it("drops the CSS from the saved theme when the field is cleared", async () => {
      invalidateCustomThemes();
      const installed = installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "css-editor-clear",
          name: "CSS editor clear",
          appearance: "dark",
          colors: { canvas: "#101010", accent: "#7aa2f7" },
          css,
        }),
      );
      using _theme = { [Symbol.dispose]: () => removeCustomTheme(installed.id) };
      const saved: ThemeDefinition[] = [];
      await using view = await renderEditor(installed, (theme) => {
        saved.push(theme);
        return true;
      });
      await userEvent.fill(view.screen.getByRole("textbox", { name: "Custom CSS" }), "");
      await save(view.screen);
      expect(saved[0]).not.toHaveProperty("css");
    });
  });
});
