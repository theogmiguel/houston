// @effect-diagnostics nodeBuiltinImport:off - Vite's build plugin runs before an Effect runtime exists.
import * as NodeFSP from "node:fs/promises";

import type {
  ThirdPartyLicenseEntry,
  ThirdPartyLicenseManifest,
} from "@houston-app/shared/thirdPartyLicenses";
import type { Plugin } from "vite-plus";

const MANIFEST_FILE_NAME = "third-party-licenses.json";

/** The desktop host's inventory (scripts/gen-third-party-licenses.mjs). */
export interface HostLicenseInventory {
  readonly texts: Readonly<Record<string, string>>;
  readonly packages: ReadonlyArray<{
    readonly origin: string;
    readonly name: string;
    readonly version: string | null;
    readonly license: string;
    readonly repository?: string | null;
    readonly note?: string | null;
    readonly textIds?: ReadonlyArray<string>;
  }>;
}

// Cargo crates ship in the desktop host; npm packages in the renderer and its server.
const BUNDLE_BY_ORIGIN: Readonly<Record<string, string>> = {
  asset: "assets",
  cargo: "desktop",
  npm: "web",
};

function httpUrlOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Turns the host inventory into the manifest the Open source licenses page reads. A package the
 * inventory lists under two origins becomes one entry carrying both bundles.
 */
export function hostLicenseManifest(inventory: HostLicenseInventory): ThirdPartyLicenseManifest {
  const entries = new Map<string, ThirdPartyLicenseEntry>();
  for (const item of inventory.packages) {
    const bundle = BUNDLE_BY_ORIGIN[item.origin];
    if (bundle === undefined) {
      throw new Error(
        `License inventory package "${item.name}" has origin "${item.origin}"; expected one of ${Object.keys(BUNDLE_BY_ORIGIN).join(", ")}.`,
      );
    }
    const kind = item.origin === "asset" ? "custom" : "package";
    const key = JSON.stringify([kind, item.name, item.version]);
    const existing = entries.get(key);
    if (existing !== undefined) {
      if (!existing.bundles.includes(bundle)) {
        entries.set(key, { ...existing, bundles: [...existing.bundles, bundle] });
      }
      continue;
    }
    const texts = (item.textIds ?? []).map((id) => {
      const text = inventory.texts[id];
      if (text === undefined) {
        throw new Error(
          `License inventory package "${item.name}" names text "${id}", which the inventory's texts do not contain.`,
        );
      }
      return text.trim();
    });
    entries.set(key, {
      bundles: [bundle],
      kind,
      license: item.license,
      name: item.name,
      noticeText: [item.note?.trim(), ...texts].filter(Boolean).join("\n\n"),
      sourceUrl: httpUrlOrNull(item.repository),
      version: item.version,
    });
  }
  return { schemaVersion: 1, entries: [...entries.values()] };
}

async function readManifest(inventoryPath: URL): Promise<string> {
  const inventory = JSON.parse(
    await NodeFSP.readFile(inventoryPath, "utf8"),
  ) as HostLicenseInventory;
  return `${JSON.stringify(hostLicenseManifest(inventory))}\n`;
}

/** Serves and emits `third-party-licenses.json` built from the host inventory at `inventoryPath`. */
export function hostLicenseManifestPlugin(inventoryPath: URL): Plugin {
  return {
    name: "houston:host-license-manifest",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== `/${MANIFEST_FILE_NAME}`) {
          next();
          return;
        }
        readManifest(inventoryPath).then(
          (manifest) => {
            response.statusCode = 200;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(manifest);
          },
          (error: unknown) => next(error instanceof Error ? error : new Error(String(error))),
        );
      });
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: MANIFEST_FILE_NAME,
        source: await readManifest(inventoryPath),
      });
    },
  };
}
