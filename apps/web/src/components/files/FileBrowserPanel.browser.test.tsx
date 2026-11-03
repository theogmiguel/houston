import { EnvironmentId, ProjectFileMutationError, type ProjectEntry } from "@houston-app/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { requestConfirmDialog } from "~/confirmDialog";
import { dismissContextMenu } from "~/contextMenuFallback";
import { render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";
import { FileExplorerPane } from "./FileExplorerPane";

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
  { path: "docker-compose.private.override.yml", kind: "file" },
];
const loadingDirectories: ReadonlySet<string> = new Set();
const directory = {
  entries,
  load: () => Promise.resolve(),
  refresh: () => {},
  ready: true,
  error: null,
  isPending: false,
  loadingDirectories,
};
const pathSearch = {
  entries: [],
  isPending: false,
  error: null,
  truncated: false,
  refresh: () => {},
};

const entryCommands = vi.hoisted(() => ({
  createEntry: vi.fn((_input: unknown): Promise<unknown> =>
    Promise.resolve({ _tag: "Success", value: {} }),
  ),
  renameEntry: vi.fn((_input: unknown): Promise<unknown> =>
    Promise.resolve({ _tag: "Success", value: {} }),
  ),
  deleteEntry: vi.fn((_input: unknown): Promise<unknown> =>
    Promise.resolve({ _tag: "Success", value: {} }),
  ),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: entryCommands }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  }),
}));
vi.mock("~/confirmDialog", () => ({
  requestConfirmDialog: vi.fn((_message: string, _options?: unknown) => Promise.resolve(true)),
}));
vi.mock("./useDirectoryEntries", () => ({ useDirectoryEntries: () => directory }));
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => pathSearch }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: () => Promise.resolve() }),
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

function findTreeRow(path: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
}

describe("FileBrowserPanel", () => {
  it("copies with the pointer and returns to the row after keyboard dismissal", async () => {
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
      }),
    );
    const action = page.getByRole("menuitem", { name: "Copy mention", exact: true });
    await expect.element(action).toBeVisible();
    await userEvent.click(action);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("[README.md](README.md)"));

    const row = findTreeRow("README.md")!;
    await userEvent.keyboard("{Tab}");
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await vi.waitFor(() =>
      expect((row.getRootNode() as ShadowRoot).activeElement?.getAttribute("role")).toBe(
        "menuitem",
      ),
    );
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect((row.getRootNode() as ShadowRoot).activeElement).toBe(row));
  });

  it("stays inside its explorer column when a file preview shares the row", async () => {
    await using _screen = await render(
      <div className="flex" style={{ width: 400 }}>
        <FileExplorerPane resizable>
          <FileBrowserPanel
            environmentId={EnvironmentId.make("env-files")}
            cwd="/repo"
            projectName="repo"
            selectedPath="README.md"
            selectedPathRevealId={0}
            onOpenFile={() => {}}
            workspaceMutationId={null}
          />
        </FileExplorerPane>
        <div className="min-w-0 flex-1" data-file-preview-content />
      </div>,
    );
    const explorer = document.querySelector<HTMLElement>('aside[aria-label="File explorer"]');
    const panel = document.querySelector<HTMLElement>("[data-file-browser-panel]");
    expect(explorer).not.toBeNull();
    expect(panel).not.toBeNull();
    // The panel must be able to shrink to its column instead of overflowing it.
    expect(getComputedStyle(panel!).minWidth).toBe("0px");
    expect(panel!.getBoundingClientRect().width).toBeLessThanOrEqual(
      explorer!.getBoundingClientRect().width + 1,
    );
  });

  it("dragging a file row carries a composer mention without opening it, and dragend releases it", async () => {
    const onOpenFile = vi.fn();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;

    const dataTransfer = new DataTransfer();
    row.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );
    // A drag carries the mention; a click mid-drag must not open the file.
    row.click();

    expect(dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toContain("README.md");
    expect(onOpenFile).not.toHaveBeenCalled();

    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, composed: true, dataTransfer }));

    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(1));
  });
  it("creates a file from the context menu and submits its inline name", async () => {
    entryCommands.createEntry.mockClear();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await vi.waitFor(() => expect(findTreeRow("src")).not.toBeNull());
    findTreeRow("src")!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
      }),
    );
    await userEvent.click(page.getByRole("menuitem", { name: "New file", exact: true }));
    const input = document.querySelector<HTMLInputElement>("[data-file-tree-editor] input");
    expect(input).not.toBeNull();
    await userEvent.type(input!, "new.ts{Enter}");
    await vi.waitFor(() =>
      expect(entryCommands.createEntry).toHaveBeenCalledWith({
        environmentId: EnvironmentId.make("env-files"),
        input: { cwd: "/repo", relativePath: "src/new.ts", kind: "file" },
      }),
    );
  });

  it("renames with F2 and deletes with Delete after confirmation", async () => {
    entryCommands.renameEntry.mockClear();
    entryCommands.deleteEntry.mockClear();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;
    row.focus();
    await userEvent.keyboard("{F2}");
    const input = document.querySelector<HTMLInputElement>("[data-file-tree-editor] input");
    expect(input).not.toBeNull();
    await userEvent.clear(input!);
    await userEvent.type(input!, "GUIDE.md{Enter}");
    await vi.waitFor(() =>
      expect(entryCommands.renameEntry).toHaveBeenCalledWith({
        environmentId: EnvironmentId.make("env-files"),
        input: { cwd: "/repo", fromPath: "README.md", toPath: "GUIDE.md" },
      }),
    );

    const deleteRow = findTreeRow("docker-compose.private.override.yml")!;
    deleteRow.focus();
    await userEvent.keyboard("{Delete}");
    await vi.waitFor(() =>
      expect(entryCommands.deleteEntry).toHaveBeenCalledWith({
        environmentId: EnvironmentId.make("env-files"),
        input: { cwd: "/repo", relativePath: "docker-compose.private.override.yml" },
      }),
    );
  });

  it("moves to the trash by default and offers permanent deletion when the trash is unavailable", async () => {
    entryCommands.deleteEntry.mockClear();
    const confirm = vi.mocked(requestConfirmDialog);
    confirm.mockClear();
    confirm.mockResolvedValue(true);
    const trashFailure = new ProjectFileMutationError({
      cwd: "/repo",
      mutation: "delete",
      relativePath: "README.md",
      failure: "trash_unavailable",
      resolvedPath: "/repo/README.md",
      message:
        "Cannot move workspace entry 'README.md' in '/repo' to the trash: gio is missing. The entry '/repo/README.md' was left in place.",
    });
    entryCommands.deleteEntry
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(trashFailure) })
      .mockResolvedValueOnce({ _tag: "Success", value: {} });

    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;
    row.focus();
    await userEvent.keyboard("{Delete}");

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[0]?.[0]).toBe('Move "README.md" to the Trash?');
    expect(confirm.mock.calls[1]?.[0]).toContain("gio is missing");
    expect(confirm.mock.calls[1]?.[0]).toContain('Delete "README.md" permanently instead?');
    expect(entryCommands.deleteEntry.mock.calls[0]?.[0]).toEqual({
      environmentId: EnvironmentId.make("env-files"),
      input: { cwd: "/repo", relativePath: "README.md" },
    });
    expect(entryCommands.deleteEntry.mock.calls[1]?.[0]).toEqual({
      environmentId: EnvironmentId.make("env-files"),
      input: { cwd: "/repo", relativePath: "README.md", permanent: true },
    });
  });
});
