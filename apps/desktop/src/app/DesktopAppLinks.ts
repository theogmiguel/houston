// @effect-diagnostics nodeBuiltinImport:off -- deep-link launch arguments need a synchronous directory check.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import { codexAuthDeliveryUrl, readCodexAuthHandoff } from "@houston-app/shared/codexAuthHandoff";
import * as HostProcess from "@houston-app/shared/HostProcess";
import { providerAuthReturnUrl } from "@houston-app/shared/providerAuthReturnUrl";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { CodexAuthCallbackError, receiveCodexAuthCallback } from "./CodexAuthCallback.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import { isDeepLink, resolveLaunchTargets } from "./DesktopLaunchTargets.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

export class DesktopAppLinks extends Context.Service<
  DesktopAppLinks,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      | ElectronWindow.ElectronWindow
      | DesktopWebLinks.DesktopWebLinks
      | DesktopAppActivation.DesktopAppActivation
      | Scope.Scope
    >;
  }
>()("@houston-app/desktop/app/DesktopAppLinks") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const shell = yield* ElectronShell.ElectronShell;

  const pendingSecondInstances: Array<{ readonly argv: readonly string[]; readonly cwd: string }> =
    [];
  let handleSecondInstance = (argv: readonly string[], cwd: string) => {
    pendingSecondInstances.push({ argv, cwd });
  };
  yield* electronApp.on(
    "second-instance",
    (_event: unknown, argv: readonly string[], cwd: string) => {
      handleSecondInstance(argv, cwd);
    },
  );

  // macOS hands a launch link to open-url, which can fire before configure runs.
  const pendingOpenUrls: string[] = [];
  let handleOpenUrl = (url: string) => {
    pendingOpenUrls.push(url);
    return true;
  };
  yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
    if (handleOpenUrl(url)) event.preventDefault();
  });

  return DesktopAppLinks.of({
    configure: Effect.gen(function* () {
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      const activation = yield* DesktopAppActivation.DesktopAppActivation;
      const context = yield* Effect.context<
        ElectronWindow.ElectronWindow | DesktopAppActivation.DesktopAppActivation
      >();
      const runPromise = Effect.runPromiseWith(context);
      const schemes = [
        ...new Set(["houston", ElectronProtocol.getDesktopScheme(environment.isDevelopment)]),
      ];
      const isDirectory = (value: string) => {
        try {
          return NodeFS.statSync(value, { throwIfNoEntry: false })?.isDirectory() ?? false;
        } catch {
          return false;
        }
      };

      const startProviderAuthHandoff = (value: string | undefined) => {
        if (!value) return false;
        const request = readCodexAuthHandoff(value, environment.isDevelopment);
        if (!request) return false;
        void runPromise(
          Effect.gen(function* () {
            yield* electronApp.whenReady;
            yield* Effect.tryPromise({
              try: () =>
                receiveCodexAuthCallback(
                  request.authorizationUrl,
                  (url) => runPromise(shell.openExternal(url)),
                  (callbackUrl) => codexAuthDeliveryUrl(request, callbackUrl),
                ),
              catch: () =>
                new CodexAuthCallbackError({
                  detail:
                    "Could not receive hosted web ChatGPT sign-in. Retry or use the redirect URL in the web app.",
                }),
            });
          }).pipe(
            Effect.catch(() => Effect.logWarning("Could not complete ChatGPT desktop handoff.")),
          ),
        );
        return true;
      };
      const resumeProviderAuth = (value: string | undefined) => {
        const destination = providerAuthReturnUrl(value);
        const expectedOrigin = `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}://app`;
        if (!destination?.startsWith(`${expectedOrigin}/`)) return false;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isNone(mainWindow)) return;
            yield* Effect.promise(() => mainWindow.value.loadURL(destination));
            yield* electronWindow.reveal(mainWindow.value);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not return to provider setup", cause),
            ),
          ),
        );
        return true;
      };
      const openWebLink = (url: string) => {
        if (!DesktopWebLinks.isWebLink(url) && !isDeepLink(url, schemes)) return false;
        void runPromise(webLinks.receive(url));
        return true;
      };
      const handleLink = (url: string) =>
        startProviderAuthHandoff(url) || resumeProviderAuth(url) || openWebLink(url);
      handleOpenUrl = handleLink;
      for (const url of pendingOpenUrls.splice(0)) handleOpenUrl(url);
      yield* electronApp.on("open-file", (event: { preventDefault: () => void }, path: string) => {
        if (!DesktopWebLinks.isWebPageFile(path)) return;
        event.preventDefault();
        void runPromise(webLinks.receive(NodeURL.pathToFileURL(path).href));
      });
      const openLaunchTargets = (args: readonly string[], cwd: string) => {
        const targets = resolveLaunchTargets({ args, cwd, schemes, isDirectory });
        for (const url of targets.webLinks) handleLink(url);
        for (const workspace of targets.workspaces) {
          void runPromise(activation.activateWorkspace(workspace));
        }
      };
      handleSecondInstance = (argv, cwd) => {
        openLaunchTargets(argv, cwd);
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) yield* electronWindow.reveal(mainWindow.value);
          }),
        );
      };
      for (const pending of pendingSecondInstances.splice(0)) {
        handleSecondInstance(pending.argv, pending.cwd);
      }

      const args = yield* HostProcess.Arguments;
      const workingDirectory = yield* HostProcess.WorkingDirectory;
      openLaunchTargets(args, workingDirectory);
    }).pipe(Effect.withSpan("desktop.appLinks.configure")),
  });
});

export const layer = Layer.effect(DesktopAppLinks, make);
