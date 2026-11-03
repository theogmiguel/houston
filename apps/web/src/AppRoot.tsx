import { RouterProvider } from "@tanstack/react-router";

import { DesktopWindowControls } from "./components/DesktopWindowControls";
import { LocalServerStatusBanner } from "./components/desktop/LocalServerStatusBanner";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { WindowResizeGrips } from "./components/WindowResizeGrips";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <WindowResizeGrips />
      <RouterProvider router={router} />
      <LocalServerStatusBanner />
      <DesktopWindowControls />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
