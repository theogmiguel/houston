import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EnvironmentThemeFile, THEME_CSS_MAX_LENGTH } from "./server.ts";

const decode = Schema.decodeUnknownSync(EnvironmentThemeFile);
const base = { name: "Night", appearance: "dark", canvas: "#101010", accent: "#7aa2f7" } as const;

describe("environment theme css", () => {
  it("keeps css that fits the limit", () => {
    const css = "x".repeat(THEME_CSS_MAX_LENGTH);
    expect(decode({ ...base, css }).css).toBe(css);
  });

  it("refuses css over the limit", () => {
    expect(() => decode({ ...base, css: "x".repeat(THEME_CSS_MAX_LENGTH + 1) })).toThrow();
  });
});
