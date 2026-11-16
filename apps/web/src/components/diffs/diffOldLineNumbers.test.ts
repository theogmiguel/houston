import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { createOldLineResolver } from "./diffOldLineNumbers";

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,5 @@
 one
-two
+two-a
+two-b
 three
 four
@@ -40,3 +41,2 @@
 forty
-forty-one
 forty-two
`;

function resolver() {
  return createOldLineResolver(parsePatchFiles(PATCH, "old-lines")[0]!.files[0]!);
}

describe("createOldLineResolver", () => {
  it("is the identity before the first change", () => {
    expect(resolver()(1)).toBe(1);
  });

  it("shifts context after added lines back by the lines added", () => {
    // new 4 "three" was old 3; new 5 "four" was old 4.
    expect(resolver()(4)).toBe(3);
    expect(resolver()(5)).toBe(4);
  });

  it("keeps the shift across expanded context between hunks", () => {
    expect(resolver()(20)).toBe(19);
  });

  it("accounts for the removed line in the second hunk", () => {
    // new 41 "forty" was old 40; new 42 "forty-two" was old 42.
    expect(resolver()(41)).toBe(40);
    expect(resolver()(42)).toBe(42);
  });

  it("returns to the identity once the changes cancel out after the last hunk", () => {
    expect(resolver()(60)).toBe(60);
  });
});
