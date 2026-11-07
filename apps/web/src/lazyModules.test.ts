// @effect-diagnostics nodeBuiltinImport:off - scans the shipped renderer sources on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const sourceRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const sourceFiles = NodeFS.readdirSync(sourceRoot, { recursive: true })
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file))
  .map((file) => file.replaceAll("\\", "/"));

// Modules too large for the boot bundle that only some views need: each may be imported
// statically only from modules already behind a route split or `import()`.
const LAZY_MODULES: Record<string, ReadonlyArray<string>> = {
  "components/ThreadTerminalDrawer": [
    "components/onboarding/WelcomeWizard.tsx",
    "components/settings/ProviderAuthTerminal.tsx",
    "components/settings/SettingsFontPreviews.tsx",
  ],
  "components/pullRequest/PullRequestDetailPanel": ["components/pullRequest/PullRequestsPage.tsx"],
};

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+["']([^"']+)["']/gm;

function resolveSpecifier(importer: string, specifier: string): string | null {
  if (specifier.startsWith("~/")) return specifier.slice(2);
  if (!specifier.startsWith(".")) return null;
  return NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(importer), specifier));
}

describe("lazy modules", () => {
  it("reaches each boot-heavy module only through import() or a split route", () => {
    const offenders = sourceFiles.flatMap((file) => {
      const source = NodeFS.readFileSync(NodePath.join(sourceRoot, file), "utf8");
      return [...source.matchAll(STATIC_IMPORT)].flatMap(([, specifier]) => {
        const target = resolveSpecifier(file, specifier!);
        const allowed = target === null ? undefined : LAZY_MODULES[target];
        return allowed === undefined || allowed.includes(file) ? [] : [`${file} -> ${target}`];
      });
    });
    expect(offenders).toEqual([]);
  });
});
