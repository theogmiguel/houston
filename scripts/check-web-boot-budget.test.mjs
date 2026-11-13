#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { bootClosure, measure } from "./check-web-boot-budget.mjs";

// The shape Vite writes for apps/web: index.html's entry only dynamically imports main.tsx.
const manifest = {
  "index.html": {
    file: "assets/index.js",
    isEntry: true,
    dynamicImports: ["src/main.tsx"],
  },
  "src/main.tsx": {
    file: "assets/main.js",
    isDynamicEntry: true,
    imports: ["_shared.js"],
    dynamicImports: ["src/Palette.tsx"],
    css: ["assets/main.css"],
  },
  "_shared.js": { file: "assets/shared.js", imports: ["_react.js"] },
  "_react.js": { file: "assets/react.js" },
  "src/Palette.tsx": {
    file: "assets/Palette.js",
    isDynamicEntry: true,
    imports: ["_shared.js", "_list.js"],
    css: ["assets/Palette.css"],
  },
  "_list.js": { file: "assets/list.js" },
};

NodeTest.test("counts the entry, the main chunk it preloads and their static imports", () => {
  NodeAssert.deepEqual(bootClosure(manifest), [
    "assets/index.js",
    "assets/main.css",
    "assets/main.js",
    "assets/react.js",
    "assets/shared.js",
  ]);
});

NodeTest.test("leaves out what only a later dynamic import loads", () => {
  const closure = bootClosure(manifest);
  NodeAssert.equal(closure.includes("assets/Palette.js"), false);
  NodeAssert.equal(closure.includes("assets/Palette.css"), false);
  NodeAssert.equal(closure.includes("assets/list.js"), false);
});

NodeTest.test("a static import from the main chunk brings a chunk back into the closure", () => {
  const regressed = {
    ...manifest,
    "src/main.tsx": { ...manifest["src/main.tsx"], imports: ["_shared.js", "_list.js"] },
  };
  NodeAssert.equal(bootClosure(regressed).includes("assets/list.js"), true);
});

NodeTest.test("names a manifest key that is missing", () => {
  const broken = {
    ...manifest,
    "src/main.tsx": { ...manifest["src/main.tsx"], imports: ["_gone.js"] },
  };
  NodeAssert.throws(() => bootClosure(broken), /_gone\.js/);
});

NodeTest.test("refuses a manifest with no entry", () => {
  NodeAssert.throws(
    () => bootClosure({ "_react.js": { file: "assets/react.js" } }),
    /no entry chunk/,
  );
});

NodeTest.test("sums raw and gzip bytes of the files on disk", () => {
  const dist = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boot-budget-"));
  try {
    NodeFS.mkdirSync(NodePath.join(dist, "assets"));
    NodeFS.writeFileSync(NodePath.join(dist, "assets/a.js"), "a".repeat(1000));
    NodeFS.writeFileSync(NodePath.join(dist, "assets/b.css"), "b".repeat(24));
    const result = measure(dist, ["assets/a.js", "assets/b.css"]);
    NodeAssert.equal(result.raw, 1024);
    NodeAssert.ok(result.gzip > 0 && result.gzip < result.raw);
    NodeAssert.deepEqual(
      result.sizes.map((size) => size.file),
      ["assets/a.js", "assets/b.css"],
    );
  } finally {
    NodeFS.rmSync(dist, { recursive: true, force: true });
  }
});
