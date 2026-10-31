import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { buildInventory, type Inventory } from "./inventory.ts";

const write = (root: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, ...relative.split("/"));
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, content);
    }
  });

const skill = (name: string, extra = "") =>
  `---\nname: ${name}\nversion: 1.2.0\ndescription: Does ${name} things\n${extra}---\n\nBody\n`;

describe("the harness inventory", () => {
  it.effect("the inventory lists the harness files and their shape", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "harness-inventory-" });
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "harness-home-" });
      const claudeMd = "# Project\n\nIntro\n\n```md\n# Not a heading\n```\n\n## Testing\n";
      yield* write(root, {
        "CLAUDE.md": claudeMd,
        "CLAUDE.local.md": "# Local\n",
        "apps/web/AGENTS.md": "# Web agents\n### Deep\n",
        "a/b/c/d/AGENTS.md": "# Four levels down\n",
        "a/b/c/d/e/AGENTS.md": "# Five levels down\n",
        "node_modules/pkg/CLAUDE.md": "# vendored\n",
        ".git/CLAUDE.md": "# git\n",
        ".houston/harness/CLAUDE.md": "# houston\n",
        ".claude/worktrees/w1/CLAUDE.md": "# worktree copy\n",
        ".claude/rules/a/b.md": "---\npaths:\n  - src/**/*.ts\n  - test/**\n---\nRule\n",
        ".claude/rules/top.md": "No frontmatter\n",
        ".claude/skills/deploy/SKILL.md": skill(
          "deploy",
          "disable-model-invocation: true\nuser-invocable: false\n",
        ),
        ".agents/skills/review/SKILL.md": skill("review"),
        ".claude/settings.json": JSON.stringify({
          permissions: { allow: ["Bash(git push:*)"], deny: ["Bash(rm:*)"], ask: ["WebFetch"] },
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: "command", command: "a" },
                  { type: "command", command: "b" },
                ],
              },
            ],
            PreToolUse: [{ hooks: [{ type: "command", command: "c" }] }],
          },
        }),
        ".claude/settings.local.json": "{ not json",
        ".mcp.json": JSON.stringify({ mcpServers: { github: {}, linear: {} } }),
        ".claude/agents/x.md": "---\nname: x-agent\nmodel: opus\n---\nAgent\n",
      });
      yield* write(home, { ".claude/skills/personal/SKILL.md": skill("personal") });

      const inventory: Inventory = yield* buildInventory({
        root,
        home,
        generatedAt: "2026-10-30T09:00:00.000Z",
      });
      assert.equal(inventory.v, 1);
      assert.deepEqual(
        inventory.instructions.map((entry) => entry.path),
        ["CLAUDE.local.md", "CLAUDE.md", "a/b/c/d/AGENTS.md", "apps/web/AGENTS.md"],
      );
      const main = inventory.instructions.find((entry) => entry.path === "CLAUDE.md")!;
      assert.equal(main.bytes, Buffer.byteLength(claudeMd));
      assert.equal(main.lines, claudeMd.split("\n").length - 1);
      assert.deepEqual(main.headings, [
        { level: 1, text: "Project" },
        { level: 2, text: "Testing" },
      ]);

      assert.deepEqual(
        inventory.rules.map((rule) => [rule.path, rule.paths]),
        [
          [".claude/rules/a/b.md", ["src/**/*.ts", "test/**"]],
          [".claude/rules/top.md", []],
        ],
      );
      assert.isFalse(inventory.rules_truncated);

      const skills = [...inventory.skills, ...inventory.user_skills];
      const deploy = skills.find((entry) => entry.name === "deploy")!;
      assert.include(deploy, {
        scope: "repo",
        version: "1.2.0",
        description_chars: "Does deploy things".length,
        disable_model_invocation: true,
        user_invocable: false,
      });
      assert.include(
        skills.find((entry) => entry.name === "review")!,
        {
          scope: "repo",
          disable_model_invocation: false,
          user_invocable: true,
        },
      );
      assert.include(
        skills.find((entry) => entry.name === "personal")!,
        { scope: "user" },
      );

      const settings = inventory.settings.find((entry) => entry.path === ".claude/settings.json")!;
      assert.deepEqual(settings.allow, ["Bash(git push:*)"]);
      assert.deepEqual(settings.deny, ["Bash(rm:*)"]);
      assert.deepEqual(settings.ask, ["WebFetch"]);
      assert.deepEqual(settings.hooks, { Stop: 2, PreToolUse: 1 });
      const broken = inventory.settings.find(
        (entry) => entry.path === ".claude/settings.local.json",
      )!;
      assert.match(broken.error!, /not JSON/);

      assert.deepEqual(inventory.mcp, [{ path: ".mcp.json", servers: ["github", "linear"] }]);
      assert.deepEqual(
        inventory.agents.map((agent) => [agent.path, agent.name, agent.model]),
        [[".claude/agents/x.md", "x-agent", "opus"]],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a rules tree past 1,000 files is cut short and says so", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "harness-inventory-rules-" });
      const files: Record<string, string> = {};
      for (let index = 0; index < 1_001; index += 1) {
        files[`.claude/rules/r${String(index).padStart(4, "0")}.md`] = "Rule\n";
      }
      yield* write(root, files);
      const inventory = yield* buildInventory({ root, home: null, generatedAt: "now" });
      assert.lengthOf(inventory.rules, 1_000);
      assert.isTrue(inventory.rules_truncated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
