// Installed before the first renderer script. Upstream's web app expects the
// Electron preload's `window.desktopBridge`; this shim supplies the parts a
// Tauri host can serve now. Methods that need a native feature upstream had in
// Electron return an explicit safe value instead of pretending to work.
(function () {
  if (window.desktopBridge) return;

  var bootstrap = window.__HOUSTON_V2_BOOTSTRAP__ || [];
  var status = window.__HOUSTON_V2_STATUS__ || {};
  var origin = status.origin || null;
  var platform =
    window.__HOUSTON_V2_PLATFORM__ ||
    (navigator.userAgent.indexOf("Win") !== -1
      ? "win32"
      : navigator.userAgent.indexOf("Mac") !== -1
        ? "darwin"
        : "linux");
  var branding = window.__HOUSTON_V2_BRANDING__ || {
    baseName: "Houston",
    stageLabel: "Dev",
    displayName: "Houston Dev",
  };
  var locale = window.__HOUSTON_V2_LOCALE__ || null;
  var invoke = function (command, args) {
    return window.__TAURI__.core.invoke(command, args || {});
  };
  var noUnsubscribe = function () {
    return function () {};
  };
  var noop = function () {
    return Promise.resolve();
  };
  var storageGet = function (key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  };
  var storageSet = function (key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  };
  var updateState = {
    enabled: false,
    status: "disabled",
    channel: "latest",
    currentVersion: window.__HOUSTON_V2_VERSION__ || "0.0.0",
    hostArch: platform === "arm64" ? "arm64" : "other",
    appArch: platform === "arm64" ? "arm64" : "other",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: "Updates run through the Houston app.",
    errorContext: null,
    canRetry: false,
  };
  var cliState = {
    supported: false,
    installedPath: null,
    onPath: false,
    launcherPath: null,
  };
  var serverExposure = {
    mode: "local-only",
    endpointUrl: origin,
    advertisedHost: "127.0.0.1",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  };
  var wslState = {
    enabled: false,
    distro: null,
    available: false,
    wslOnly: false,
    distros: [],
    preflightError: null,
  };
  var snapshotState = {
    mode: "unavailable",
    shortcut: { kind: "both-shift-keys" },
    shortcutRegistered: false,
    shortcutMessage: "Screen capture is not available in this Houston build.",
    message: "Screen capture is not available in this Houston build.",
  };
  var preview = {
    setForwardedShortcuts: noop,
    createTab: noop,
    closeTab: noop,
    registerWebview: noop,
    navigate: noop,
    goBack: noop,
    goForward: noop,
    refresh: noop,
    zoomIn: noop,
    zoomOut: noop,
    resetZoom: noop,
    setZoomFactor: noop,
    hardReload: noop,
    setColorScheme: noop,
    setAudioMuted: noop,
    openDevTools: noop,
    clearCookies: noop,
    clearCache: noop,
    getPreviewConfig: function () {
      return Promise.resolve({ partition: "", webPreferences: "", preloadUrl: null });
    },
    listBrowserImportSources: function () {
      return Promise.resolve([]);
    },
    importBrowserCookies: function () {
      return Promise.resolve({ imported: 0, skipped: 0 });
    },
    setAnnotationTheme: noop,
    setAnnotationSendEnabled: noop,
    pickElement: function () {
      return Promise.resolve(null);
    },
    cancelPickElement: noop,
    captureScreenshot: function () {
      return Promise.resolve(null);
    },
    revealArtifact: noop,
    copyArtifactToClipboard: noop,
    pictureInPicture: { open: noop, close: noop },
    recording: {
      onInput: noUnsubscribe,
      startScreencast: function () {
        return Promise.resolve();
      },
      stopScreencast: noop,
      save: function () {
        return Promise.resolve(null);
      },
    },
    onStateChange: noUnsubscribe,
    onPointerEvent: noUnsubscribe,
    onOpenLink: noUnsubscribe,
  };

  var bridge = {
    getAppBranding: function () {
      return branding;
    },
    getRelayTelemetryEnabled: function () {
      return false;
    },
    getPathForFile: function () {
      return "";
    },
    getClientPlatform: function () {
      return platform;
    },
    setNotificationBadge: noop,
    onNotificationBadgeClear: noUnsubscribe,
    onTrackpadScrollEnd: noUnsubscribe,
    revealWindow: function () {
      return invoke("window_focus").catch(noop);
    },
    getSystemLocale: function () {
      return locale;
    },
    getLocalEnvironmentBootstraps: function () {
      return bootstrap;
    },
    getLocalEnvironmentEnabled: function () {
      return true;
    },
    setLocalEnvironmentEnabled: noop,
    getLocalEnvironmentBearerToken: function () {
      return invoke("v2_local_environment_bearer_token");
    },
    getClientSettings: function () {
      var raw = storageGet("houston:v2:client-settings");
      if (!raw) return Promise.resolve(null);
      try {
        return Promise.resolve(JSON.parse(raw));
      } catch (error) {
        return Promise.resolve(null);
      }
    },
    setClientSettings: function (settings) {
      storageSet("houston:v2:client-settings", JSON.stringify(settings));
      return Promise.resolve();
    },
    getConnectionCatalog: function () {
      return Promise.resolve(storageGet("houston:v2:connection-catalog"));
    },
    setConnectionCatalog: function (catalog) {
      return Promise.resolve(storageSet("houston:v2:connection-catalog", catalog));
    },
    discoverSshHosts: function () {
      return Promise.resolve([]);
    },
    resolveSshHost: function () {
      return Promise.reject(new Error("SSH environments are not available in this Houston build."));
    },
    requestSnapShotPermissions: noop,
    getSnapShotState: function () {
      return Promise.resolve(snapshotState);
    },
    setupSnapShot: noop,
    previewSnapShotConfig: function () {
      return Promise.resolve(null);
    },
    applySnapShotConfig: function () {
      return Promise.reject(new Error("Screen capture is not available in this Houston build."));
    },
    checkSnapShotShortcut: function () {
      return Promise.resolve({ available: false, message: "Screen capture is not available." });
    },
    setSnapShotShortcutSuppressed: noop,
    listPendingSnapShots: function () {
      return Promise.resolve([]);
    },
    readSnapShot: function () {
      return Promise.reject(new Error("Screen capture is not available in this Houston build."));
    },
    setSnapShotAnimationDestination: noop,
    dismissSnapShotAnimation: noop,
    acknowledgeSnapShot: noop,
    ensureSshEnvironment: function () {
      return Promise.reject(new Error("SSH environments are not available in this Houston build."));
    },
    disconnectSshEnvironment: noop,
    fetchSshEnvironmentDescriptor: function () {
      return Promise.reject(new Error("SSH environments are not available in this Houston build."));
    },
    bootstrapSshBearerSession: function () {
      return Promise.reject(new Error("SSH environments are not available in this Houston build."));
    },
    fetchSshSessionState: function () {
      return Promise.reject(new Error("SSH environments are not available in this Houston build."));
    },
    onSshPasswordPrompt: noUnsubscribe,
    resolveSshPasswordPrompt: noop,
    getServerExposureState: function () {
      return Promise.resolve(serverExposure);
    },
    setServerExposureMode: function () {
      return Promise.resolve(serverExposure);
    },
    setTailscaleServeEnabled: function () {
      return Promise.resolve(serverExposure);
    },
    getAdvertisedEndpoints: function () {
      return Promise.resolve([]);
    },
    getWslState: function () {
      return Promise.resolve(wslState);
    },
    setWslBackendEnabled: function () {
      return Promise.resolve(wslState);
    },
    setWslDistro: function () {
      return Promise.resolve(wslState);
    },
    setWslOnly: function () {
      return Promise.resolve(wslState);
    },
    pickFolder: function () {
      return invoke("dialog_pick_directory", {})
        .then(function (result) {
          return typeof result === "string" ? result : (result && result.path) || null;
        })
        .catch(function () {
          return null;
        });
    },
    pickProjectFavicon: function () {
      return Promise.resolve(null);
    },
    pickThemeFiles: function () {
      return Promise.resolve(null);
    },
    setTheme: noop,
    showContextMenu: function () {
      return Promise.resolve(null);
    },
    receiveProviderAuthCallback: function () {
      return Promise.reject(new Error("Provider auth callbacks are not available yet."));
    },
    cancelProviderAuthCallback: noop,
    openExternal: function (url) {
      return invoke("shell_open_external", { url: url })
        .then(function (result) {
          return result !== false;
        })
        .catch(function () {
          return false;
        });
    },
    openSystemSettings: function () {
      return Promise.resolve(false);
    },
    checkSystemPermission: function () {
      return Promise.resolve(false);
    },
    probeRemoteEditors: function () {
      return Promise.resolve([]);
    },
    pasteAsText: noop,
    onMenuAction: noUnsubscribe,
    onSnapShotEvent: noUnsubscribe,
    onQuitShortcut: noUnsubscribe,
    getWindowFullscreenState: function () {
      return false;
    },
    onWindowFullscreenStateChange: noUnsubscribe,
    getWindowZoomFactor: function () {
      return 1;
    },
    getUpdateState: function () {
      return Promise.resolve(updateState);
    },
    setUpdateChannel: function (channel) {
      updateState.channel = channel === "nightly" ? "nightly" : "latest";
      return Promise.resolve(updateState);
    },
    checkForUpdate: function () {
      return Promise.resolve({ checked: false, state: updateState });
    },
    downloadUpdate: function () {
      return Promise.resolve({ accepted: false, completed: false, state: updateState });
    },
    installUpdate: function () {
      return Promise.resolve({ accepted: false, completed: false, state: updateState });
    },
    onUpdateState: noUnsubscribe,
    cliCommand: {
      getState: function () {
        return Promise.resolve(cliState);
      },
      install: function () {
        return Promise.resolve(cliState);
      },
      uninstall: function () {
        return Promise.resolve(cliState);
      },
    },
    webLinks: {
      setReady: noop,
      onOpen: noUnsubscribe,
    },
    appActivation: {
      setReady: noop,
      complete: noop,
      onRequest: noUnsubscribe,
    },
    preview: preview,
  };

  window.desktopBridge = bridge;
})();
