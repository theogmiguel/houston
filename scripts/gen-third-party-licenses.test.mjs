#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkspaceMembers } from "./gen-third-party-licenses.mjs";

const yaml = (...lines) => lines.join(String.fromCharCode(10));

test("workspace members lists bare paths and one-level globs in order", () => {
  const text = yaml("packages:", "  - apps/server", "  - packages/*", "  - scripts", "");
  assert.deepEqual(parseWorkspaceMembers(text), ["apps/server", "packages/*", "scripts"]);
});

test("workspace members ignores column-0 comments inside the list", () => {
  const text = yaml("packages:", "  - apps/server", "# a comment at column 0", "  - scripts", "");
  assert.deepEqual(parseWorkspaceMembers(text), ["apps/server", "scripts"]);
});

test("workspace members ignores trailing comments and blank lines", () => {
  const text = yaml("packages: # members", "  - scripts # tooling", "", '  - "packages/*"  # quoted', "");
  assert.deepEqual(parseWorkspaceMembers(text), ["scripts", "packages/*"]);
});

test("workspace members accepts a list indented at the key's column", () => {
  const text = yaml("packages:", "- apps/server", "- scripts", "", "allowBuilds:", "  esbuild: true", "");
  assert.deepEqual(parseWorkspaceMembers(text), ["apps/server", "scripts"]);
});

test("workspace members stops at the next top-level key", () => {
  const text = yaml("packages:", "  - scripts", "catalog:", "  - not-a-member", "");
  assert.deepEqual(parseWorkspaceMembers(text), ["scripts"]);
});

test("workspace members throws naming a recursive glob", () => {
  const text = yaml("packages:", "  - scripts", "  - packages/**", "");
  assert.throws(() => parseWorkspaceMembers(text), /unsupported workspace member "packages\/\*\*"/);
});

test("workspace members throws naming a negation", () => {
  const text = yaml("packages:", "  - scripts", '  - "!packages/legacy"', "");
  assert.throws(() => parseWorkspaceMembers(text), /unsupported workspace member "!packages\/legacy"/);
});

test("workspace members throws on an entry that is not a dash line", () => {
  const text = yaml("packages:", "  - scripts", "    nested: true", "");
  assert.throws(() => parseWorkspaceMembers(text), /not a "- path" line: nested: true/);
});

test("workspace members throws on a flow-style packages value", () => {
  assert.throws(() => parseWorkspaceMembers("packages: [scripts]"), /must be a block list/);
});

test("workspace members is empty when pnpm-workspace.yaml has no packages key", () => {
  assert.deepEqual(parseWorkspaceMembers(yaml("allowBuilds:", "  esbuild: true", "")), []);
});
