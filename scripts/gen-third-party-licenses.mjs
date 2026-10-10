#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "third-party-licenses.config.json");
const DEFAULT_OUT = join(ROOT, "src-tauri", "resources", "third-party-licenses.json");
// --out lets the staleness gate regenerate beside the committed file and diff the two,
// rather than overwriting the tree it is checking.
const outFlag = process.argv.indexOf("--out");
if (outFlag !== -1 && !process.argv[outFlag + 1]) {
  process.stderr.write("gen-third-party-licenses: --out needs a path, e.g. --out /tmp/inventory.json\n");
  process.exit(2);
}
const OUT = outFlag === -1 ? DEFAULT_OUT : resolve(process.argv[outFlag + 1]);

// A licence file runs to a few tens of kilobytes; anything past this is a corpus
// a package happened to name LICENSE, and carrying it would bury the real ones.
const MAX_LICENCE_BYTES = 64 * 1024;
const LICENCE_FILE = /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)([-._].*)?$/i;
const NOT_A_LICENCE = /\.(spdx|json|toml|yml|yaml|py|rs|js|ts)$/i;

const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
const overrides = cfg.packageOverrides ?? {};
const texts = new Map();

function textId(body) {
  const id = createHash("sha256").update(body).digest("hex").slice(0, 16);
  if (!texts.has(id)) texts.set(id, body);
  return id;
}

function licenceTexts(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const ids = [];
  for (const name of names.sort()) {
    if (!LICENCE_FILE.test(name) || NOT_A_LICENCE.test(name)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile() || statSync(path).size > MAX_LICENCE_BYTES) continue;
      const body = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trimEnd();
      if (body) ids.push(textId(body));
    } catch {
      /* unreadable file: the package is still listed, without this text */
    }
  }
  return [...new Set(ids)];
}

function applyOverride(entry) {
  const o = overrides[`${entry.name}@${entry.version}`] ?? overrides[entry.name];
  if (!o) return entry;
  if (o.license) entry.license = o.license;
  if (o.repository) entry.repository = o.repository;
  if (o.note) entry.note = o.note;
  if (o.licenseText) entry.textIds = [textId(o.licenseText.replace(/\r\n/g, "\n").trimEnd())];
  return entry;
}

// Cargo: the normal-dependency closure of the workspace's own crates. Build and dev
// dependencies run on the build machine and are never linked into what ships.
function cargoPackages(manifest) {
  const raw = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--manifest-path", manifest],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, cwd: ROOT },
  );
  const meta = JSON.parse(raw);
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const members = new Set(meta.workspace_members);

  const seen = new Set();
  const queue = [...members];
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      const normal = dep.dep_kinds.some((k) => k.kind === null || k.kind === undefined);
      if (normal && !seen.has(dep.pkg)) queue.push(dep.pkg);
    }
  }

  const out = [];
  for (const id of seen) {
    if (members.has(id)) continue;
    const p = byId.get(id);
    // A crate of ours reached as a path dependency is a member of the other
    // workspace, not a third party, so `workspace_members` alone misses it.
    // Vendored upstream crates under src-tauri/patches/ stay third party.
    if (!p) continue;
    const fromRoot = relative(ROOT, resolve(p.manifest_path));
    const outside = isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`);
    const vendored = fromRoot.startsWith(join("src-tauri", "patches") + sep);
    if (!outside && !vendored) continue;
    out.push(
      applyOverride({
        origin: "cargo",
        name: p.name,
        version: p.version,
        license: p.license ?? null,
        repository: p.repository ?? null,
        textIds: licenceTexts(dirname(p.manifest_path)),
      }),
    );
  }
  return out;
}

// npm: the production closure only. devDependencies build the renderer; they are not
// in the bundle Vite emits, so they are not in what ships.
function npmPackages() {
  const uiRoot = join(ROOT, "ui");
  const modules = join(uiRoot, "node_modules");
  const resolvePkg = (name, from) => {
    let dir = from;
    for (;;) {
      const candidate = join(dir, "node_modules", name, "package.json");
      if (existsSync(candidate)) return candidate;
      if (dir === uiRoot) return null;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };

  const seen = new Map();
  const queue = Object.keys(JSON.parse(readFileSync(join(uiRoot, "package.json"), "utf8")).dependencies ?? {})
    .map((name) => ({ name, from: uiRoot }));
  while (queue.length) {
    const { name, from } = queue.pop();
    const manifest = resolvePkg(name, from);
    if (!manifest) continue;
    const dir = dirname(manifest);
    if (seen.has(dir)) continue;
    const p = JSON.parse(readFileSync(manifest, "utf8"));
    seen.set(dir, p);
    for (const dep of Object.keys(p.dependencies ?? {})) queue.push({ name: dep, from: dir });
  }

  const out = [];
  for (const [dir, p] of seen) {
    const license = typeof p.license === "string" ? p.license : (p.license?.type ?? null);
    const repository = typeof p.repository === "string" ? p.repository : (p.repository?.url ?? null);
    out.push(
      applyOverride({
        origin: "npm",
        name: p.name,
        version: p.version,
        license,
        repository: repository ? repository.replace(/^git\+/, "").replace(/\.git$/, "") : null,
        textIds: licenceTexts(dir),
      }),
    );
  }
  if (!out.length) throw new Error(`no npm packages found under ${modules} — run \`cd ui && bun install\` first`);
  return out;
}

function assetPackages() {
  return (cfg.customNotices ?? []).map((n) => ({
    origin: "asset",
    name: n.name,
    version: n.version ?? null,
    license: n.license ?? null,
    repository: n.repository ?? null,
    note: n.note,
    textIds: n.licenseText ? [textId(n.licenseText.replace(/\r\n/g, "\n").trimEnd())] : [],
  }));
}

const packages = [
  ...assetPackages(),
  ...cargoPackages(join(ROOT, "core", "Cargo.toml")),
  ...cargoPackages(join(ROOT, "src-tauri", "Cargo.toml")),
  ...npmPackages(),
];

const deduped = new Map();
for (const p of packages) {
  const key = `${p.origin}\u0000${p.name}\u0000${p.version}`;
  if (!deduped.has(key)) deduped.set(key, p);
}

const ORDER = { asset: 0, cargo: 1, npm: 2 };
const sorted = [...deduped.values()].sort(
  (a, b) =>
    ORDER[a.origin] - ORDER[b.origin] ||
    a.name.localeCompare(b.name, "en") ||
    String(a.version).localeCompare(String(b.version), "en"),
);

const used = new Set(sorted.flatMap((p) => p.textIds));
const doc = {
  texts: Object.fromEntries([...texts].filter(([id]) => used.has(id)).sort(([a], [b]) => a.localeCompare(b, "en"))),
  packages: sorted,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

const noLicence = sorted.filter((p) => !p.license);
const noText = sorted.filter((p) => !p.textIds.length);
process.stderr.write(
  `gen-third-party-licenses: ${sorted.length} packages, ${Object.keys(doc.texts).length} distinct licence texts\n` +
    `  no licence field: ${noLicence.length}${noLicence.length ? ` (${noLicence.map((p) => p.name).join(", ")})` : ""}\n` +
    `  no licence text on disk: ${noText.length}${noText.length ? ` — add a licenseText to packageOverrides if one is owed` : ""}\n`,
);
