// Bridge to the iOS and Android shells (design spec section 11).
//
// Natives inject `window.WinDockNative = { platform, switcher, computerName }`
// at document start, possibly after this module loads, so it is read at use
// time and never cached. Only three fields are trusted, each validated; the
// object is never evaluated or rendered unescaped.
import { escapeHtml } from "./dock.js";
import { icon } from "./icons.js";

export const COMPUTER_NAME_MAX = 60;
const PLATFORMS = new Set(["ios", "android"]);
// Android bridge method for each message type.
const ANDROID_METHODS = { switch: "switchComputer", ready: "ready", unauthorized: "unauthorized" };

/** The validated native capabilities, or null in a browser. */
export function readNative(win = globalThis) {
  let raw;
  try { raw = win?.WinDockNative; } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  let platform, switcher, name;
  try { ({ platform, switcher, computerName: name } = raw); } catch { return null; }
  if (typeof platform !== "string" || !PLATFORMS.has(platform)) return null;
  const computerName = typeof name === "string" && name.trim() && name.length <= COMPUTER_NAME_MAX ? name.trim() : null;
  return { platform, switcher: switcher === true, computerName };
}

/** The phone's nickname for the computer when native gives one, else the host's name. */
export function displayName(native, hostName, fallback) {
  return native?.computerName || hostName || fallback;
}

/** Whether the native switcher row replaces the plain drawer connection row. */
export function wantsSwitcher(native) {
  return native?.switcher === true;
}

/** A 401 inside a native shell goes to native instead of the web PIN page. */
export function shouldHandOff(native, unauthorized) {
  return Boolean(native && unauthorized);
}

/**
 * Deliver `{ type }` (switch, ready or unauthorized) to whichever native bridge
 * exists: iOS `webkit.messageHandlers.windock`, Android `WinDockAndroid`.
 * Returns true when a bridge took it.
 */
export function postToNative(win, message) {
  const method = ANDROID_METHODS[message?.type];
  if (!method) return false;
  let delivered = false;
  try {
    const ios = win?.webkit?.messageHandlers?.windock;
    if (ios && typeof ios.postMessage === "function") { ios.postMessage(message); delivered = true; }
  } catch { /* A broken bridge must not break the dock. */ }
  try {
    const android = win?.WinDockAndroid;
    if (android && typeof android[method] === "function") { android[method](); delivered = true; }
  } catch { /* As above. */ }
  return delivered;
}

/** The drawer's switch-computer button (spec 5.12); keeps the #drawer-host and #drawer-conn ids. */
export function renderSwitchRow({ name, connState = "off", connText = "Connecting" }) {
  return '<button id="drawer-switch" class="drawer-switch" type="button" aria-haspopup="dialog">'
    + '<span class="drawer-switch__icon">' + icon("monitor") + "</span>"
    + '<span id="drawer-host" class="drawer-switch__name">' + escapeHtml(name) + "</span>"
    + '<span id="drawer-conn" data-state="' + (connState === "on" ? "on" : "off") + '">' + escapeHtml(connText) + "</span>"
    + '<span class="drawer-switch__divider" aria-hidden="true"></span>'
    + '<span class="drawer-switch__action">Switch' + icon("chevron") + "</span>"
    + "</button>";
}
