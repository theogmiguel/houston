import { describe, expect, it } from "vite-plus/test";
import { worktreesDirectoryProblem } from "./worktreesDirectoryInput";

describe("worktreesDirectoryProblem", () => {
  it.each([
    "",
    "/srv/worktrees",
    "~/worktrees",
    "~",
    "C:\\work\\trees",
    "C:/work",
    "\\\\host\\share\\w",
  ])("accepts %j", (value) => {
    expect(worktreesDirectoryProblem(value)).toBeNull();
  });

  it.each([".houston/worktrees", "worktrees", "../trees", "./trees", "C:trees"])(
    "refuses the relative value %j and names it",
    (value) => {
      const message = worktreesDirectoryProblem(value);
      expect(message).toContain(`"${value}"`);
      expect(message).toMatch(/absolute folder/);
    },
  );
});
