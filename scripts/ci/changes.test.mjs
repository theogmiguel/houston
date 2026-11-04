#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { decide, formatOutputs, OUTPUTS } from "./changes.mjs";

NodeTest.test("a server-only change does not set native", () => {
  const outputs = decide(["apps/server/src/server.ts"]);
  NodeAssert.equal(outputs.server, true);
  NodeAssert.equal(outputs.native, false);
  NodeAssert.equal(outputs.web, false);
  NodeAssert.equal(outputs.docs_only, false);
});

NodeTest.test("a native-only change does not set the server or web jobs", () => {
  const outputs = decide(["native/kde-snap-shot/src/lib.rs"]);
  NodeAssert.equal(outputs.native, true);
  NodeAssert.equal(outputs.server, false);
  NodeAssert.equal(outputs.web, false);
});

NodeTest.test("a desktop change runs the package suite, not the renderer jobs", () => {
  const outputs = decide(["apps/desktop/src/main.ts"]);
  NodeAssert.equal(outputs.packages, true);
  NodeAssert.equal(outputs.native, false);
  NodeAssert.equal(outputs.web, false);
  NodeAssert.equal(outputs.server, false);
});

NodeTest.test("a desktop native crate change also runs the native job", () => {
  const outputs = decide(["apps/desktop/native/houston-v1-cleanup/src/lib.rs"]);
  NodeAssert.equal(outputs.packages, true);
  NodeAssert.equal(outputs.native, true);
});

NodeTest.test("a path matching no rule sets every job", () => {
  const outputs = decide(["mystery/file.xyz"]);
  for (const key of OUTPUTS) {
    if (key === "docs_only") NodeAssert.equal(outputs[key], false, key);
    else NodeAssert.equal(outputs[key], true, key);
  }
});

NodeTest.test("an empty diff sets every job", () => {
  const outputs = decide(["", "  "]);
  for (const key of OUTPUTS) {
    if (key === "docs_only") NodeAssert.equal(outputs[key], false, key);
    else NodeAssert.equal(outputs[key], true, key);
  }
});

NodeTest.test("a workflow change sets every job", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    "scripts/ci/changes.mjs",
  ]) {
    const outputs = decide([path]);
    for (const key of OUTPUTS) {
      if (key === "docs_only") NodeAssert.equal(outputs[key], false, `${path} ${key}`);
      else NodeAssert.equal(outputs[key], true, `${path} ${key}`);
    }
  }
});

NodeTest.test("a docs-only change sets only the docs marker", () => {
  const outputs = decide(["docs/internals/ci.md", "README.md"]);
  NodeAssert.equal(outputs.docs_only, true);
  for (const key of OUTPUTS) {
    if (key !== "docs_only") NodeAssert.equal(outputs[key], false, key);
  }
});

NodeTest.test("a dependency change runs the node jobs but not native", () => {
  const outputs = decide(["pnpm-lock.yaml"]);
  NodeAssert.equal(outputs.deps, true);
  NodeAssert.equal(outputs.server, true);
  NodeAssert.equal(outputs.web, true);
  NodeAssert.equal(outputs.packages, true);
  NodeAssert.equal(outputs.native, false);
});

NodeTest.test("mixed docs and code is not docs-only", () => {
  const outputs = decide(["docs/internals/ci.md", "apps/web/src/main.tsx"]);
  NodeAssert.equal(outputs.docs_only, false);
  NodeAssert.equal(outputs.web, true);
});

NodeTest.test("Windows-style separators classify the same way", () => {
  const outputs = decide(["apps\\server\\src\\server.ts"]);
  NodeAssert.equal(outputs.server, true);
  NodeAssert.equal(outputs.native, false);
});

NodeTest.test("outputs render as GitHub step output lines", () => {
  NodeAssert.equal(
    formatOutputs(decide(["apps/server/src/server.ts"])),
    "web=false\nserver=true\npackages=false\nnative=false\nworkflows=false\ndeps=false\ndocs_only=false\n",
  );
});
