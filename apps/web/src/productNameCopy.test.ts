// @effect-diagnostics nodeBuiltinImport:off - scans the shipped renderer sources on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const sourceRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const sourceFiles = NodeFS.readdirSync(sourceRoot, { recursive: true })
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file))
  .filter((file) => !file.endsWith(".gen.ts"))
  .map((file) => NodePath.join(sourceRoot, file));

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("product name copy", () => {
  it("never renders the upstream product name in user-visible strings", () => {
    const offenders = sourceFiles.flatMap((file) => {
      const source = withoutComments(NodeFS.readFileSync(file, "utf8"));
      const relative = NodePath.relative(sourceRoot, file);
      const strings = source.match(/["'`][^"'`\n]*\bT3\b[^"'`\n]*["'`]/g) ?? [];
      const copy = source.includes("T3 Code") ? ["T3 Code"] : [];
      return [...copy, ...strings].map((text) => `${relative}: ${text}`);
    });
    expect(offenders).toEqual([]);
  });
});
