import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type EnvironmentThemeFile,
  ProviderInstanceId,
  ThreadId,
} from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  EnvironmentThemeRefusedError,
  EnvironmentThemeService,
} from "../../../environmentTheme.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThemeHandlers from "./handlers.ts";
import { ThemeToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:theme");
const threadId = ThreadId.make("thread:theme");
const AGENT_THEME = {
  name: "Agent Look",
  appearance: "dark",
  canvas: "#101010",
  accent: "#7aa2f7",
  css: "[data-chat-header] { border-bottom: 1px solid red; }",
} satisfies EnvironmentThemeFile;

const applied: Array<unknown> = [];

const layerDependencies = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId,
    requestNamespace: "provider:theme",
    thread: {
      threadId,
      providerSessionId: "provider:theme",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
  }),
  Layer.mock(EnvironmentThemeService)({
    read: (themeId) =>
      themeId === "missing"
        ? Effect.fail(
            new EnvironmentThemeRefusedError({
              themeId,
              problem: "is not a published theme.",
              known: ["agent-look"],
            }),
          )
        : Effect.succeed({
            current: "agent-look",
            themes: [{ id: "agent-look", ...AGENT_THEME }],
            ...(themeId === undefined ? {} : { theme: { id: themeId, ...AGENT_THEME } }),
          }),
    apply: (input) =>
      "themeId" in input && input.themeId === "missing"
        ? Effect.fail(
            new EnvironmentThemeRefusedError({
              themeId: input.themeId,
              problem: "is not a built-in or published theme.",
              known: ["grove", "agent-look"],
            }),
          )
        : Effect.sync(() => void applied.push(input)),
  }),
);

const layerTools = McpToolAccess.HandlersLayer.layer(ThemeHandlers.layer).pipe(
  Layer.provideMerge(layerDependencies),
);

it.effect("applies the theme through the service and reports a refusal as an invalid request", () =>
  Effect.gen(function* () {
    applied.length = 0;
    const toolkit = yield* ThemeToolkit;
    const call = (params: Parameters<typeof toolkit.handle<"houston_theme_set">>[1]) =>
      toolkit.handle("houston_theme_set", params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result),
      );

    expect(yield* call({ themeId: "agent-look", theme: AGENT_THEME })).toEqual({
      themeId: "agent-look",
      published: true,
    });
    expect(yield* call({ themeId: "grove" })).toEqual({ themeId: "grove", published: false });
    expect(yield* call({ appearance: "dark" })).toEqual({
      appearance: "dark",
      published: false,
    });
    expect(yield* call({ theme: AGENT_THEME })).toMatchObject({ code: "invalid_request" });
    expect(yield* call({})).toMatchObject({ code: "invalid_request" });
    expect(yield* call({ themeId: "missing" })).toMatchObject({
      code: "invalid_request",
      message:
        'Theme "missing" is not a built-in or published theme. Available: grove, agent-look.',
    });
    expect(applied).toEqual([
      { themeId: "agent-look", theme: AGENT_THEME, appearance: undefined },
      { themeId: "grove", theme: undefined, appearance: undefined },
      { appearance: "dark" },
    ]);
  }).pipe(Effect.provide(layerTools)),
);

it.effect("reads the themes with a guide that lists selectors and how to undo", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThemeToolkit;
    const read = (themeId?: string) =>
      toolkit.handle("houston_theme_read", themeId === undefined ? {} : { themeId }).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result),
      );

    const all = yield* read();
    expect(all).toMatchObject({
      current: "agent-look",
      published: [{ id: "agent-look", name: "Agent Look", hasCss: true }],
    });
    expect((all as { builtIn: ReadonlyArray<string> }).builtIn[0]).toBe("houston");
    expect(all).not.toHaveProperty("theme");
    expect((all as { guide: string }).guide).toContain("[data-chat-header]");
    expect((all as { guide: string }).guide).toContain("houston theme set");
    const one = (yield* read("agent-look")) as { theme: Record<string, unknown> };
    expect(one.theme).toMatchObject({ name: "Agent Look", css: AGENT_THEME.css });
    expect(one.theme).not.toHaveProperty("id");
    expect(yield* read("missing")).toMatchObject({
      code: "invalid_request",
      message: 'Theme "missing" is not a published theme. Available: agent-look.',
    });
  }).pipe(Effect.provide(layerTools)),
);
