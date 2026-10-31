import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { DesktopWindowControls } from "./components/DesktopWindowControls";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { WindowResizeGrips } from "./components/WindowResizeGrips";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <WindowResizeGrips />
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      <DesktopWindowControls />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
