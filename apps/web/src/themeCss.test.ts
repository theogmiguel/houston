import { describe, expect, it } from "vite-plus/test";

import { checkThemeCss } from "./themeCss";

describe("checkThemeCss", () => {
  it("accepts css within the limit that loads nothing", () => {
    expect(checkThemeCss("[data-chat-header] { border-bottom: 1px solid red; }")).toEqual({
      kind: "ok",
    });
    expect(checkThemeCss("")).toEqual({ kind: "ok" });
  });

  it("names the limit and the length when the css is over it", () => {
    const result = checkThemeCss("x".repeat(20_001));
    expect(result).toMatchObject({ kind: "too-long", length: 20_001, limit: 20_000 });
  });

  it("explains that rules which load files are ignored", () => {
    const result = checkThemeCss("a { background: url(https://example.com/a.png); }");
    expect(result.kind).toBe("loads-files");
    expect(checkThemeCss("@import url(x.css);").kind).toBe("loads-files");
    // A comment may name an address; only a declaration that loads one is ignored.
    expect(checkThemeCss("/* url(https://example.com/a) */ a { color: red; }").kind).toBe("ok");
  });

  it("explains that declarations with a backslash are ignored", () => {
    expect(checkThemeCss("a { background: u\\72l(x); }").kind).toBe("backslash");
    expect(checkThemeCss("/* \\ */ a { color: red; }").kind).toBe("ok");
  });
});
