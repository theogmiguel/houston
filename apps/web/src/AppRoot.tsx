import { RouterProvider } from "@tanstack/react-router";

import { DesktopWindowControls } from "./components/DesktopWindowControls";
import { isQuickComposerWindow } from "./lib/desktopWindow";
import { LocalServerStatusBanner } from "./components/desktop/LocalServerStatusBanner";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { WindowResizeGrips } from "./components/WindowResizeGrips";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

export function AppRoot({ router }: { readonly router: AppRouter }) {
  const quickComposer = isQuickComposerWindow();
  return (
    <AppAtomRegistryProvider>
      {quickComposer ? null : <WindowResizeGrips />}
      <RouterProvider router={router} />
      <LocalServerStatusBanner />
      {quickComposer ? null : <DesktopWindowControls />}
      {quickComposer ? null : <QuitHoldOverlay />}
    </AppAtomRegistryProvider>
  );
}
