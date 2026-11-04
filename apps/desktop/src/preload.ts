import type {
  HostBridge,
  DesktopPreviewOpenLinkEvent,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingInputEvent,
  DesktopPreviewTabState,
  DesktopSnapShotEvent,
} from "@houston-app/contracts";
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

import * as IpcChannels from "./ipc/channels.ts";
import { mergeLegacyLocalStorage } from "./legacyLocalStorageMerge.ts";

const SNAP_SHOT_EVENT_TYPES = new Set([
  "requested",
  "started",
  "ready",
  "failed",
  "shortcut-changed",
]);
function isSnapShotEvent(value: unknown): value is DesktopSnapShotEvent {
  if (typeof value !== "object" || value === null) return false;
  const { type, id } = value as { type?: unknown; id?: unknown };
  return (
    typeof type === "string" &&
    SNAP_SHOT_EVENT_TYPES.has(type) &&
    (id === undefined || typeof id === "string")
  );
}

// Runs before any app script reads localStorage. See DesktopLegacyLocalStorage.
try {
  const legacyItems: unknown = ipcRenderer.sendSync(IpcChannels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL);
  if (typeof legacyItems === "object" && legacyItems !== null) {
    if (mergeLegacyLocalStorage(window.localStorage, legacyItems as Record<string, string>)) {
      void ipcRenderer.invoke(IpcChannels.COMPLETE_LEGACY_LOCAL_STORAGE_CHANNEL);
    }
  }
} catch {}

// oxlint-disable-next-line houston/no-global-process-runtime -- Electron exposes the client platform in its sandboxed preload process.
const clientPlatform = process.platform;

if (clientPlatform === "darwin") {
  // Native buttons ignore Chromium zoom; reserve native points even after reload.
  const syncWindowControlInset = () => {
    document.documentElement.style.setProperty(
      "--desktop-window-controls-inset",
      `${90 / webFrame.getZoomFactor()}px`,
    );
  };
  window.addEventListener("DOMContentLoaded", syncWindowControlInset, { once: true });
  window.addEventListener("resize", syncWindowControlInset);
}

function unwrapEnsureSshEnvironmentResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }
  return result as Awaited<ReturnType<HostBridge["ensureSshEnvironment"]>>;
}

contextBridge.exposeInMainWorld("hostBridge", {
  getAppBranding: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<HostBridge["getAppBranding"]>;
  },
  getRelayTelemetryEnabled: () =>
    ipcRenderer.sendSync(IpcChannels.GET_RELAY_TELEMETRY_ENABLED_CHANNEL) === true,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getClientPlatform: () => clientPlatform,
  logDebug: (source, message, payload) =>
    ipcRenderer.invoke(IpcChannels.LOG_DEBUG_CHANNEL, { source, message, payload }),
  setNotificationBadge: (badge) =>
    ipcRenderer.invoke(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, badge),
  onNotificationBadgeClear: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, handler);
  },
  notificationsSupported: () => ipcRenderer.invoke(IpcChannels.NOTIFICATIONS_SUPPORTED_CHANNEL),
  notifyThread: (payload) => ipcRenderer.invoke(IpcChannels.NOTIFY_THREAD_CHANNEL, payload),
  onThreadNotificationFocus: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, threadKey: unknown) => {
      if (typeof threadKey === "string") listener(threadKey);
    };
    ipcRenderer.on(IpcChannels.THREAD_NOTIFICATION_FOCUS_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.THREAD_NOTIFICATION_FOCUS_CHANNEL, wrappedListener);
    };
  },
  onTrackpadScrollEnd: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IpcChannels.TRACKPAD_SCROLL_END_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.TRACKPAD_SCROLL_END_CHANNEL, handler);
  },
  revealWindow: () => ipcRenderer.invoke(IpcChannels.REVEAL_WINDOW_CHANNEL),
  getSystemLocale: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_SYSTEM_LOCALE_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getLocalEnvironmentBootstraps: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL);
    if (!Array.isArray(result)) {
      return [];
    }
    return result as ReturnType<HostBridge["getLocalEnvironmentBootstraps"]>;
  },
  getLocalEnvironmentBearerToken: () =>
    ipcRenderer.invoke(IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL),
  getLocalEnvironmentEnabled: () =>
    ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL) !== false,
  setLocalEnvironmentEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL, enabled),
  invalidateLocalEnvironmentBearerToken: () => Promise.resolve(),
  getServerStatus: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_STATUS_CHANNEL),
  restartServer: () => Promise.resolve({ state: "ready" }),
  onServerStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => {
      if (typeof status === "object" && status !== null) {
        listener(status as Parameters<typeof listener>[0]);
      }
    };
    ipcRenderer.on(IpcChannels.SERVER_STATUS_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.SERVER_STATUS_CHANGED_CHANNEL, handler);
  },
  traySync: (payload) => ipcRenderer.invoke(IpcChannels.TRAY_SYNC_CHANNEL, payload),
  trayState: () => ipcRenderer.invoke(IpcChannels.TRAY_STATE_CHANNEL, undefined),
  setKeepInTray: (enabled) =>
    ipcRenderer.invoke(IpcChannels.TRAY_SET_KEEP_IN_TRAY_CHANNEL, enabled),
  onTrayFocus: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, threadKey: unknown) => {
      if (typeof threadKey === "string") listener(threadKey);
    };
    ipcRenderer.on(IpcChannels.TRAY_FOCUS_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.TRAY_FOCUS_CHANNEL, wrappedListener);
    };
  },
  getQuickComposerStatus: () =>
    ipcRenderer.invoke(IpcChannels.GET_QUICK_COMPOSER_STATUS_CHANNEL, undefined),
  setQuickComposerShortcut: (shortcut) =>
    ipcRenderer.invoke(IpcChannels.SET_QUICK_COMPOSER_SHORTCUT_CHANNEL, shortcut),
  openQuickComposer: () => ipcRenderer.invoke(IpcChannels.OPEN_QUICK_COMPOSER_CHANNEL, undefined),
  closeQuickComposer: () => ipcRenderer.invoke(IpcChannels.CLOSE_QUICK_COMPOSER_CHANNEL, undefined),
  onWindowHiddenChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, hidden: unknown) => {
      if (typeof hidden === "boolean") listener(hidden);
    };
    ipcRenderer.on(IpcChannels.TRAY_WINDOW_HIDDEN_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.TRAY_WINDOW_HIDDEN_CHANNEL, wrappedListener);
    };
  },
  houstonV1Cleanup: {
    getReport: () => ipcRenderer.invoke(IpcChannels.GET_V1_CLEANUP_REPORT_CHANNEL),
  },
  getClientSettings: () => ipcRenderer.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) =>
    ipcRenderer.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
  requestSnapShotPermissions: (includeAccessibility) =>
    ipcRenderer.invoke(IpcChannels.REQUEST_SNAP_SHOT_PERMISSIONS_CHANNEL, includeAccessibility),
  getSnapShotState: () => ipcRenderer.invoke(IpcChannels.GET_SNAP_SHOT_STATE_CHANNEL),
  setupSnapShot: (action) => ipcRenderer.invoke(IpcChannels.SETUP_SNAP_SHOT_CHANNEL, action),
  previewSnapShotConfig: (request) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_SNAP_SHOT_CONFIG_CHANNEL, request),
  applySnapShotConfig: (id) => ipcRenderer.invoke(IpcChannels.APPLY_SNAP_SHOT_CONFIG_CHANNEL, id),
  checkSnapShotShortcut: (shortcut) =>
    ipcRenderer.invoke(IpcChannels.CHECK_SNAP_SHOT_SHORTCUT_CHANNEL, shortcut),
  setSnapShotShortcutSuppressed: (suppressed) =>
    ipcRenderer.invoke(IpcChannels.SET_SNAP_SHOT_SHORTCUT_SUPPRESSED_CHANNEL, suppressed),
  listPendingSnapShots: () => ipcRenderer.invoke(IpcChannels.LIST_PENDING_SNAP_SHOTS_CHANNEL),
  readSnapShot: (id) => ipcRenderer.invoke(IpcChannels.READ_SNAP_SHOT_CHANNEL, id),
  setSnapShotAnimationDestination: (destination) =>
    ipcRenderer.invoke(IpcChannels.SET_SNAP_SHOT_ANIMATION_DESTINATION_CHANNEL, destination),
  dismissSnapShotAnimation: (id) =>
    ipcRenderer.invoke(IpcChannels.DISMISS_SNAP_SHOT_ANIMATION_CHANNEL, id),
  acknowledgeSnapShot: (id) => ipcRenderer.invoke(IpcChannels.ACKNOWLEDGE_SNAP_SHOT_CHANNEL, id),
  getConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.GET_CONNECTION_CATALOG_CHANNEL),
  setConnectionCatalog: (catalog) =>
    ipcRenderer.invoke(IpcChannels.SET_CONNECTION_CATALOG_CHANNEL, catalog),
  discoverSshHosts: () => ipcRenderer.invoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL),
  resolveSshHost: (alias) => ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_HOST_CHANNEL, alias),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      await ipcRenderer.invoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL, {
        target,
        ...(options === undefined ? {} : { options }),
      }),
    ),
  disconnectSshEnvironment: (target) =>
    ipcRenderer.invoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, { httpBaseUrl }),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    ipcRenderer.invoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, {
      httpBaseUrl,
      credential,
    }),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL, { httpBaseUrl, bearerToken }),
  onSshPasswordPrompt: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    };
  },
  resolveSshPasswordPrompt: (requestId, password) =>
    ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, { requestId, password }),
  getServerExposureState: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode) =>
    ipcRenderer.invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
  setTailscaleServeEnabled: (input) =>
    ipcRenderer.invoke(IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input),
  getAdvertisedEndpoints: () => ipcRenderer.invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL),
  getWslState: () => ipcRenderer.invoke(IpcChannels.GET_WSL_STATE_CHANNEL),
  setWslBackendEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL, enabled),
  setWslDistro: (distro) => ipcRenderer.invoke(IpcChannels.SET_WSL_DISTRO_CHANNEL, distro),
  setWslOnly: (enabled) => ipcRenderer.invoke(IpcChannels.SET_WSL_ONLY_CHANNEL, enabled),
  pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
  pickProjectFavicon: (initialPath) =>
    ipcRenderer.invoke(IpcChannels.PICK_PROJECT_FAVICON_CHANNEL, initialPath),
  pickThemeFiles: () => ipcRenderer.invoke(IpcChannels.PICK_THEME_FILES_CHANNEL, undefined),
  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) =>
    ipcRenderer.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
      items,
      ...(position === undefined ? {} : { position }),
    }),
  receiveProviderAuthCallback: (url: string) =>
    ipcRenderer.invoke(IpcChannels.RECEIVE_PROVIDER_AUTH_CALLBACK_CHANNEL, url),
  cancelProviderAuthCallback: (url: string) =>
    ipcRenderer.invoke(IpcChannels.CANCEL_PROVIDER_AUTH_CALLBACK_CHANNEL, url),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  checkSystemPermission: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.CHECK_SYSTEM_PERMISSION_CHANNEL, pane),
  openSystemSettings: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.OPEN_SYSTEM_SETTINGS_CHANNEL, pane),
  probeRemoteEditors: () => ipcRenderer.invoke(IpcChannels.PROBE_REMOTE_EDITORS_CHANNEL, undefined),
  pasteAsText: () => ipcRenderer.invoke(IpcChannels.PASTE_AS_TEXT_CHANNEL, undefined),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  onSnapShotEvent: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
      if (!isSnapShotEvent(event)) return;
      listener(event);
    };

    ipcRenderer.on(IpcChannels.SNAP_SHOT_EVENT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SNAP_SHOT_EVENT_CHANNEL, wrappedListener);
    };
  },
  onQuitShortcut: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, hint: unknown) => {
      if (typeof hint !== "object" || hint === null || !("state" in hint)) return;
      if (hint.state === "up") {
        listener({ state: "up" });
        return;
      }
      if (
        hint.state === "down" &&
        "mode" in hint &&
        (hint.mode === "hold" || hint.mode === "double-click")
      ) {
        listener({ state: "down", mode: hint.mode });
      }
    };

    ipcRenderer.on(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    };
  },
  getWindowFullscreenState: () =>
    ipcRenderer.sendSync(IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL) === true,
  getWindowZoomFactor: () => webFrame.getZoomFactor(),
  closeWindow: () => ipcRenderer.invoke(IpcChannels.CLOSE_WINDOW_CHANNEL, undefined),
  minimizeWindow: () => ipcRenderer.invoke(IpcChannels.MINIMIZE_WINDOW_CHANNEL, undefined),
  toggleMaximizeWindow: () =>
    ipcRenderer.invoke(IpcChannels.TOGGLE_MAXIMIZE_WINDOW_CHANNEL, undefined),
  getWindowMaximizedState: () =>
    ipcRenderer.sendSync(IpcChannels.GET_WINDOW_MAXIMIZED_STATE_CHANNEL) === true,
  onWindowMaximizedStateChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, maximized: unknown) => {
      if (typeof maximized !== "boolean") return;
      listener(maximized);
    };

    ipcRenderer.on(IpcChannels.WINDOW_MAXIMIZED_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WINDOW_MAXIMIZED_STATE_CHANNEL, wrappedListener);
    };
  },
  getWindowButtonLayout: () =>
    ipcRenderer.invoke(IpcChannels.GET_WINDOW_BUTTON_LAYOUT_CHANNEL, undefined),
  onWindowFullscreenStateChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
      if (typeof fullscreen !== "boolean") return;
      listener(fullscreen);
    };

    ipcRenderer.on(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL),
  setUpdateChannel: (channel, minimumVersion) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, { channel, minimumVersion }),
  checkForUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: (expectedVersion) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_INSTALL_CHANNEL, expectedVersion),
  cliCommand: {
    getState: () => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_GET_STATE_CHANNEL),
    install: () => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_INSTALL_CHANNEL),
    uninstall: () => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_UNINSTALL_CHANNEL),
  },
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  webLinks: {
    setReady: (ready) => ipcRenderer.invoke(IpcChannels.WEB_LINK_READY_CHANNEL, ready),
    onOpen: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, url: unknown) => {
        if (typeof url === "string") listener(url);
      };
      ipcRenderer.on(IpcChannels.WEB_LINK_OPEN_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.WEB_LINK_OPEN_CHANNEL, wrappedListener);
      };
    },
  },
  appActivation: {
    setReady: (ready) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL, ready),
    complete: (response) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL, response),
    onRequest: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
        if (typeof request !== "object" || request === null) return;
        listener(request as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IpcChannels.DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(
          IpcChannels.DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL,
          wrappedListener,
        );
      };
    },
  },
  preview: {
    setForwardedShortcuts: (shortcuts) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_FORWARDED_SHORTCUTS_CHANNEL, shortcuts),
    createTab: (tabId, defaults) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, {
        tabId,
        zoomFactor: defaults?.zoomFactor,
        serverTab: defaults?.serverTab,
        colorScheme: defaults?.colorScheme,
      }),
    closeTab: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, { tabId }),
    registerWebview: (tabId, webContentsId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, { tabId, webContentsId }),
    navigate: (tabId, url) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_NAVIGATE_CHANNEL, { tabId, url }),
    goBack: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_BACK_CHANNEL, { tabId }),
    goForward: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, { tabId }),
    refresh: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_REFRESH_CHANNEL, { tabId }),
    zoomIn: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, { tabId }),
    zoomOut: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, { tabId }),
    resetZoom: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, { tabId }),
    setZoomFactor: (tabId, zoomFactor) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ZOOM_FACTOR_CHANNEL, { tabId, zoomFactor }),
    hardReload: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, { tabId }),
    setColorScheme: (tabId, colorScheme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, { tabId, colorScheme }),
    setAudioMuted: (tabId, audioMuted) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, { tabId, audioMuted }),
    openDevTools: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, { tabId }),
    listBrowserImportSources: () => ipcRenderer.invoke(IpcChannels.PREVIEW_IMPORT_SOURCES_CHANNEL),
    importBrowserCookies: (input) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_IMPORT_COOKIES_CHANNEL, input),
    clearCookies: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL, { environmentId, profileId }),
    clearCache: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL, { environmentId, profileId }),
    getPreviewConfig: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, { environmentId, profileId }),
    setAnnotationTheme: (theme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL, { theme }),
    setAnnotationSendEnabled: (tabId, enabled) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_SEND_ENABLED_CHANNEL, {
        tabId,
        enabled,
      }),
    pickElement: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, { tabId }),
    cancelPickElement: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, { tabId }),
    captureScreenshot: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, { tabId }),
    revealArtifact: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, { path }),
    copyArtifactToClipboard: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL, { path }),
    pictureInPicture: {
      open: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL, { tabId }),
      close: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL, { tabId }),
    },
    recording: {
      onInput: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
          if (typeof event !== "object" || event === null) return;
          listener(event as DesktopPreviewRecordingInputEvent);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, wrappedListener);
        return () =>
          ipcRenderer.removeListener(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, wrappedListener);
      },
      startScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_START_CHANNEL, { tabId }),
      stopScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL, { tabId }),
      save: (tabId, mimeType, data) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL, {
          tabId,
          mimeType,
          data,
        }),
    },
    onStateChange: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        tabId: unknown,
        state: unknown,
      ) => {
        if (typeof tabId !== "string" || typeof state !== "object" || state === null) return;
        listener(tabId, state as DesktopPreviewTabState);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
    },
    onPointerEvent: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, pointerEvent: unknown) => {
        if (typeof pointerEvent !== "object" || pointerEvent === null) return;
        listener(pointerEvent as DesktopPreviewPointerEvent);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
    },
    onOpenLink: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, linkEvent: unknown) => {
        if (typeof linkEvent !== "object" || linkEvent === null) return;
        listener(linkEvent as DesktopPreviewOpenLinkEvent);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_OPEN_LINK_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_OPEN_LINK_CHANNEL, wrappedListener);
    },
  },
} satisfies HostBridge);
