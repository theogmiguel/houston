// @effect-diagnostics nodeBuiltinImport:off - destinations are checked against the host's path rules.
// The transfer rules on literal values: no file system, git or database.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  agentConfigPaths,
  checkDestination,
  checkPassphrase,
  entryNameProblem,
  itemsWithCount,
  remotesMatch,
  secretNames,
  stripRemoteCredentials,
  transferFileName,
  unportableNames,
} from "./rules.ts";

const EXPORT = "houston.transfer.export";

describe("the passphrase is bounded by characters and bytes", () => {
  it("the passphrase is bounded by characters and bytes", () => {
    const cases: ReadonlyArray<{
      readonly passphrase: string;
      readonly kind: string | null;
      readonly limit?: number;
      readonly actual?: number;
    }> = [
      { passphrase: "a".repeat(11), kind: "invalid", limit: 12, actual: 11 },
      { passphrase: "a".repeat(12), kind: null },
      { passphrase: "a".repeat(1_025), kind: "limit", limit: 1_024, actual: 1_025 },
      // Twelve characters of four bytes each: the minimum counts characters, not bytes.
      { passphrase: "\u{1F600}".repeat(12), kind: null },
    ];
    expect(new TextEncoder().encode(cases[3]!.passphrase).length).toBe(48);
    for (const entry of cases) {
      const refusal = checkPassphrase(entry.passphrase, EXPORT);
      if (entry.kind === null) {
        expect(refusal, `${entry.passphrase.length}`).toBeNull();
        continue;
      }
      expect(refusal?.kind).toBe(entry.kind);
      expect(refusal?.limit).toBe(entry.limit);
      expect(refusal?.actual).toBe(entry.actual);
      expect(refusal?.operation).toBe(EXPORT);
      expect(refusal?.problem).toContain(String(entry.limit));
      expect(refusal?.problem).toContain(String(entry.actual));
      expect(JSON.stringify(refusal)).not.toContain(entry.passphrase.slice(0, 11));
    }
  });
});

describe("destinations are absolute paths in an existing folder", () => {
  it("destinations are absolute paths in an existing folder", () => {
    const root = NodePath.resolve("/transfer-destinations");
    const absolute = NodePath.join(root, "move");
    expect(transferFileName(absolute)).toBe(`${absolute}.houston-transfer`);
    expect(transferFileName(`${absolute}.houston-transfer`)).toBe(`${absolute}.houston-transfer`);

    const relative = checkDestination({
      destination: "move.houston-transfer",
      folderExists: true,
      fileExists: false,
      overwrite: false,
    });
    expect(relative?.kind).toBe("invalid");
    expect(relative?.items).toEqual(["move.houston-transfer"]);

    const missing = checkDestination({
      destination: NodePath.join(root, "missing", "move.houston-transfer"),
      folderExists: false,
      fileExists: false,
      overwrite: false,
    });
    expect(missing?.kind).toBe("invalid");
    expect(missing?.items).toEqual([NodePath.join(root, "missing")]);

    const target = `${absolute}.houston-transfer`;
    const exists = checkDestination({
      destination: target,
      folderExists: true,
      fileExists: true,
      overwrite: false,
    });
    expect(exists?.kind).toBe("destination_exists");
    expect(exists?.items).toEqual([target]);
    expect(
      checkDestination({
        destination: target,
        folderExists: true,
        fileExists: true,
        overwrite: true,
      }),
    ).toBeNull();
    expect(
      checkDestination({
        destination: target,
        folderExists: true,
        fileExists: false,
        overwrite: false,
      }),
    ).toBeNull();
  });
});

describe("untracked names another computer cannot carry are listed", () => {
  it("untracked names another computer cannot carry are listed", () => {
    for (const name of [
      "notes:v2.txt",
      "a?b",
      "aux.md",
      "trailing.",
      "space ",
      "dir/NUL.txt",
      "sub/.git/config",
      "a<b",
      "a>b",
      'a"b',
      "a|b",
      "a*b",
      "a\\b",
      "con",
      "lpt1.log",
    ]) {
      const problems = unportableNames([name, "src/lib.rs"]);
      expect(problems, name).toHaveLength(1);
      expect(problems[0], name).toContain(name);
    }
    const folded = unportableNames(["Readme.md", "src/lib.rs", "README.md"]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toContain("Readme.md");
    expect(folded[0]).toContain("README.md");
    expect(
      unportableNames(["src/lib.rs", "notes/console.md", "a/b/c.d.e", ".github/x.yml"]),
    ).toEqual([]);
  });

  it("entry names are relative paths of ordinary components", () => {
    for (const name of [
      "",
      "../x",
      "a/../b",
      "/etc/passwd",
      "C:/x",
      "c:x",
      "a//b",
      "./a",
      "a/.git/config",
      ".git",
      "a/b\u0000",
      "a/b\n",
      "dir/NUL.txt",
      "trailing.",
    ]) {
      expect(entryNameProblem(name), JSON.stringify(name)).not.toBeNull();
    }
    for (const name of [
      "manifest.json",
      "threads/0/thread.json",
      "checkouts/1/untracked/a b.txt",
    ]) {
      expect(entryNameProblem(name), name).toBeNull();
    }
  });

  it("a refusal lists twenty items and counts the rest", () => {
    const items = Array.from({ length: 23 }, (_, index) => `item-${index}`);
    expect(itemsWithCount(items)).toEqual([...items.slice(0, 20), "and 3 more"]);
    expect(itemsWithCount(items.slice(0, 20))).toEqual(items.slice(0, 20));
  });
});

describe("secret-like untracked names are refused", () => {
  it("secret-like untracked names are refused", () => {
    const refused = [
      ".env",
      ".env.local",
      "config/.env.production",
      "config/prod.key",
      "cert.pem",
      "store.p12",
      "store.pfx",
      "app.keystore",
      "app.jks",
      "id_rsa",
      "id_rsa.pub",
      "id_dsa",
      "keys/id_ecdsa",
      "id_ed25519",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      "credentials.json",
      "secrets.json",
      "deploy/SECRETS.JSON",
    ];
    const carried = [
      ".env.example",
      ".env.sample",
      ".env.template",
      "keys.md",
      "src/key.ts",
      "id.txt",
      "environment.ts",
      "my.env.ts",
    ];
    expect(secretNames([...refused, ...carried])).toEqual(refused);
  });
});

describe("remote credentials are stripped before they are recorded", () => {
  it("remote credentials are stripped before they are recorded", () => {
    expect(stripRemoteCredentials("https://ghp_abc@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
    expect(stripRemoteCredentials("https://user:pass@gitlab.example.com:8443/o/r.git")).toBe(
      "https://gitlab.example.com:8443/o/r.git",
    );
    expect(stripRemoteCredentials("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(stripRemoteCredentials("/srv/git/r.git")).toBe("/srv/git/r.git");
    expect(stripRemoteCredentials("file:///srv/git/r.git")).toBe("file:///srv/git/r.git");
    expect(stripRemoteCredentials(null)).toBeNull();
    expect(stripRemoteCredentials("ssh://git:secret@host/o/r.git")).toBe("ssh://host/o/r.git");
  });
});

describe("remotes match by host and path whatever their spelling", () => {
  it("remotes match by host and path whatever their spelling", () => {
    expect(remotesMatch("https://github.com/O/R.git", "git@github.com:o/r")).toBe(true);
    expect(remotesMatch("ssh://git@github.com/o/r.git", "https://GitHub.com/o/r")).toBe(true);
    expect(remotesMatch("https://github.com/o/r.git", "https://github.com/o/r2")).toBe(false);
    expect(remotesMatch("https://github.com/o/r.git", "https://gitlab.com/o/r.git")).toBe(false);
    expect(remotesMatch(null, "https://github.com/o/r.git")).toBe(false);
    expect(remotesMatch("/srv/git/r.git", "/srv/git/r.git")).toBe(true);
  });
});

describe("agent configuration paths are listed at any depth", () => {
  it("agent configuration paths are listed at any depth", () => {
    const listed = [
      ".claude/settings.local.json",
      "src/.envrc",
      ".mcp.json",
      "pkg/AGENTS.md",
      ".github/workflows/ci.yml",
      ".vscode/tasks.json",
      ".husky/pre-commit",
      ".gitattributes",
      ".codex/config.toml",
      ".gemini/settings.json",
      ".opencode/agent.md",
      ".cursor/rules",
      ".idea/workspace.xml",
      "CLAUDE.md",
      "sub/GEMINI.md",
      "vendor/.gitmodules",
    ];
    const notListed = ["docs/claude.md", "src/agents.ts", "github/readme.md", "notes.txt"];
    expect(agentConfigPaths([...notListed, ...listed])).toEqual(listed);
  });
});
