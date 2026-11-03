import { describe, expect, it } from "@effect/vitest";
import { URI_LIST_MIME } from "../../lib/fileTransfer";
import { makeWorkspaceFileDropHandlers, splitTransferredFiles } from "./workspaceFileDrop";

describe("splitTransferredFiles", () => {
  it("separates copied folders from files before attachment validation", () => {
    const folder = new File([], "photos.png");
    const emptyFile = new File([], "empty.txt");
    const image = new File(["image"], "photo.png", { type: "image/png" });

    expect(
      splitTransferredFiles({
        files: [folder, emptyFile, image],
        items: [
          {
            kind: "string",
            getAsFile: () => null,
            webkitGetAsEntry: () => null,
          },
          {
            kind: "file",
            getAsFile: () => folder,
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
          {
            kind: "file",
            getAsFile: () => emptyFile,
            webkitGetAsEntry: () => ({ isDirectory: false }),
          },
          {
            kind: "file",
            getAsFile: () => image,
            webkitGetAsEntry: () => null,
          },
        ],
      }),
    ).toEqual({ files: [emptyFile, image], folders: [folder] });
  });

  it("ignores clipboard file items that cannot provide a file", () => {
    expect(
      splitTransferredFiles({
        files: [],
        items: [
          {
            kind: "file",
            getAsFile: () => null,
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
        ],
      }),
    ).toEqual({ files: [], folders: [] });
  });
});

describe("workspace file transfer handlers", () => {
  function dragEvent(
    types: ReadonlyArray<string>,
    data: Record<string, string> = {},
    files: File[] = [],
    items?: Array<{
      kind: string;
      getAsFile(): File | null;
      webkitGetAsEntry(): { isDirectory: boolean } | null;
    }>,
  ) {
    const state = { prevented: false };
    return {
      dataTransfer: {
        types,
        files,
        items,
        dropEffect: "none",
        getData: (type: string) => data[type] ?? "",
      },
      relatedTarget: null,
      currentTarget: { contains: (_target: Node | null) => false },
      get defaultPrevented() {
        return state.prevented;
      },
      preventDefault() {
        state.prevented = true;
      },
    };
  }

  function handlers() {
    const calls = {
      files: [] as File[][],
      folders: [] as Array<{ folders: File[]; paths: readonly string[] }>,
      paths: [] as string[][],
    };
    const host = {
      setDragActive: () => {},
      addFiles: (files: File[]) => calls.files.push(files),
      addFolders: (folders: File[], paths: readonly string[]) =>
        calls.folders.push({ folders, paths }),
      addDroppedPaths: (paths: readonly string[]) => calls.paths.push([...paths]),
    };
    return { handlers: makeWorkspaceFileDropHandlers(host), calls };
  }

  it("accepts a dragover that only advertises text/uri-list", () => {
    const { handlers: h } = handlers();
    const event = dragEvent([URI_LIST_MIME], { [URI_LIST_MIME]: "file:///tmp/a.txt" });
    h.onDragOver(event as never);
    expect(event.defaultPrevented).toBe(true);
  });

  it("passes the uri-list paths beside a folder drop", () => {
    const { handlers: h, calls } = handlers();
    const photos = new File([], "photos");
    h.onDrop(
      dragEvent(
        ["Files", URI_LIST_MIME],
        { [URI_LIST_MIME]: "file:///tmp/photos" },
        [photos],
        [
          {
            kind: "file",
            getAsFile: () => photos,
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
        ],
      ) as never,
    );
    expect(calls.folders).toEqual([{ folders: [photos], paths: ["/tmp/photos"] }]);
    expect(calls.paths).toEqual([]);
  });

  it("hands a uri-list-only drop to the path importer", () => {
    const { handlers: h, calls } = handlers();
    const event = dragEvent([URI_LIST_MIME], {
      [URI_LIST_MIME]: "file:///tmp/notes.md\nfile:///tmp/photos",
    });
    h.onDrop(event as never);
    expect(event.defaultPrevented).toBe(true);
    expect(calls.paths).toEqual([["/tmp/notes.md", "/tmp/photos"]]);
  });
});
