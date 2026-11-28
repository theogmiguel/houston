import { assert, describe, it } from "@effect/vitest";
import { HOUSTON_BOT_LIMITS } from "@houston-app/contracts/houston/bots";

import { maskTokenShapes } from "../redact.ts";
import { botInput, CODEX } from "./bots.testkit.ts";
import { BOTS_OFF_MESSAGE, checkAccount, checkBot, freeSlug, refuseOff, slugOf } from "./rules.ts";

const OP = "houston.bots.save";
const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

describe("a bot's fields are bounded and a refusal names the limit, the value and the operation", () => {
  it.each([
    ["name", { name: "n".repeat(61) }, 60, 61],
    ["mark", { mark: "m".repeat(17) }, 16, 17],
    ["job", { job: "j".repeat(161) }, 160, 161],
    ["instructions", { instructions: "i".repeat(16_001) }, 16_000, 16_001],
    ["maxStartsPerDay", { maxStartsPerDay: 49 }, 48, 49],
    ["maxStartsPerDay", { maxStartsPerDay: 0 }, 1, 0],
    ["maxMinutes", { maxMinutes: 241 }, 240, 241],
    ["maxMinutes", { maxMinutes: 0 }, 1, 0],
    ["maxAtOnce", { maxAtOnce: 4 }, 3, 4],
    ["maxAtOnce", { maxAtOnce: 0 }, 1, 0],
  ] as const)("%s %#", (field, overrides, limit, actual) => {
    const refusal = checkBot(OP, botInput(overrides));
    assert.deepInclude(refusal, { kind: "limit", operation: OP, field, limit, actual });
    for (const part of [OP, field, String(limit), String(actual)]) {
      assert.include(refusal?.message, part);
    }
  });

  it("refuses too many projects and an oversized account, and accepts each bound", () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `p${index}`) as never;
    assert.deepInclude(
      checkBot(OP, botInput({ otherProjectIds: ids(HOUSTON_BOT_LIMITS.otherProjects + 1) })),
      { kind: "limit", field: "otherProjectIds", limit: 32, actual: 33 },
    );
    const oversized = { instanceId: CODEX, model: "m".repeat(5_000) };
    assert.deepInclude(checkBot(OP, botInput({ modelSelection: oversized })), {
      kind: "limit",
      field: "modelSelection",
    });
    assert.isNull(
      checkBot(
        OP,
        botInput({
          name: "n".repeat(60),
          mark: "m".repeat(16),
          job: "j".repeat(160),
          instructions: "i".repeat(16_000),
          otherProjectIds: ids(32),
          maxAtOnce: 3,
          maxStartsPerDay: 48,
          maxMinutes: 240,
        }),
      ),
    );
  });

  it("refuses an empty name, a line break in a one-line field and a ceiling that is not whole", () => {
    for (const [field, overrides] of [
      ["name", { name: "   " }],
      ["name", { name: "a\nb" }],
      ["job", { job: "a b" }],
      ["mark", { mark: "a\u0007" }],
      ["maxMinutes", { maxMinutes: 1.5 }],
      ["maxMinutes", { maxMinutes: Number.NaN }],
    ] as const) {
      assert.deepInclude(checkBot(OP, botInput(overrides)), { kind: "invalid", field });
    }
    assert.isNull(checkBot(OP, botInput({ instructions: "line one\nline two" })));
  });
});

describe("a bot's account is a Claude account", () => {
  it("accepts Claude, and refuses another provider and an unknown account by name", () => {
    assert.isNull(checkAccount(OP, "claude-work", "claudeAgent"));
    const other = checkAccount(OP, "codex-work", "codex");
    assert.deepInclude(other, { kind: "unsupported", field: "modelSelection", operation: OP });
    assert.include(other?.message, "codex");
    assert.include(other?.message, "codex-work");
    const unknown = checkAccount(OP, "gone", undefined);
    assert.deepInclude(unknown, { kind: "not_found", field: "modelSelection" });
    assert.include(unknown?.message, "gone");
  });
});

describe("the short name", () => {
  it("is lowercase letters, digits and hyphens, at most 64 characters", () => {
    for (const [name, slug] of [
      ["Digest writer", "digest-writer"],
      ["  Révision — Hebdo №2 ", "revision-hebdo-no2"],
      ["日本語", "bot"],
      ["--", "bot"],
    ] as const) {
      assert.equal(slugOf(name), slug);
    }
    for (const name of ["x".repeat(60), "㎢".repeat(60), `${"y".repeat(55)} zz`, "ﬃ".repeat(60)]) {
      const taken = new Set([slugOf(name)]);
      for (const slug of [slugOf(name), freeSlug(slugOf(name), taken)]) {
        assert.match(slug, SLUG);
        assert.isAtMost(slug.length, 64);
      }
    }
  });

  it("takes the next free number when the name's own is taken", () => {
    assert.equal(freeSlug("digest", new Set()), "digest");
    assert.equal(freeSlug("digest", new Set(["digest", "digest-2"])), "digest-3");
  });
});

describe("the switch", () => {
  it("the refusal names the switch", () => {
    const refusal = refuseOff(OP);
    assert.deepInclude(refusal, { kind: "off", operation: OP, message: BOTS_OFF_MESSAGE });
    assert.equal(BOTS_OFF_MESSAGE, "Bots are off. Turn on Labs ▸ Bots.");
  });
});

describe("maskTokenShapes", () => {
  const github = `ghp_${"a1".repeat(12)}`;
  const slack = `xoxb-${"1".repeat(12)}`;
  const aws = `AKIA${"A1".repeat(8)}`;
  const model = `sk-${"b2".repeat(12)}`;

  it("masks the four token shapes and lists each line it masked", () => {
    const masked = maskTokenShapes(
      [`one ${github}`, "two", `three ${slack} ${aws}`, ` four ${model}`].join("\n"),
    );
    for (const token of [github, slack, aws, model]) assert.notInclude(masked.text, token);
    assert.deepEqual(masked.maskedLines, [1, 3, 4]);
    assert.include(masked.text, "two");
  });

  it("leaves everyday words, headers and line breaks alone", () => {
    const text = [
      "state: merged",
      "code: 500",
      "password: see the vault",
      "Authorization: Bearer token-goes-here",
      "//user:secret@host",
      "",
    ].join("\r\n");
    assert.deepEqual(maskTokenShapes(text), { text, maskedLines: [] });
  });
});
