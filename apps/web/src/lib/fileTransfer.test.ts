import { describe, expect, it } from "@effect/vitest";

import {
  FILE_PATH_MIME,
  GNOME_COPIED_FILES_MIME,
  URI_LIST_MIME,
  isFileTransfer,
  parseGnomeCopiedFiles,
  parseUriList,
  pastedPathsConfirmationTitle,
  transferredPaths,
} from "./fileTransfer";

function transfer(data: Record<string, string>, types = Object.keys(data)) {
  return {
    types,
    files: [],
    items: [],
    getData: (type: string) => data[type] ?? "",
  };
}

describe("parseUriList", () => {
  it("decodes file URIs and ignores comments and non-file schemes", () => {
    expect(
      parseUriList(
        "# copied from Nautilus\nfile:///tmp/my%20shot.png\nhttps://example.com/a\nfile:///tmp/b.txt\n",
      ),
    ).toEqual(["/tmp/my shot.png", "/tmp/b.txt"]);
  });

  it("strips the leading slash from a Windows drive path", () => {
    expect(parseUriList("file:///C:/repo/notes.md")).toEqual(["C:/repo/notes.md"]);
  });

  it("returns nothing for malformed entries", () => {
    expect(parseUriList("not a uri\nfile://%\n")).toEqual([]);
  });
});

describe("parseGnomeCopiedFiles", () => {
  it("skips the copy action line", () => {
    expect(parseGnomeCopiedFiles("copy\nfile:///tmp/a.txt\nfile:///tmp/b.txt")).toEqual([
      "/tmp/a.txt",
      "/tmp/b.txt",
    ]);
  });

  it("accepts a list without an action line", () => {
    expect(parseGnomeCopiedFiles("file:///tmp/a.txt")).toEqual(["/tmp/a.txt"]);
  });
});

describe("isFileTransfer", () => {
  it.each(["Files", FILE_PATH_MIME, URI_LIST_MIME, GNOME_COPIED_FILES_MIME])(
    "accepts a %s drag",
    (type) => {
      expect(isFileTransfer(transfer({}, [type]))).toBe(true);
    },
  );

  it("falls back to file items when the types are hidden", () => {
    expect(
      isFileTransfer({
        types: [],
        files: [],
        items: [{ kind: "file" }],
        getData: () => "",
      }),
    ).toBe(true);
  });

  it("rejects a text-only drag", () => {
    expect(isFileTransfer(transfer({ "text/plain": "hello" }))).toBe(false);
  });
});

describe("transferredPaths", () => {
  it("treats a flavor the engine refuses to read as absent", () => {
    expect(
      transferredPaths({
        types: [URI_LIST_MIME],
        files: [],
        items: [],
        getData: (type: string) => {
          if (type !== URI_LIST_MIME) throw new Error("unknown flavor");
          return "file:///tmp/a.txt";
        },
      }),
    ).toEqual(["/tmp/a.txt"]);
  });

  it("deduplicates the same entries across flavors", () => {
    expect(
      transferredPaths(
        transfer({
          [FILE_PATH_MIME]: "/tmp/a.txt\n",
          [URI_LIST_MIME]: "file:///tmp/a.txt\nfile:///tmp/b.txt",
          [GNOME_COPIED_FILES_MIME]: "copy\nfile:///tmp/b.txt\nfile:///tmp/c.txt",
        }),
      ),
    ).toEqual(["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"]);
  });
});

describe("pastedPathsConfirmationTitle", () => {
  it("names a single pasted path by its file name", () => {
    expect(pastedPathsConfirmationTitle(["/home/someone/.ssh/id_ed25519"])).toBe(
      'Attach "id_ed25519" from the clipboard?',
    );
  });

  it("counts several pasted paths", () => {
    expect(pastedPathsConfirmationTitle(["/a/one", "/b/two/"])).toBe(
      "Attach 2 items from the clipboard?",
    );
  });
});
