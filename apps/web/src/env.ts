// The host installs hostBridge before web code runs, so module-load detection is reliable.
export const isDesktopHost = typeof window !== "undefined" && window.hostBridge !== undefined;
