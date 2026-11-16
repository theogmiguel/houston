import { decodeThirdPartyLicenseManifest } from "@houston-app/shared/thirdPartyLicenses";
import { expect, it } from "vite-plus/test";

import inventory from "../../../apps/desktop/resources/third-party-licenses.json" with { type: "json" };
import { hostLicenseManifest, type HostLicenseInventory } from "../vite/hostLicenseManifest";

it("builds a manifest the licenses page decodes from the committed host inventory", () => {
  const manifest = decodeThirdPartyLicenseManifest(
    hostLicenseManifest(inventory as HostLicenseInventory),
  );

  expect(manifest.entries.length).toBeGreaterThan(0);
  const ghostty = manifest.entries.find((entry) => entry.name.startsWith("libghostty-vt"));
  expect(ghostty).toMatchObject({ kind: "custom", bundles: ["assets"], license: "MIT" });
  expect(ghostty?.noticeText).toContain("WebAssembly build");
});

it("merges a package listed under two origins into one entry with both bundles", () => {
  const manifest = hostLicenseManifest({
    texts: { mit: "MIT text" },
    packages: [
      { origin: "npm", name: "shared", version: "1.0.0", license: "MIT", textIds: ["mit"] },
      { origin: "cargo", name: "shared", version: "1.0.0", license: "MIT", textIds: ["mit"] },
    ],
  });

  expect(manifest.entries).toEqual([
    {
      bundles: ["web", "desktop"],
      kind: "package",
      license: "MIT",
      name: "shared",
      noticeText: "MIT text",
      sourceUrl: null,
      version: "1.0.0",
    },
  ]);
});

it("names the package and the missing text when the inventory is inconsistent", () => {
  expect(() =>
    hostLicenseManifest({
      texts: {},
      packages: [
        { origin: "npm", name: "left-pad", version: "1.0.0", license: "MIT", textIds: ["gone"] },
      ],
    }),
  ).toThrow('License inventory package "left-pad" names text "gone"');
});
