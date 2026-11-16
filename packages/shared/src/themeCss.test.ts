import { describe, expect, it } from "vite-plus/test";

import { themeCssLoadsRemoteFiles, themeCssValueFetches } from "./themeCss.ts";

describe("themeCssValueFetches", () => {
  it.each([
    ["background-image", 'url("https://example.com/a")', true],
    ["background-image", 'url("/api/thing")', true],
    ["background-image", 'image-set("https://example.com/a" 1x)', true],
    // An unparsed value keeps its escapes, so an escaped function name hides in it.
    ["--leak", "u\\72l(https://example.com/a)", true],
    ["background-image", "im\\61ge-set(var(--leak) 1x)", true],
    ["background-image", "v\\61r(--none, u\\72l(https://example.com/a))", true],
    // A no-break space before the scheme makes this a path on the app's own origin.
    ["background-image", 'url(" data:/../../probe")', true],
    ["background-image", "url( data:/../../probe)", true],
    ["background-image", 'url("data:image/png;base64,AA")', false],
    ["background-image", "url( data:image/png;base64,AA )", false],
    ["filter", 'url("#blur")', false],
    ["background-image", "var(--pattern)", false],
    ["color", "red", false],
  ])("%s: %s", (_property, value, fetches) => {
    expect(themeCssValueFetches(value)).toBe(fetches);
  });
});

describe("themeCssLoadsRemoteFiles", () => {
  it.each([
    ["@import url(https://example.com/a.css);", true],
    ["a { background: url(https://example.com/a); }", true],
    ["a { background: image-set('x.png' 1x); }", true],
    ["a { color: red; }", false],
    // A comment may name an address. Only a rule that loads one is refused.
    ["/* url(https://example.com/guide) */ a { color: red; }", false],
    ['a { background: url("data:image/png;base64,AA"); }', false],
  ])("%s", (css, loads) => {
    expect(themeCssLoadsRemoteFiles(css)).toBe(loads);
  });
});
