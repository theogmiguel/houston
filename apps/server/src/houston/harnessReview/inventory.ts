// The shape of a project's agent harness, read from its own files and the user's skills. A file
// it cannot read or parse is listed with its error; the inventory is still written.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Yaml from "yaml";

/** Instruction files sit at the root or a project level down; four levels cover a monorepo. */
const MAX_DEPTH = 4;
/** Bounds a walk over a project full of generated directories. */
const MAX_DIRS = 20_000;
/** Claude loads `.claude/rules/` recursively; these bound that walk. */
const RULES_MAX_DEPTH = 8;
const RULES_MAX_FILES = 1_000;
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "target", ".houston"]);
const INSTRUCTION_FILES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]);

export interface Heading {
  readonly level: number;
  readonly text: string;
}
export interface InstructionEntry {
  readonly path: string;
  readonly bytes?: number;
  readonly lines?: number;
  readonly headings?: ReadonlyArray<Heading>;
  readonly error?: string;
}
export interface RuleEntry {
  readonly path: string;
  readonly bytes?: number;
  readonly paths: ReadonlyArray<string>;
  readonly error?: string;
}
export interface SkillEntry {
  readonly path: string;
  readonly scope: "repo" | "user";
  readonly bytes?: number;
  readonly name: string | null;
  readonly version?: string | null;
  readonly description_chars?: number;
  readonly disable_model_invocation?: boolean;
  readonly user_invocable?: boolean;
  readonly error?: string;
}
export interface SettingsEntry {
  readonly path: string;
  readonly allow?: ReadonlyArray<string>;
  readonly deny?: ReadonlyArray<string>;
  readonly ask?: ReadonlyArray<string>;
  readonly hooks?: Readonly<Record<string, number>>;
  readonly error?: string;
}
export interface McpEntry {
  readonly path: string;
  readonly servers?: ReadonlyArray<string>;
  readonly error?: string;
}
export interface AgentEntry {
  readonly path: string;
  readonly bytes?: number;
  readonly name?: unknown;
  readonly model?: unknown;
  readonly error?: string;
}

export interface Inventory {
  readonly v: 1;
  readonly workspace: string;
  readonly generated_at: string;
  readonly instructions: ReadonlyArray<InstructionEntry>;
  readonly rules: ReadonlyArray<RuleEntry>;
  readonly rules_truncated: boolean;
  readonly skills: ReadonlyArray<SkillEntry>;
  readonly user_skills: ReadonlyArray<SkillEntry>;
  readonly settings: ReadonlyArray<SettingsEntry>;
  readonly mcp: ReadonlyArray<McpEntry>;
  readonly agents: ReadonlyArray<AgentEntry>;
  readonly dirs_visited: number;
  readonly truncated: boolean;
}

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

/** YAML between a leading `---` line and the next one. */
function frontmatter(text: string): Record<string, unknown> | null {
  const rest = text.startsWith("---\n")
    ? text.slice(4)
    : text.startsWith("---\r\n")
      ? text.slice(5)
      : null;
  if (rest === null) return null;
  const end = rest.search(/\r?\n---/);
  if (end < 0) throw new Error("frontmatter opens with --- and never closes");
  const parsed: unknown = Yaml.parse(rest.slice(0, end));
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/** The frontmatter, or the reason it cannot be read. */
function readMatter(
  text: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> | null }
  | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: frontmatter(text) };
  } catch (cause) {
    return { ok: false, error: errorText(cause) };
  }
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

function headings(text: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{1,6}) (.*)$/.exec(line);
    if (match !== null) out.push({ level: match[1]!.length, text: match[2]!.trim() });
  }
  return out;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? [value]
      : [];

const lineCount = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export const buildInventory = Effect.fn("HarnessInventory.build")(function* (input: {
  readonly root: string;
  readonly home: string | null;
  readonly generatedAt: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const relative = (file: string) => path.relative(input.root, file).split(path.sep).join("/");
  const read = (file: string) =>
    fs.readFileString(file).pipe(Effect.mapError((cause) => `${file}: ${errorText(cause)}`));
  const isDirectory = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  const isFile = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
  const children = (dir: string) =>
    fs.readDirectory(dir).pipe(
      Effect.map((names) => names.toSorted()),
      Effect.orElseSucceed(() => [] as string[]),
    );

  // The project walk: instruction files, `.claude` and `.agents` directories, `.mcp.json`.
  const instructions: InstructionEntry[] = [];
  const claudeDirs: string[] = [];
  const agentsDirs: string[] = [];
  const mcpFiles: string[] = [];
  let dirsVisited = 0;
  let truncated = false;
  const stack: Array<readonly [string, number]> = [[input.root, 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop()!;
    dirsVisited += 1;
    if (dirsVisited > MAX_DIRS) {
      truncated = true;
      break;
    }
    for (const name of yield* children(dir)) {
      const file = path.join(dir, name);
      if (yield* isDirectory(file)) {
        if (name === ".claude") claudeDirs.push(file);
        else if (name === ".agents") agentsDirs.push(file);
        const skipped =
          SKIP_DIRS.has(name) || (name === "worktrees" && path.basename(dir) === ".claude");
        if (depth < MAX_DEPTH && !skipped) stack.push([file, depth + 1]);
      } else if (INSTRUCTION_FILES.has(name)) {
        const text = yield* Effect.result(read(file));
        instructions.push(
          text._tag === "Success"
            ? {
                path: relative(file),
                bytes: Buffer.byteLength(text.success),
                lines: lineCount(text.success),
                headings: headings(text.success),
              }
            : { path: relative(file), error: text.failure },
        );
      } else if (name === ".mcp.json") {
        mcpFiles.push(file);
      }
    }
  }
  instructions.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  claudeDirs.sort();
  agentsDirs.sort();
  mcpFiles.sort();

  const ruleFiles = Effect.fn("HarnessInventory.ruleFiles")(function* (dir: string) {
    const files: string[] = [];
    let capped = false;
    const pending: Array<readonly [string, number]> = [[dir, 0]];
    const seen = new Set<string>();
    walk: while (pending.length > 0) {
      const [current, depth] = pending.pop()!;
      const real = yield* fs.realPath(current).pipe(Effect.orElseSucceed(() => null));
      if (real === null || seen.has(real)) continue;
      seen.add(real);
      for (const name of yield* children(current)) {
        const file = path.join(current, name);
        if (yield* isDirectory(file)) {
          if (depth < RULES_MAX_DEPTH) pending.push([file, depth + 1]);
          else capped = true;
        } else if (name.endsWith(".md")) {
          if (files.length === RULES_MAX_FILES) {
            capped = true;
            break walk;
          }
          files.push(file);
        }
      }
    }
    return { files: files.toSorted(), capped };
  });

  const ruleEntry = Effect.fn("HarnessInventory.ruleEntry")(function* (file: string) {
    const text = yield* Effect.result(read(file));
    if (text._tag === "Failure") return { path: relative(file), paths: [], error: text.failure };
    const bytes = Buffer.byteLength(text.success);
    const matter = readMatter(text.success);
    return matter.ok
      ? { path: relative(file), bytes, paths: stringList(matter.value?.paths) }
      : { path: relative(file), bytes, paths: [], error: matter.error };
  });

  const skillEntry = Effect.fn("HarnessInventory.skillEntry")(function* (
    file: string,
    display: string,
    scope: "repo" | "user",
  ) {
    const dirName = path.basename(path.dirname(file));
    const text = yield* Effect.result(read(file));
    if (text._tag === "Failure") {
      return { path: display, scope, name: dirName, error: text.failure } satisfies SkillEntry;
    }
    const bytes = Buffer.byteLength(text.success);
    const read_ = readMatter(text.success);
    if (!read_.ok) {
      return {
        path: display,
        scope,
        bytes,
        name: dirName,
        error: read_.error,
      } satisfies SkillEntry;
    }
    const matter = read_.value;
    const field = (name: string) =>
      typeof matter?.[name] === "string" ? (matter[name] as string) : undefined;
    const flag = (name: string, fallback: boolean) =>
      typeof matter?.[name] === "boolean" ? (matter[name] as boolean) : fallback;
    const metadata = matter?.metadata as Record<string, unknown> | undefined;
    return {
      path: display,
      scope,
      bytes,
      name: field("name") ?? dirName,
      version:
        field("version") ?? (typeof metadata?.version === "string" ? metadata.version : null),
      description_chars: field("description")?.length ?? 0,
      disable_model_invocation: flag("disable-model-invocation", false),
      user_invocable: flag("user-invocable", true),
    } satisfies SkillEntry;
  });

  const skillsUnder = Effect.fn("HarnessInventory.skillsUnder")(function* (
    dir: string,
    scope: "repo" | "user",
  ) {
    const out: SkillEntry[] = [];
    for (const name of yield* children(dir)) {
      const file = path.join(dir, name, "SKILL.md");
      if (!(yield* isFile(file))) continue;
      out.push(yield* skillEntry(file, scope === "user" ? file : relative(file), scope));
    }
    return out;
  });

  const jsonFile = (file: string) =>
    read(file).pipe(
      Effect.flatMap((text) =>
        decodeJson(text).pipe(Effect.mapError((cause) => `not JSON: ${errorText(cause)}`)),
      ),
      Effect.result,
    );

  const settingsEntry = Effect.fn("HarnessInventory.settingsEntry")(function* (file: string) {
    const parsed = yield* jsonFile(file);
    if (parsed._tag === "Failure") return { path: relative(file), error: parsed.failure };
    const value = (parsed.success ?? {}) as Record<string, unknown>;
    const permissions = (value.permissions ?? {}) as Record<string, unknown>;
    const hooks: Record<string, number> = {};
    if (typeof value.hooks === "object" && value.hooks !== null) {
      for (const [event, groups] of Object.entries(value.hooks as Record<string, unknown>)) {
        hooks[event] = Array.isArray(groups)
          ? groups.reduce(
              (sum: number, group) =>
                sum +
                (Array.isArray((group as { hooks?: unknown })?.hooks)
                  ? (group as { hooks: unknown[] }).hooks.length
                  : 0),
              0,
            )
          : 0;
      }
    }
    return {
      path: relative(file),
      allow: stringList(permissions.allow),
      deny: stringList(permissions.deny),
      ask: stringList(permissions.ask),
      hooks,
    };
  });

  const mcpEntry = Effect.fn("HarnessInventory.mcpEntry")(function* (file: string) {
    const parsed = yield* jsonFile(file);
    if (parsed._tag === "Failure") return { path: relative(file), error: parsed.failure };
    const servers = (parsed.success as { mcpServers?: unknown } | null)?.mcpServers;
    return {
      path: relative(file),
      servers:
        typeof servers === "object" && servers !== null ? Object.keys(servers as object) : [],
    };
  });

  const agentEntry = Effect.fn("HarnessInventory.agentEntry")(function* (file: string) {
    const text = yield* Effect.result(read(file));
    if (text._tag === "Failure") return { path: relative(file), error: text.failure };
    const bytes = Buffer.byteLength(text.success);
    const matter = readMatter(text.success);
    return matter.ok
      ? {
          path: relative(file),
          bytes,
          name: matter.value?.name ?? null,
          model: matter.value?.model ?? null,
        }
      : { path: relative(file), bytes, error: matter.error };
  });

  const rules: RuleEntry[] = [];
  const skills: SkillEntry[] = [];
  const settings: SettingsEntry[] = [];
  const agents: AgentEntry[] = [];
  let rulesTruncated = false;
  for (const claude of claudeDirs) {
    const found = yield* ruleFiles(path.join(claude, "rules"));
    rulesTruncated ||= found.capped;
    for (const file of found.files) rules.push(yield* ruleEntry(file));
    skills.push(...(yield* skillsUnder(path.join(claude, "skills"), "repo")));
    for (const name of ["settings.json", "settings.local.json"]) {
      const file = path.join(claude, name);
      if (yield* isFile(file)) settings.push(yield* settingsEntry(file));
    }
    const agentsDir = path.join(claude, "agents");
    for (const name of yield* children(agentsDir)) {
      const file = path.join(agentsDir, name);
      if (name.endsWith(".md") && (yield* isFile(file))) agents.push(yield* agentEntry(file));
    }
  }
  for (const dir of agentsDirs)
    skills.push(...(yield* skillsUnder(path.join(dir, "skills"), "repo")));
  const userSkills =
    input.home === null
      ? []
      : yield* skillsUnder(path.join(input.home, ".claude", "skills"), "user");
  const mcp: McpEntry[] = [];
  for (const file of mcpFiles) mcp.push(yield* mcpEntry(file));

  return {
    v: 1,
    workspace: input.root,
    generated_at: input.generatedAt,
    instructions,
    rules,
    rules_truncated: rulesTruncated,
    skills,
    user_skills: userSkills,
    settings,
    mcp,
    agents,
    dirs_visited: dirsVisited,
    truncated,
  } satisfies Inventory;
});
