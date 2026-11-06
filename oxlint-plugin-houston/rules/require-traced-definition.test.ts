import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("houston/require-traced-definition");
const houstonRule = createOxlintRuleHarness("houston/require-traced-definition", {
  filename: "src/houston/fixture.ts",
});

describe("houston/require-traced-definition", () => {
  rule.valid(
    "allows named Effect.fn definitions with pipeables and pipe",
    `
    import * as Effect from "effect/Effect";
    export const read = Effect.fn("Files.read")(function* () { yield* Effect.void; });
    export const write = Effect.fn("Files.write")(function* () { yield* Effect.void; }, Effect.scoped);
    export const list = Effect.fn("Files.list", { kind: "client" })(function* () {
      yield* Effect.void;
    }).pipe(Effect.orDie);
  `,
  );

  rule.valid(
    "allows fnUntraced with a reason and a disable comment with a reason",
    `
    import * as Effect from "effect/Effect";
    // Runs per streamed chunk; the enclosing turn owns the span.
    export const chunk = Effect.fnUntraced(function* () { yield* Effect.void; });
    // oxlint-disable-next-line houston/require-traced-definition -- runs outside an Effect fiber
    export const load = async () => 1;
  `,
  );

  rule.valid(
    "allows delegating members, layers, Effect values and synchronous exports",
    `
    import * as Effect from "effect/Effect";
    import * as Layer from "effect/Layer";
    declare const repo: { get: (id: string) => unknown };
    declare const Tag: { of: (value: unknown) => unknown };
    export const service = Tag.of({ get: (id: string) => repo.get(id) });
    export const layer = Layer.effect(Tag as never, Effect.void as never);
    export const make = Effect.gen(function* () { yield* Effect.void; });
    export const add = (a: number, b: number) => a + b;
  `,
  );

  rule.valid(
    "allows combinator callbacks",
    `
    import * as Effect from "effect/Effect";
    import * as Option from "effect/Option";
    declare const toHandlers: (value: unknown) => unknown;
    export const recovered = Effect.fail({ _tag: "A" }).pipe(Effect.catchTags({
      A: () => Effect.gen(function* () { yield* Effect.void; }),
    }));
    export const matched = Option.match(Option.none(), { onNone: () => Effect.void, onSome: () => Effect.void });
    export const handlers = toHandlers({ m: (input: number) => Effect.succeed(input) });
  `,
  );

  rule.valid(
    "allows getters, private methods and unreferenced local helpers",
    `
    import * as Effect from "effect/Effect";
    export class Store {
      get ready() { return Effect.void; }
      private load() { return Effect.void; }
      #save() { return Effect.void; }
    }
    const helper = () => Effect.void;
    export const value = 1;
  `,
  );

  rule.valid(
    "does not mistake a shadowed Effect identifier",
    `
    const Effect = { gen: (body: () => unknown) => body() };
    export const run = () => Effect.gen(function* () {});
  `,
  );

  rule.invalid(
    "reports an exported arrow returning Effect.gen",
    `
    import * as Effect from "effect/Effect";
    export const run = (x: number) => Effect.gen(function* () { return x; });
  `,
    (output) => assert.match(output, /'run' is public and returns an Effect/),
  );

  rule.invalid(
    "reports an exported function with an Effect return type",
    `
    import * as Effect from "effect/Effect";
    export function run(): Effect.Effect<void> { return undefined as never; }
  `,
  );

  rule.invalid(
    "reports an exported async function",
    `
    export async function run() { return 1; }
  `,
  );

  rule.invalid(
    "reports an exported Promise constructor",
    `
    export const wait = (): Promise<void> => new Promise((resolve) => resolve());
  `,
  );

  rule.invalid(
    "reports a Service.of member",
    `
    import * as Effect from "effect/Effect";
    declare const Service: { of: (value: unknown) => unknown };
    export const service = Service.of({ read: (id: string) => Effect.succeed(id) });
  `,
    (output) => assert.match(output, /'read' is public/),
  );

  rule.invalid(
    "reports a Layer.succeed member",
    `
    import * as Effect from "effect/Effect";
    import * as Layer from "effect/Layer";
    export const layer = Layer.succeed(undefined as never, { read: () => Effect.void });
  `,
  );

  rule.invalid(
    "reports a returned shorthand member at its declaration",
    `
    import * as Effect from "effect/Effect";
    export const make = () => {
      const read = (id: string) => Effect.flatMap(Effect.succeed(id), Effect.succeed);
      return { read };
    };
  `,
    (output) => assert.match(output, /'read' is public/),
  );

  rule.invalid(
    "reports fnUntraced without a reason in a public position",
    `
    import * as Effect from "effect/Effect";
    export const chunk = Effect.fnUntraced(function* () { yield* Effect.void; });
  `,
    (output) => assert.match(output, /without a reason/),
  );

  rule.invalid(
    "reports an anonymous Effect.fn export",
    `
    import * as Effect from "effect/Effect";
    export const run = Effect.fn(function* () { yield* Effect.void; });
  `,
    (output) => assert.match(output, /anonymous Effect\.fn/),
  );

  rule.invalid(
    "reports an exported class method returning Effect.gen",
    `
    import * as Effect from "effect/Effect";
    export class Store {
      load() { return Effect.gen(function* () { yield* Effect.void; }); }
    }
  `,
  );

  rule.invalid(
    "resolves a namespace alias",
    `
    import * as Eff from "effect/Effect";
    export const run = () => Eff.void;
  `,
  );

  rule.invalid(
    "resolves a named import from effect",
    `
    import { Effect } from "effect";
    export const run = () => Effect.void;
  `,
  );

  rule.invalid(
    "reports a Stream-returning export",
    `
    import * as Stream from "effect/Stream";
    export const changes = () => Stream.empty;
  `,
  );

  houstonRule.invalid(
    "reports a bare span name in a houston file",
    `
    import * as Effect from "effect/Effect";
    export const save = Effect.fn("save")(function* () { yield* Effect.void; });
  `,
    (output) => assert.match(output, /does not match Module\.operation/),
  );

  houstonRule.valid(
    "allows a Module.operation span name in a houston file",
    `
    import * as Effect from "effect/Effect";
    export const save = Effect.fn("HoustonTasks.save")(function* () { yield* Effect.void; });
  `,
  );
});
