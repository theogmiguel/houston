// @effect-diagnostics nodeBuiltinImport:off - a plain test that scans the source tree once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { THEME_CSS_HOOKS } from "@houston-app/shared/themeCss";
import { expect, it } from "vite-plus/test";

const sourceDirectory = import.meta.dirname;
const source = NodeFS.readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.(tsx?|css)$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => NodeFS.readFileSync(NodePath.join(sourceDirectory, file), "utf8"))
  .join("\n");

/** How the selector's hook is written in source: an attribute, a slot value, or a class name. */
function sourcePattern(selector: string): RegExp {
  const slot = /^\[data-slot="([a-z-]+)"\]$/.exec(selector)?.[1];
  if (slot) return new RegExp(`data-slot["']?\\s*[:=]\\s*["']${slot}["']`);
  // Workspace areas are rendered through workspaceAreaProps("<name>", ...).
  const area = /^\[data-workspace-area="([a-z-]+)"\]$/.exec(selector)?.[1];
  if (area) return new RegExp(`workspaceAreaProps\\(\\s*["']${area}["']`);
  // A role value comes from the message data, so only the attribute is written in source.
  const attribute = /^\[(data-[a-z-]+)/.exec(selector)?.[1];
  return new RegExp(`(?<![\\w-])${attribute ?? selector.slice(1)}(?![\\w-])`);
}

// Theme CSS and the agent guide rely on these selectors. Rename one in the guide too.
it.each(THEME_CSS_HOOKS.map((hook) => hook.selector))(
  "%s is still in the web source",
  (selector) => {
    expect(sourcePattern(selector).test(source), `${selector} is not in apps/web/src`).toBe(true);
  },
);

it("matches nothing for a selector that is not in the source", () => {
  expect(sourcePattern("[data-removed-hook-for-test]").test(source)).toBe(false);
  expect(sourcePattern('[data-slot="removed-slot-for-test"]').test(source)).toBe(false);
});
