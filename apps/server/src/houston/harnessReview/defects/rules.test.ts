import { describe, expect, it } from "vite-plus/test";

import { redact } from "./redact.ts";
import { checkReport, defectKey, issueTitle, searchWords } from "./rules.ts";

describe("a defect report", () => {
  it("a defect report is bounded by name", () => {
    const rows: ReadonlyArray<
      readonly [string, Parameters<typeof checkReport>[0], ReadonlyArray<string>]
    > = [
      ["empty title", { title: "", destination: "houston" }, ["title", "1", "120"]],
      ["blank title", { title: "   ", destination: "houston" }, ["title"]],
      ["121-character title", { title: "x".repeat(121), destination: "houston" }, ["120", "121"]],
      [
        "11 evidence items",
        {
          title: "a defect",
          evidence: Array.from({ length: 11 }, (_, index) => `item ${index}`),
          destination: "houston",
        },
        ["evidence", "10", "11"],
      ],
      [
        "a 501-character evidence item",
        { title: "a defect", evidence: ["ok", "y".repeat(501)], destination: "houston" },
        ["evidence[1]", "500", "501"],
      ],
      [
        "destination workspace",
        { title: "a defect", destination: "workspace" },
        ["destination", "houston", "project", "workspace"],
      ],
    ];
    for (const [label, input, parts] of rows) {
      const refusal = checkReport(input);
      expect(refusal, label).not.toBeNull();
      for (const part of parts) expect(refusal?.message, label).toContain(part);
    }
    // At the bounds a report is accepted.
    expect(
      checkReport({
        title: "x".repeat(120),
        evidence: Array.from({ length: 10 }, () => "e".repeat(500)),
        destination: "project",
      }),
    ).toBeNull();
  });

  it("the key is the destination and the normalized title", () => {
    const one = defectKey("houston", "A  broken\tThing");
    expect(one).toMatch(/^defect-agent-[0-9a-f]{8}$/);
    expect(defectKey("houston", "a broken thing")).toBe(one);
    expect(defectKey("project", "a broken thing")).not.toBe(one);
  });
});

describe("redaction", () => {
  it("redaction removes secrets and paths and keeps sentences", () => {
    const winProject = "C:\\Users\\me\\proj";
    const winHome = "C:\\Users\\me";
    const unixHome = "/home/me";
    const rows: ReadonlyArray<
      readonly [string, string, string | null, string | null, string, ReadonlyArray<string>]
    > = [
      [
        "project path",
        "C:\\Users\\me\\proj\\src\\a.rs",
        winProject,
        winHome,
        "<project>\\src\\a.rs",
        [],
      ],
      [
        "project path, other spelling",
        "C:/Users/me/proj/src/a.rs",
        winProject,
        winHome,
        "<project>/src/a.rs",
        [],
      ],
      ["home path", "/home/me/notes.txt", null, unixHome, "~/notes.txt", []],
      ["home path, back slashes", "C:\\Users\\me\\notes.txt", null, winHome, "~\\notes.txt", []],
      ["home path, forward slashes", "C:/Users/me/notes.txt", null, winHome, "~/notes.txt", []],
      [
        "project path, lowercased",
        "c:\\users\\me\\proj\\src\\a.rs",
        winProject,
        winHome,
        "<project>\\src\\a.rs",
        [],
      ],
      ["home path, lowercased", "c:\\Users\\ME\\notes.txt", null, winHome, "~\\notes.txt", []],
      ["home path, Git Bash", "/c/Users/me/notes.txt", winProject, winHome, "~/notes.txt", []],
      ["project path, WSL", "/mnt/c/Users/me/proj/x", winProject, winHome, "<project>/x", []],
      ["another home, Unix", "/home/meg/notes.txt", null, unixHome, "/home/meg/notes.txt", []],
      ["another home, Windows", "C:\\Users\\meg\\x", null, winHome, "C:\\Users\\meg\\x", []],
      ["a longer file name", "see /home/me.txt", null, unixHome, "see /home/me.txt", []],
      ["home at a sentence's end", "logs are in /home/me.", null, unixHome, "logs are in ~.", []],
      ["env value", "MY_SECRET=hello", null, null, "MY_SECRET=<redacted>", ["hello"]],
      ["bearer", "Bearer eyJ.a.b", null, null, "Bearer <redacted>", ["eyJ.a.b"]],
      [
        "ghp token",
        "token ghp_0123456789abcdefghijABCDEFGHIJ012345",
        null,
        null,
        "token <redacted>",
        ["ghp_"],
      ],
      ["gho token", "gho_a1b2c3d4e5", null, null, "<redacted>", ["gho_"]],
      ["ghs token", "ghs_a1b2c3d4e5", null, null, "<redacted>", ["ghs_"]],
      [
        "github_pat token",
        "github_pat_11ABCDEFG0123456789_abcdef",
        null,
        null,
        "<redacted>",
        ["github_pat_"],
      ],
      ["sk token", "key sk-a1b2c3d4e5f6", null, null, "key <redacted>", ["sk-"]],
      [
        "40-character hex run",
        "hash 0123456789abcdef0123456789abcdef01234567",
        null,
        null,
        "hash <redacted>",
        ["0123456789abcdef"],
      ],
      [
        "base64 run",
        "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5==",
        null,
        null,
        "blob <redacted>",
        ["QUJDREVG"],
      ],
      [
        "URL user information",
        "url https://user:pass@example.com/x",
        null,
        null,
        "url https://<redacted>@example.com/x",
        ["user:pass"],
      ],
    ];
    for (const [label, text, project, home, expected, gone] of rows) {
      const redacted = redact(text, project, home);
      expect(redacted, label).toBe(expected);
      for (const secret of gone) expect(redacted, label).not.toContain(secret);
    }
    const sentence = "Worker 12 asked once; request 12345678 took 3 attempts.";
    expect(redact(sentence, winProject, winHome)).toBe(sentence);
  });
});

describe("issue text", () => {
  it("the issue title is conventional once and the search takes significant words", () => {
    expect(issueTitle("worker re-asked the same question")).toBe(
      "fix(harness): worker re-asked the same question",
    );
    expect(issueTitle("fix(defects): x")).toBe("fix(defects): x");
    expect(Array.from(issueTitle("z".repeat(400))).length).toBe(256);
    expect(searchWords("worker re-asked the same question")).toBe("worker re-asked same question");
    expect(searchWords("fix(defects): worker re-asked the same question")).toBe(
      "worker re-asked same question",
    );
    expect(searchWords("one two three four five six seven eight nine")).toBe(
      "three four five seven eight nine",
    );
  });
});
