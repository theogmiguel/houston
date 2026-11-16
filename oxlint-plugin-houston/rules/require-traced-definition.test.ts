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
  // Export forms that do not declare in place.
  rule.invalid(
    "reports a local definition exported by specifier",
    `
    import * as Effect from "effect/Effect";
    const run = () => Effect.void;
    export { run };
  `,
    (output) => assert.match(output, /'run' is public/),
  );

  rule.invalid(
    "reports a local definition exported under another name",
    `
    import * as Effect from "effect/Effect";
    function run() { return Effect.void; }
    export { run as start };
  `,
  );

  rule.valid(
    "skips re-exports from another module",
    `
    export { run } from "./other.ts";
    export * from "./more.ts";
  `,
  );

  rule.invalid(
    "reports an exported default arrow",
    `
    import * as Effect from "effect/Effect";
    export default () => Effect.void;
  `,
    (output) => assert.match(output, /'default' is public/),
  );

  rule.invalid(
    "reports an exported default function expression",
    `
    import * as Effect from "effect/Effect";
    export default (function () { return Effect.void; });
  `,
  );

  rule.invalid(
    "reports a default export of a local definition",
    `
    import * as Effect from "effect/Effect";
    const run = () => Effect.void;
    export default run;
  `,
  );

  // pipe(<root>, ...) starts from its first argument.
  rule.invalid(
    "reports a pipe from effect/Function rooted at an Effect",
    `
    import * as Effect from "effect/Effect";
    import { pipe } from "effect/Function";
    export const run = () => pipe(Effect.succeed(1), Effect.asVoid);
  `,
  );

  rule.invalid(
    "reports a pipe from effect rooted at an Effect",
    `
    import { Effect, pipe } from "effect";
    export const run = () => pipe(Effect.succeed(1), Effect.asVoid);
  `,
  );

  rule.valid(
    "does not treat another pipe function as rooted at its argument",
    `
    import * as Effect from "effect/Effect";
    const pipe = <A>(value: A) => value;
    export const run = () => pipe(Effect.void);
  `,
  );

  // Returned objects are services only in public functions and service factories.
  rule.valid(
    "allows objects built inside map, flatMap and andThen callbacks",
    `
    import * as Effect from "effect/Effect";
    export const program = Effect.succeed(1).pipe(
      Effect.map((n) => ({ read: () => Effect.succeed(n) })),
      Effect.flatMap((value) => Effect.succeed({ read: () => Effect.succeed(value) })),
      Effect.andThen((value) => ({ again: () => Effect.succeed(value) })),
    );
  `,
  );

  rule.valid(
    "allows an object returned by a private helper",
    `
    import * as Effect from "effect/Effect";
    const options = (n: number) => {
      return { read: () => Effect.succeed(n) };
    };
    export const count = options(1);
  `,
  );

  rule.invalid(
    "reports an object returned by a layer's Effect.gen body",
    `
    import * as Effect from "effect/Effect";
    import * as Layer from "effect/Layer";
    declare const Tag: never;
    export const layer = Layer.effect(Tag, Effect.gen(function* () {
      return { read: () => Effect.void };
    }));
  `,
    (output) => assert.match(output, /'read' is public/),
  );

  rule.invalid(
    "reports an object returned by an exported Effect.gen constructor",
    `
    import * as Effect from "effect/Effect";
    export const make = Effect.gen(function* () {
      return { read: () => Effect.void };
    }).pipe(Effect.orDie);
  `,
  );

  rule.invalid(
    "reports an object returned by a make* function",
    `
    import * as Effect from "effect/Effect";
    const makeStore = () => {
      return { read: () => Effect.void };
    };
    export const store = makeStore();
  `,
  );

  // A reason says why there is no span.
  rule.valid(
    "accepts reasons naming every unit of work, untraced, or written after the =",
    `
    import * as Effect from "effect/Effect";
    // Runs for every domain event; most events return before any work is needed.
    export const handle = Effect.fnUntraced(function* () { yield* Effect.void; });
    // Desktop telemetry refreshes this process set on every sample.
    export const setExternalProcesses: (processes: ReadonlyArray<number>) => Effect.Effect<void> =
      Effect.fnUntraced(function* () { yield* Effect.void; });
    // Providers call this on every token-usage tick, usually without changing the snapshot.
    export const applyUsageLimits = Effect.fnUntraced(function* () { yield* Effect.void; });
    /** Stay untraced so this helper does not introduce another lazy frame to retain. */
    export const detachStackFrame = Effect.fnUntraced(function* () { yield* Effect.void; });
    /** Media routes authenticate the way the /ws upgrade does. */
    export const authenticateMediaRequest =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* () { yield* Effect.void; });
  `,
  );

  rule.invalid(
    "reports fnUntraced whose comment explains batching, not why it has no span",
    `
    import * as Effect from "effect/Effect";
    // Keep each source batch together so a synchronization marker cannot pass
    // events already pulled from PubSub but still being coalesced.
    export const offerAll = Effect.fnUntraced(function* () { yield* Effect.void; });
  `,
    (output) => assert.match(output, /without a reason/),
  );

  rule.invalid(
    "reports fnUntraced whose comment names every project, not a unit of work",
    `
    import * as Effect from "effect/Effect";
    // Shared by every project.
    export const read = Effect.fnUntraced(function* () { yield* Effect.void; });
  `,
    (output) => assert.match(output, /without a reason/),
  );

  rule.invalid(
    "reports fnUntraced whose comment does not say why it has no span",
    `
    import * as Effect from "effect/Effect";
    /** Reads the cached value and returns it to the caller quickly. */
    export const read = Effect.fnUntraced(function* () { yield* Effect.void; });
  `,
    (output) => assert.match(output, /without a reason/),
  );

  rule.invalid(
    "reports fnUntraced whose comment names a cache or a scope owner, not a span",
    `
    import * as Effect from "effect/Effect";
    // Cached per project.
    export const read = Effect.fnUntraced(function* () { yield* Effect.void; });
  `,
    (output) => assert.match(output, /without a reason/),
  );

  rule.invalid(
    "reports fnUntraced whose comment says the caller owns the scope",
    `
    import * as Effect from "effect/Effect";
    // The caller owns the scope.
    export const open = Effect.fnUntraced(function* () { yield* Effect.void; });
  `,
    (output) => assert.match(output, /without a reason/),
  );

  // A service built in a local binding, a callback or an option still has public members.
  const probes: ReadonlyArray<readonly [string, string]> = [
    [
      "a local Effect.gen passed to Layer.effect",
      `const live = Effect.gen(function* () { return { read: (id: string) => Effect.succeed(id) }; });
      export const layer = Layer.effect(Tag, live);`,
    ],
    [
      "a local Effect.gen with pipe(orDie) passed to Layer.effect",
      `const live = Effect.gen(function* () {
        return { read: (id: string) => Effect.succeed(id) };
      }).pipe(Effect.orDie);
      export const layer = Layer.effect(Tag, live);`,
    ],
    [
      "a local Effect.gen piped into Layer.effect",
      `const live = Effect.gen(function* () { return { read: (id: string) => Effect.succeed(id) }; });
      export const layer = live.pipe(Layer.effect(Tag));`,
    ],
    [
      "a local Effect.gen passed to Layer.scoped",
      `const live = Effect.gen(function* () { return { read: (id: string) => Effect.succeed(id) }; });
      export const layer = Layer.scoped(Tag, live);`,
    ],
    [
      "a service class built from an effect option",
      `export class Svc extends Service<Svc>()("Svc", {
        effect: Effect.gen(function* () { return { read: (id: string) => Effect.succeed(id) }; }),
      }) {}`,
    ],
    [
      "an Effect.map callback passed to Layer.effect",
      `export const layer = Layer.effect(Tag, Effect.map(Dep, (d) => ({ read: (id: string) => Effect.succeed(id) })));`,
    ],
    [
      "an Effect.map callback piped from a dependency into Layer.effect",
      `export const layer = Layer.effect(Tag, Dep.pipe(Effect.map((d) => ({ read: (id: string) => Effect.succeed(id) }))));`,
    ],
    [
      "an Effect.flatMap callback returning Effect.succeed into Layer.effect",
      `export const layer = Layer.effect(Tag, Effect.flatMap(Dep, (d) => Effect.succeed({ read: (id: string) => Effect.succeed(id) })));`,
    ],
    [
      "a driver's create body",
      `export const Driver = {
        create: Effect.fn("Driver.create")(function* () {
          const read = (id: string) => Effect.succeed(id);
          return { read };
        }),
      };`,
    ],
    [
      "an adapter a private helper builds for a driver's instance",
      `function select() { return { read: (id: string) => Effect.succeed(id) }; }
      export const Driver = {
        create: Effect.fn("Driver.create")(function* () {
          const adapter = select();
          return { adapter };
        }),
      };`,
    ],
    [
      "a handle returned by a service method",
      `export const layer = Layer.effect(Tag, Effect.gen(function* () {
        return Runner.of({
          open: Effect.fn("Runner.open")(function* () {
            return { read: (id: string) => Effect.succeed(id) };
          }),
        });
      }));`,
    ],
  ];
  for (const [name, body] of probes) {
    rule.invalid(
      `reports a member of ${name}`,
      `
      import * as Effect from "effect/Effect";
      import * as Layer from "effect/Layer";
      declare const Tag: never;
      declare const Dep: Effect.Effect<number>;
      declare const Runner: { of: <A>(value: A) => A };
      declare const Service: <S>() => (key: string, options: unknown) => new () => S;
      ${body}
    `,
      (output) => assert.match(output, /'read' is public/),
    );
  }

  rule.valid(
    "allows a local Effect.gen that no layer or export uses",
    `
    import * as Effect from "effect/Effect";
    const options = Effect.gen(function* () { return { read: (id: string) => Effect.succeed(id) }; });
    export const count = 1;
    export const run = Effect.fn("Options.run")(function* () { yield* options; });
  `,
  );

  rule.valid(
    "allows a private helper's handle that a traced method uses internally",
    `
    import * as Effect from "effect/Effect";
    function helper() { return { read: (id: string) => Effect.succeed(id) }; }
    export const run = Effect.fn("Helper.run")(function* () {
      const handle = helper();
      yield* handle.read("a");
    });
  `,
  );

  rule.valid(
    "allows a no-op Context.Reference default",
    `
    import * as Context from "effect/Context";
    import * as Effect from "effect/Effect";
    export class Analytics extends Context.Reference<{
      readonly record: () => Effect.Effect<void>;
    }>("Analytics", { defaultValue: () => ({ record: () => Effect.void }) }) {}
  `,
  );

  rule.valid(
    "allows fnUntraced whose comment names a hot path or an owning span",
    `
    import * as Effect from "effect/Effect";
    // Hot path: runs per provider event.
    export const ingest = Effect.fnUntraced(function* () { yield* Effect.void; });
    // The enclosing operation owns the span.
    export const merge = Effect.fnUntraced(function* () { yield* Effect.void; });
  `,
  );
});
