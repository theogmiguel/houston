// @effect-diagnostics nodeBuiltinImport:off -- Temporary fixtures exercise the real filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, test } from "vite-plus/test";

import {
  resolveWorkspaceFileForDrag,
  WorkspaceFileDragError,
  type WorkspaceFileDragRule,
} from "./workspaceFileDrag.ts";

let root: string;
let outside: string;

async function expectRefusal(
  input: { path: string; workspaceRoot: string },
  rule: WorkspaceFileDragRule,
): Promise<WorkspaceFileDragError> {
  try {
    await resolveWorkspaceFileForDrag(input);
    throw new Error("the drag must be refused");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceFileDragError);
    const refusal = error as WorkspaceFileDragError;
    expect(refusal.rule).toBe(rule);
    expect(refusal.message).toContain(JSON.stringify(input.path));
    return refusal;
  }
}

beforeEach(async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "houston-file-drag-"));
  root = NodePath.join(base, "workspace");
  outside = NodePath.join(base, "outside");
  await NodeFSP.mkdir(NodePath.join(root, "src"), { recursive: true });
  await NodeFSP.mkdir(outside, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "src", "main.ts"), "export {};\n");
  await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "secret\n");
});

afterEach(async () => {
  await NodeFSP.rm(NodePath.dirname(root), { recursive: true, force: true });
});

describe("resolveWorkspaceFileForDrag", () => {
  it("resolves a relative path to the file's real path", async () => {
    await expect(
      resolveWorkspaceFileForDrag({ path: "src/main.ts", workspaceRoot: root }),
    ).resolves.toBe(await NodeFSP.realpath(NodePath.join(root, "src", "main.ts")));
  });

  it("accepts an absolute path inside the workspace root", async () => {
    const file = NodePath.join(root, "src", "main.ts");
    await expect(resolveWorkspaceFileForDrag({ path: file, workspaceRoot: root })).resolves.toBe(
      await NodeFSP.realpath(file),
    );
  });

  it("refuses a relative path that climbs out and names the rule", async () => {
    await expectRefusal(
      { path: "../outside/secret.txt", workspaceRoot: root },
      "outside-workspace",
    );
  });

  it("refuses an absolute path elsewhere and names the rule", async () => {
    await expectRefusal(
      { path: NodePath.join(outside, "secret.txt"), workspaceRoot: root },
      "outside-workspace",
    );
  });

  it("refuses a path that does not exist", async () => {
    const refusal = await expectRefusal({ path: "src/missing.ts", workspaceRoot: root }, "missing");
    expect(refusal.message).toContain(root);
  });

  it("refuses a directory", async () => {
    await expectRefusal({ path: "src", workspaceRoot: root }, "not-a-file");
  });

  it("refuses a filesystem root as the workspace root", async () => {
    const filesystemRoot = NodePath.parse(root).root;
    await expectRefusal(
      { path: NodePath.join(filesystemRoot, "etc", "hosts"), workspaceRoot: filesystemRoot },
      "workspace-root-too-broad",
    );
  });

  it("refuses a missing workspace root", async () => {
    await expectRefusal(
      { path: "src/main.ts", workspaceRoot: NodePath.join(root, "gone") },
      "workspace-root-missing",
    );
  });

  // oxlint-disable-next-line houston/no-global-process-runtime -- Windows symlinks need elevation, so the fixture is skipped there.
  test.runIf(process.platform !== "win32")(
    "refuses a symlink that leaves the workspace root",
    async () => {
      const link = NodePath.join(root, "src", "escape.txt");
      await NodeFSP.symlink(NodePath.join(outside, "secret.txt"), link);
      await expectRefusal({ path: "src/escape.txt", workspaceRoot: root }, "outside-workspace");
    },
  );
});
