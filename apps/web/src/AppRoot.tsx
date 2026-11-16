import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { DesktopWindowControls } from "./components/DesktopWindowControls";
import { isQuickComposerWindow } from "./lib/desktopWindow";
import { LocalServerStatusBanner } from "./components/desktop/LocalServerStatusBanner";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

export function AppRoot({ router }: { readonly router: AppRouter }) {
  const quickComposer = isQuickComposerWindow();
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      {quickComposer ? null : <ElectronBrowserHost />}
      <LocalServerStatusBanner />
      {quickComposer ? null : <DesktopWindowControls />}
      {quickComposer ? null : <QuitHoldOverlay />}
    </AppAtomRegistryProvider>
  );
}
