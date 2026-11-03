import { describe, expect, it } from "@effect/vitest";

import { resolveDroppedFolderPaths } from "./folderDrop";

function folder(name: string): File {
  return new File([], name);
}

describe("resolveDroppedFolderPaths", () => {
  it("uses the host path when the File carries one", () => {
    expect(
      resolveDroppedFolderPaths([folder("photos")], ["/ignored"], () => "/home/dev/photos"),
    ).toEqual(["/home/dev/photos"]);
  });

  it("pairs URI-list paths with their folder File by name", () => {
    expect(
      resolveDroppedFolderPaths(
        [folder("docs"), folder("photos")],
        ["/home/dev/photos", "/home/dev/docs"],
        () => "",
      ),
    ).toEqual(["/home/dev/docs", "/home/dev/photos"]);
  });

  it("falls back to position when names do not match", () => {
    expect(
      resolveDroppedFolderPaths([folder("a"), folder("b")], ["/x/one", "/x/two"], () => ""),
    ).toEqual(["/x/one", "/x/two"]);
  });

  it("returns null for a folder the drag names on no channel", () => {
    expect(resolveDroppedFolderPaths([folder("photos")], [], () => "")).toEqual([null]);
  });
});
