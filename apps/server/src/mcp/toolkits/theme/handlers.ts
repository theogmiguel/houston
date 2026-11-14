import { OrchestratorMcpFailure } from "@houston-app/contracts";
import { THEME_GUIDE } from "@houston-app/shared/themeCss";
import { BUILT_IN_THEME_IDS, STANDARD_THEME_ID } from "@houston-app/shared/themePalettes";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import * as EnvironmentTheme from "../../../environmentTheme.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { ThemeToolkit } from "./tools.ts";

const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const layer = McpToolAccess.toLayer(ThemeToolkit, {
  houston_theme_read: McpToolAccess.reads(({ themeId }) =>
    Effect.gen(function* () {
      const themes = yield* EnvironmentTheme.EnvironmentThemeService;
      const {
        current,
        themes: published,
        theme,
      } = yield* themes.read(themeId).pipe(
        Effect.catchTags({
          EnvironmentThemeRefusedError: (error) => Effect.fail(invalidRequest(error.message)),
          ServerSettingsError: () => Effect.fail(unavailable()),
        }),
      );
      return {
        current,
        builtIn: [STANDARD_THEME_ID, ...BUILT_IN_THEME_IDS],
        published: published.map(({ id, name, css }) => ({ id, name, hasCss: Boolean(css) })),
        ...(theme === undefined ? {} : { theme: Struct.omit(theme, ["id"]) }),
        guide: THEME_GUIDE,
      };
    }),
  ),
  houston_theme_set: McpToolAccess.writesEnvironment(({ themeId, theme, appearance }, check) =>
    Effect.gen(function* () {
      const input =
        themeId !== undefined
          ? { themeId, theme, appearance }
          : theme === undefined && appearance !== undefined
            ? { appearance }
            : undefined;
      if (input === undefined) {
        return yield* invalidRequest(
          "Give `themeId`, `appearance`, or both. `theme` needs a `themeId`.",
        );
      }
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const themes = yield* EnvironmentTheme.EnvironmentThemeService;
      const set = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        yield* themes.apply(input).pipe(
          Effect.catchTags({
            EnvironmentThemeRefusedError: (error) => Effect.fail(invalidRequest(error.message)),
            EnvironmentThemeNotSelectedError: () => Effect.fail(unavailable()),
          }),
        );
        return {
          ...(themeId === undefined ? {} : { themeId }),
          ...(appearance === undefined ? {} : { appearance }),
          published: theme !== undefined,
        };
      });
      return yield* scope.thread === undefined
        ? set
        : executor.withLock(scope.thread.threadId, set);
    }),
  ),
});
