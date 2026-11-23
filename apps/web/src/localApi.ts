import type { ConfirmDialogOptions, ContextMenuItem, LocalApi } from "@houston-app/contracts";

import { requestConfirmDialog } from "./confirmDialog";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;

export function createLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.hostBridge) return null;
        return window.hostBridge.pickFolder(options);
      },
      confirm: async (message, options?: ConfirmDialogOptions) => {
        return requestConfirmDialog(message, options) ?? false;
      },
    },
    shell: {
      openExternal: async (url) => {
        if (window.hostBridge) {
          const opened = await window.hostBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
      openSystemSettings: async (pane) => {
        if (!window.hostBridge) {
          throw new Error("Unable to open System Settings.");
        }
        const opened = await window.hostBridge.openSystemSettings(pane);
        if (!opened) {
          throw new Error("Unable to open System Settings.");
        }
      },
    },
    // Drawn in the page on every host: native menus on Linux and Windows drop item icons
    // and section headers.
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => showContextMenuFallback(items, position),
      // The page menu needs dismissal when the state underneath it disappears.
      close: async () => {
        dismissContextMenu();
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.hostBridge) {
          return window.hostBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.hostBridge) {
          return window.hostBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
  };
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}
