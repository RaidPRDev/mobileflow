declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  }
}

export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

export function platformLabel(): "Desktop" | "Web" {
  return isTauri() ? "Desktop" : "Web";
}
