/**
 * Open the Spotify authorize URL in this computer's default browser.
 *
 * Only a URL the host built itself is ever opened (it must start with the
 * Spotify authorize endpoint), always as one argv entry, never through a
 * shell: macOS `/usr/bin/open`, Windows `rundll32 url.dll,FileProtocolHandler`,
 * elsewhere `xdg-open`.
 */

import { execFile } from "node:child_process";
import { SPOTIFY_AUTHORIZE_URL } from "./contract.js";

export const MAC_OPEN = "/usr/bin/open";

/** `[file, args]` for opening `url` on `os`. */
export function openCommand(url, { os = process.platform, env = process.env } = {}) {
  if (typeof url !== "string" || !url.startsWith(`${SPOTIFY_AUTHORIZE_URL}?`) || /\s/.test(url) || url.length > 4096) {
    throw new TypeError("refusing to open a URL the host did not build");
  }
  if (os === "darwin") return [MAC_OPEN, [url]];
  if (os === "win32") {
    const root = /^[A-Za-z]:\\[^"<>|?*]*$/.test(env.SystemRoot || "") ? env.SystemRoot : "C:\\Windows";
    return [`${root}\\System32\\rundll32.exe`, ["url.dll,FileProtocolHandler", url]];
  }
  return ["xdg-open", [url]];
}

/** The real opener; `run(file, args)` is injectable. */
export function createBrowserOpener({ os = process.platform, env = process.env, run } = {}) {
  const exec = run ?? ((file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { shell: false, windowsHide: true, timeout: 15_000 }, (err) => (err ? reject(err) : resolve()));
  }));
  return async (url) => {
    const [file, args] = openCommand(url, { os, env });
    await exec(file, args);
  };
}
