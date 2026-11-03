import { describe, expect, it } from "@effect/vitest";

import { droppedPathToFile } from "./droppedPathFile";

describe("droppedPathToFile", () => {
  it("decodes the host's base64 into the named File", async () => {
    const file = droppedPathToFile(
      { name: "notes.md", directory: false, base64: btoa("# notes") },
      "/tmp/notes.md",
    );
    expect(file.name).toBe("notes.md");
    await expect(file.text()).resolves.toBe("# notes");
  });

  it("refuses a folder entry", () => {
    expect(() =>
      droppedPathToFile({ name: "photos", directory: true, base64: null }, "/tmp/photos"),
    ).toThrow(/is a folder/);
  });

  it("names the path and the malformed payload", () => {
    expect(() =>
      droppedPathToFile({ name: "x.bin", directory: false, base64: "%%%" }, "/tmp/x.bin"),
    ).toThrow(/"\/tmp\/x\.bin".*base64/);
  });
});
