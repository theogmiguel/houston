import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter/opsz.css";
import "./index.css";

import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

const router = startAppServices();

let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = <AppRoot router={router} />;

export const startup = router
  .load()
  .then(() => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>{app}</React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
