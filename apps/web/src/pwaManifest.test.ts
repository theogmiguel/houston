// @effect-diagnostics nodeBuiltinImport:off - reads the shipped manifest and icons on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const webRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const publicDir = NodePath.join(webRoot, "public");

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

const manifest = JSON.parse(
  NodeFS.readFileSync(NodePath.join(publicDir, "manifest.webmanifest"), "utf8"),
) as { readonly icons: ReadonlyArray<ManifestIcon> };
const indexHtml = NodeFS.readFileSync(NodePath.join(webRoot, "index.html"), "utf8");

function pngSize(file: string): string {
  const header = NodeFS.readFileSync(file).subarray(0, 24);
  expect(header.subarray(1, 4).toString("ascii"), `${file} is not a PNG`).toBe("PNG");
  return `${header.readUInt32BE(16)}x${header.readUInt32BE(20)}`;
}

describe("installable web manifest", () => {
  it("declares 192 and 512 PNG icons for 'any' plus one maskable icon", () => {
    const purposeOf = (icon: ManifestIcon) => icon.purpose ?? "any";
    const anySizes = manifest.icons
      .filter((icon) => icon.type === "image/png" && purposeOf(icon) === "any")
      .map((icon) => icon.sizes);
    const maskable = manifest.icons.filter((icon) => purposeOf(icon) === "maskable");

    expect(anySizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(maskable).toHaveLength(1);
    expect(maskable[0]?.type).toBe("image/png");
  });

  it("points every icon at a file under public with the declared pixel size", () => {
    for (const icon of manifest.icons) {
      const file = NodePath.join(publicDir, icon.src.replace(/^\//, ""));
      expect(NodeFS.existsSync(file), `${icon.src} is missing from apps/web/public`).toBe(true);
      expect(pngSize(file), `${icon.src} does not match its declared size`).toBe(icon.sizes);
    }
  });

  it("is linked once, with an apple-touch-icon and a theme color, from index.html", () => {
    const count = (pattern: RegExp) => indexHtml.match(pattern)?.length ?? 0;
    expect(count(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/g)).toBe(1);
    expect(count(/<link\s+rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"/g)).toBe(1);
    expect(count(/<meta\s+name="theme-color"/g)).toBe(1);
  });
});
