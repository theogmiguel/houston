import { expect, it, vi } from "vite-plus/test";

import { applyThemeCss } from "./themeCss";
import {
  applyThemePalette,
  CUSTOM_THEMES_STORAGE_KEY,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  THEME_FILE_VERSION,
} from "./themePalette";

const REMOTE_HOST = "theme-css-probe.invalid";

function remoteRequests(): ReadonlyArray<string> {
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => name.includes(REMOTE_HOST));
}

function appliedRuleText(): string {
  return document.adoptedStyleSheets
    .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
    .join("\n");
}

it("applies theme CSS and drops every rule that would load a remote file", async () => {
  const probe = document.createElement("div");
  probe.dataset.themeCssProbe = "";
  document.body.append(probe);
  using _probe = { [Symbol.dispose]: () => probe.remove() };
  using _css = { [Symbol.dispose]: () => applyThemeCss(undefined) };
  performance.clearResourceTimings();

  applyThemeCss(`
    @import url(https://${REMOTE_HOST}/sheet.css);
    @namespace svg url(http://www.w3.org/2000/svg);
    @property --registered { syntax: "<url>"; inherits: false; initial-value: url(https://${REMOTE_HOST}/d); }
    @counter-style leak { system: cyclic; symbols: url(https://${REMOTE_HOST}/f); }
    @keyframes leak { to { background-image: url(https://${REMOTE_HOST}/g); } }
    @font-face { font-family: leak; src: url(https://${REMOTE_HOST}/font.woff2); }
    :root { --leak: u\\72l(https://${REMOTE_HOST}/a); }
    [data-theme-css-probe] {
      color: rgb(1, 2, 3);
      background-image: u\\72l(https://${REMOTE_HOST}/b);
      list-style-image: var(--leak);
      border-image-source: var(--registered);
      mask-image: v\\61r(--none, u\\72l(https://${REMOTE_HOST}/e));
      content: image-set("https://${REMOTE_HOST}/h" 1x);
      cursor: url(" data:/../../x"), auto;
      @media (min-width: 0px) { cursor: url(https://${REMOTE_HOST}/c), auto; }
    }
  `);
  // Reading the computed style and the layout resolves every image the cascade names, which is
  // when a fetch would start.
  probe.getBoundingClientRect();
  const style = getComputedStyle(probe);
  // Safe declarations in the same theme still apply.
  expect(style.color).toBe("rgb(1, 2, 3)");
  expect(style.backgroundImage).toBe("none");
  expect(style.listStyleImage).toBe("none");
  expect(style.borderImageSource).toBe("none");
  expect(style.maskImage).toBe("none");
  expect(style.cursor).toBe("auto");
  expect(appliedRuleText()).not.toContain(REMOTE_HOST);
  await vi.waitFor(() => expect(remoteRequests()).toEqual([]));

  applyThemeCss(undefined);
  expect(getComputedStyle(probe).color).not.toBe("rgb(1, 2, 3)");
});

it("keeps data: and #id references and removes the previous theme's rules on replacement", () => {
  const probe = document.createElement("div");
  probe.dataset.themeCssProbe = "";
  document.body.append(probe);
  using _probe = { [Symbol.dispose]: () => probe.remove() };
  using _css = { [Symbol.dispose]: () => applyThemeCss(undefined) };

  applyThemeCss(
    '[data-theme-css-probe] { background-image: url("data:image/gif;base64,R0lGODlhAQABAAAAACw="); border-color: rgb(4, 5, 6); }',
  );
  expect(getComputedStyle(probe).backgroundImage).toContain("data:image/gif");

  applyThemeCss("[data-theme-css-probe] { border-top-color: rgb(7, 8, 9); }");
  expect(getComputedStyle(probe).backgroundImage).toBe("none");
  expect(getComputedStyle(probe).borderTopColor).toBe("rgb(7, 8, 9)");
});

it("applies the active theme's CSS and removes it when another theme becomes active", () => {
  const probe = document.createElement("div");
  probe.dataset.themeCssProbe = "";
  document.body.append(probe);
  const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  using _cleanup = {
    [Symbol.dispose]: () => {
      probe.remove();
      applyThemeCss(undefined);
      if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
      else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
      invalidateCustomThemes();
    },
  };
  invalidateCustomThemes();
  const styled = installCustomTheme(
    parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "css-apply-test",
      name: "CSS apply test",
      appearance: "dark",
      colors: { canvas: "#101010", accent: "#7aa2f7" },
      css: "[data-theme-css-probe] { color: rgb(11, 12, 13); background-image: url(https://theme-css-probe.invalid/x); }",
    }),
  );

  applyThemePalette(styled.id, "dark");
  expect(getComputedStyle(probe).color).toBe("rgb(11, 12, 13)");
  expect(getComputedStyle(probe).backgroundImage).toBe("none");

  applyThemePalette("grove", "light");
  expect(getComputedStyle(probe).color).not.toBe("rgb(11, 12, 13)");
});
