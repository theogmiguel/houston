import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import {
  KeybindingRule,
  LAYOUT_KEYBINDING_COMMANDS,
  ResolvedKeybindingsConfig,
  STATIC_KEYBINDING_COMMANDS,
} from "./keybindings.ts";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const shortcut = {
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};

it.effect("drops resolved rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      { command: "terminal.toggle", shortcut },
      { command: "someFuture.toggle", shortcut },
      { command: "filePicker.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle", "filePicker.toggle"],
    );
  }),
);

it.effect("drops malformed resolved rule entries", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      "garbage",
      { command: "terminal.toggle", shortcut },
      null,
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle"],
    );
  }),
);

it.effect("accepts every layout command as a keybinding rule", () =>
  Effect.gen(function* () {
    for (const command of LAYOUT_KEYBINDING_COMMANDS) {
      const rule = yield* decode(KeybindingRule, { key: "mod+alt+x", command });
      assert.strictEqual(rule.command, command);
    }
  }),
);

it.effect("rejects a layout command the contract does not declare", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(KeybindingRule, { key: "mod+alt+x", command: "layout.unknown" }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it("lists the layout commands once in the static command list", () => {
  const listed = STATIC_KEYBINDING_COMMANDS.filter((command) => command.startsWith("layout."));
  assert.deepEqual([...listed].toSorted(), [...LAYOUT_KEYBINDING_COMMANDS].toSorted());
});
