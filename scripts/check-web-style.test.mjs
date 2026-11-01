#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";

import { hasAttr, stripJsxExpressions } from "./check-web-style.mjs";

test("hasAttr reads a literal attribute", () => {
  assert.equal(hasAttr(' className="x" title="More"', "title"), true);
  assert.equal(hasAttr(" title='More'", "title"), true);
});

test("hasAttr reads an attribute whose value is a JSX expression", () => {
  assert.equal(hasAttr(" title={label}", "title"), true);
  assert.equal(hasAttr(" title={selected ? a : b}", "title"), true);
});

test("hasAttr ignores a property named title inside an event handler", () => {
  const attrs = " onClick={() => { const title = composedPath.find(Boolean); }}";
  assert.equal(hasAttr(attrs, "title"), false);
});

test("hasAttr ignores destructuring and strings that contain braces", () => {
  const attrs = ' onClick={() => { const { title } = item; const s = "}"; }}';
  assert.equal(hasAttr(attrs, "title"), false);
  assert.equal(stripJsxExpressions(attrs).includes("title"), false);
});

test("hasAttr keeps an attribute that precedes a handler", () => {
  const attrs = ' title="More" onClick={() => { const title = 1; }}';
  assert.equal(hasAttr(attrs, "title"), true);
});

test("hasAttr does not mistake a prefixed attribute for the bare name", () => {
  assert.equal(hasAttr(' data-title="More"', "title"), false);
});

test("hasAttr still sees an attribute after a spread", () => {
  const attrs = " {...props} title={label}";
  assert.equal(hasAttr(attrs, "title"), true);
});
