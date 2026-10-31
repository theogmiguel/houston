// Installed before the first renderer script. Upstream's web app expects the
// Electron preload's `window.desktopBridge`; this shim supplies the parts a
// Tauri host can serve now, returning an explicit safe value for the rest.
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
  // Tauri's event API returns a promise for the unsubscribe function. Keep the
  // listener's lifetime stable for the bridge's whole lifetime and swallow a
  // missing event plugin rather than breaking bridge construction.
  var listen = function (eventName, handler) {
    if (!window.__TAURI__ || !window.__TAURI__.event) return noUnsubscribe();
    var active = true;
    var subscription = window.__TAURI__.event
      .listen(eventName, function (event) {
        handler(event.payload);
      })
      .catch(function () {
        return noop;
      });
    return function () {
      if (!active) return;
      active = false;
      subscription.then(function (unsubscribe) {
        try {
          unsubscribe();
        } catch (error) {}
      });
    };
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
  var zoomFactor = 1;
  var fullscreen = false;
  var contextMenuWaiters = {};
  var contextMenuNonce = 0;
  var contextMenuListening = false;
  var contextMenuListener = function (payload) {
    if (!payload || typeof payload.nonce !== "string") return;
    var waiter = contextMenuWaiters[payload.nonce];
    if (!waiter) return;
    delete contextMenuWaiters[payload.nonce];
    clearTimeout(waiter.timer);
    waiter.resolve(typeof payload.id === "string" ? payload.id : null);
  };
  var ensureContextMenuListener = function () {
    if (contextMenuListening) return;
    contextMenuListening = true;
    listen("v2-context-menu", contextMenuListener);
  };
  var nextContextMenuNonce = function () {
    contextMenuNonce += 1;
    return "menu" + Date.now().toString(36) + contextMenuNonce.toString(36);
  };
  var snapshotState = {
    mode: "unavailable",
    shortcut: { kind: "both-shift-keys" },
    shortcutRegistered: false,
    shortcutMessage: null,
    message: null,
  };
  var snapShotSettings = function (settings) {
    var value = settings || {};
    return {
      enabled: !!value.snapShotEnabled,
      includeAccessibility:
        value.snapShotIncludeAccessibility === undefined
          ? true
          : !!value.snapShotIncludeAccessibility,
      shortcut: value.snapShotShortcut || { kind: "both-shift-keys" },
      flash: value.snapShotFlash === undefined ? true : !!value.snapShotFlash,
      animations: value.snapShotAnimations === undefined ? true : !!value.snapShotAnimations,
    };
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
    revealArtifact: function (path) {
      return invoke("shell_reveal_item_in_folder", { path: path }).catch(noop);
    },
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
    setNotificationBadge: function (badge) {
      var count = badge && typeof badge.count === "number" ? Math.max(0, Math.floor(badge.count)) : 0;
      return invoke("window_set_badge_count", { count: count }).catch(noop);
    },
    onNotificationBadgeClear: function (listener) {
      return listen("v2-notification-badge-clear", listener);
    },
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
      return invoke("snap_shot_configure", { settings: snapShotSettings(settings) }).catch(noop);
    },
    getConnectionCatalog: function () {
      return Promise.resolve(storageGet("houston:v2:connection-catalog"));
    },
    setConnectionCatalog: function (catalog) {
      return Promise.resolve(storageSet("houston:v2:connection-catalog", catalog));
    },
    discoverSshHosts: function () {
      return invoke("v2_ssh_discover_hosts");
    },
    resolveSshHost: function (alias) {
      return invoke("v2_ssh_resolve_host", { alias: alias });
    },
    requestSnapShotPermissions: function (includeAccessibility) {
      return invoke("snap_shot_request_permissions", {
        includeAccessibility: !!includeAccessibility,
      }).catch(noop);
    },
    getSnapShotState: function () {
      return invoke("snap_shot_state")
        .then(function (state) {
          snapshotState = state;
          return state;
        })
        .catch(function () {
          return snapshotState;
        });
    },
    setupSnapShot: function (action) {
      return invoke("snap_shot_setup", { action: action });
    },
    previewSnapShotConfig: function (request) {
      return invoke("snap_shot_preview_config", { request: request });
    },
    applySnapShotConfig: function (previewId) {
      return invoke("snap_shot_apply_config", { previewId: previewId });
    },
    checkSnapShotShortcut: function (shortcut) {
      return invoke("snap_shot_check_shortcut", { shortcut: shortcut });
    },
    setSnapShotShortcutSuppressed: function (suppressed) {
      return invoke("snap_shot_set_shortcut_suppressed", {
        suppressed: !!suppressed,
      }).catch(noop);
    },
    listPendingSnapShots: function () {
      return invoke("snap_shot_list_pending").catch(function () {
        return [];
      });
    },
    readSnapShot: function (id) {
      return invoke("snap_shot_read", { id: id });
    },
    setSnapShotAnimationDestination: function (id, destination) {
      return invoke("snap_shot_set_animation_destination", {
        id: id,
        destination: destination,
      }).catch(noop);
    },
    dismissSnapShotAnimation: function (id) {
      return invoke("snap_shot_dismiss_animation", { id: id }).catch(noop);
    },
    acknowledgeSnapShot: function (id) {
      return invoke("snap_shot_acknowledge", { id: id }).catch(noop);
    },
    ensureSshEnvironment: function (target, options) {
      return invoke("v2_ssh_ensure_environment", {
        target: target,
        options: options === undefined ? null : options,
      }).then(function (result) {
        if (result && result.type === "ssh-password-prompt-cancelled") {
          throw new Error(
            typeof result.message === "string" ? result.message : "SSH authentication cancelled.",
          );
        }
        return result;
      });
    },
    disconnectSshEnvironment: function (target) {
      return invoke("v2_ssh_disconnect_environment", { target: target });
    },
    fetchSshEnvironmentDescriptor: function (httpBaseUrl) {
      return invoke("v2_ssh_fetch_environment_descriptor", { httpBaseUrl: httpBaseUrl });
    },
    bootstrapSshBearerSession: function (httpBaseUrl, credential) {
      return invoke("v2_ssh_bootstrap_bearer_session", {
        httpBaseUrl: httpBaseUrl,
        credential: credential,
      });
    },
    fetchSshSessionState: function (httpBaseUrl, bearerToken) {
      return invoke("v2_ssh_fetch_session_state", {
        httpBaseUrl: httpBaseUrl,
        bearerToken: bearerToken,
      });
    },
    onSshPasswordPrompt: function (listener) {
      return listen("v2-ssh-password-prompt", function (request) {
        if (!request || typeof request.requestId !== "string") return;
        listener(request);
      });
    },
    resolveSshPasswordPrompt: function (requestId, password) {
      return invoke("v2_ssh_resolve_password_prompt", {
        requestId: requestId,
        password: password === null ? null : password,
      });
    },
    getServerExposureState: function () {
      return invoke("v2_server_exposure_state")
        .then(function (state) {
          serverExposure = state;
          return state;
        })
        .catch(function () {
          return serverExposure;
        });
    },
    setServerExposureMode: function (mode) {
      return invoke("v2_server_set_exposure_mode", { mode: mode }).then(function (state) {
        serverExposure = state;
        return state;
      });
    },
    setTailscaleServeEnabled: function (input) {
      return invoke("v2_server_set_tailscale_serve", {
        enabled: !!(input && input.enabled),
        port: input && typeof input.port === "number" ? input.port : null,
      }).then(function (state) {
        serverExposure = state;
        return state;
      });
    },
    getAdvertisedEndpoints: function () {
      return invoke("v2_server_advertised_endpoints").catch(function () {
        return [];
      });
    },
    getWslState: function () {
      return invoke("v2_wsl_state")
        .then(function (state) {
          wslState = state;
          return state;
        })
        .catch(function () {
          return wslState;
        });
    },
    setWslBackendEnabled: function (enabled) {
      return invoke("v2_wsl_set_enabled", { enabled: !!enabled }).then(function (state) {
        wslState = state;
        return state;
      });
    },
    setWslDistro: function (distro) {
      return invoke("v2_wsl_set_distro", { distro: distro == null ? null : distro }).then(function (state) {
        wslState = state;
        return state;
      });
    },
    setWslOnly: function (enabled) {
      return invoke("v2_wsl_set_only", { enabled: !!enabled }).then(function (state) {
        wslState = state;
        return state;
      });
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
      return invoke("dialog_pick_theme_files")
        .then(function (files) {
          return files == null ? null : files;
        })
        .catch(function () {
          return null;
        });
    },
    setTheme: function (theme) {
      return invoke("window_set_theme", { theme: theme }).catch(noop);
    },
    showContextMenu: function (items, position) {
      ensureContextMenuListener();
      return new Promise(function (resolve) {
        var nonce = nextContextMenuNonce();
        var timer = setTimeout(function () {
          if (!contextMenuWaiters[nonce]) return;
          delete contextMenuWaiters[nonce];
          resolve(null);
        }, 120000);
        contextMenuWaiters[nonce] = { resolve: resolve, timer: timer };
        invoke("v2_show_context_menu", {
          nonce: nonce,
          items: items,
          position: position ? { x: position.x, y: position.y } : null,
        }).catch(function () {
          if (!contextMenuWaiters[nonce]) return;
          delete contextMenuWaiters[nonce];
          clearTimeout(timer);
          resolve(null);
        });
      });
    },
    receiveProviderAuthCallback: function (authorizationUrl) {
      return invoke("provider_auth_receive", { authorizationUrl: authorizationUrl });
    },
    cancelProviderAuthCallback: function (authorizationUrl) {
      return invoke("provider_auth_cancel", { authorizationUrl: authorizationUrl });
    },
    openExternal: function (url) {
      return invoke("shell_open_external", { url: url })
        .then(function (result) {
          return result !== false;
        })
        .catch(function () {
          return false;
        });
    },
    openSystemSettings: function (pane) {
      return invoke("v2_open_system_settings", { pane: pane }).catch(function () {
        return false;
      });
    },
    checkSystemPermission: function (pane) {
      return invoke("v2_check_system_permission", { pane: pane }).catch(function () {
        return false;
      });
    },
    probeRemoteEditors: function () {
      return invoke("v2_probe_remote_editors");
    },
    pasteAsText: noop,
    onMenuAction: function (listener) {
      return listen("v2-menu-action", listener);
    },
    onSnapShotEvent: function (listener) {
      return listen("v2-snap-shot-event", listener);
    },
    onQuitShortcut: noUnsubscribe,
    getWindowFullscreenState: function () {
      return fullscreen;
    },
    onWindowFullscreenStateChange: function (listener) {
      var unsubscribe = listen("v2-window-fullscreen", function (value) {
        var next = !!value;
        if (next === fullscreen) return;
        fullscreen = next;
        listener(next);
      });
      invoke("window_is_fullscreen")
        .then(function (value) {
          var next = !!value;
          if (next === fullscreen) return;
          fullscreen = next;
          listener(next);
        })
        .catch(noop);
      return unsubscribe;
    },
    getWindowZoomFactor: function () {
      // Rust writes this global before it resizes the webview, so the synchronous
      // read matches the viewport instead of trailing the resize event.
      var live = window.__HOUSTON_V2_ZOOM__;
      if (typeof live === "number" && isFinite(live) && live > 0) return live;
      return zoomFactor;
    },
    getUpdateState: function () {
      return invoke("v2_update_state")
        .then(function (state) {
          updateState = state;
          return state;
        })
        .catch(function () {
          return updateState;
        });
    },
    setUpdateChannel: function (channel, minimumVersion) {
      return invoke("v2_update_set_channel", {
        channel: channel === "nightly" ? "nightly" : "latest",
        minimumVersion: minimumVersion == null ? null : minimumVersion,
      }).then(function (state) {
        updateState = state;
        return state;
      });
    },
    checkForUpdate: function () {
      return invoke("v2_update_check").then(function (result) {
        if (result && result.state) updateState = result.state;
        return result;
      });
    },
    downloadUpdate: function () {
      return invoke("v2_update_download").then(function (result) {
        if (result && result.state) updateState = result.state;
        return result;
      });
    },
    installUpdate: function (expectedVersion) {
      return invoke("v2_update_install", {
        expectedVersion: expectedVersion == null ? null : expectedVersion,
      }).then(function (result) {
        if (result && result.state) updateState = result.state;
        return result;
      });
    },
    onUpdateState: function (listener) {
      return listen("v2-update://state", function (state) {
        updateState = state;
        listener(state);
      });
    },
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

  listen("v2-window-zoom", function (factor) {
    if (typeof factor === "number" && isFinite(factor) && factor > 0) zoomFactor = factor;
  });
  window.desktopBridge = bridge;
})();
