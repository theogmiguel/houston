import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseHoustonProjectFile, HoustonProjectFileFromJson } from "./houstonProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(HoustonProjectFileFromJson);

describe("HoustonProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", "stopOnSettle": true, },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev", stopOnSettle: true });
  });
});

describe("parseHoustonProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseHoustonProjectFile(`{
        /* See https://github.com/theogmiguel/houston */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});
