/**
 * `npm run info`: print the running host's address and pairing PIN.
 *
 * Asking reopens the host's 10-minute pairing window.
 *
 * Reads GET /api/pairing over 127.0.0.1, which the host answers only for
 * loopback requests with a loopback Host header, so the PIN never has to be
 * written to a log file (see WINDOCK_HIDE_PIN).
 */

import { resolve } from "node:path";
import { encodeQr, qrTerminalText } from "../src/qr.js";

export const DEFAULT_PORT = 8620;
export const NOT_RUNNING =
  "WinDock isn't running. Start it with npm start (or npm run mac:install to run at login).";

/** The port from PORT, falling back to the host's default. */
export function infoPort(env = process.env) {
  const port = Number(env.PORT);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

/** "open for N more minutes", rounded up; null when the window is unknown. */
export function pairingLine(pairingOpenForMs) {
  if (!Number.isFinite(pairingOpenForMs) || pairingOpenForMs <= 0) return null;
  const minutes = Math.ceil(pairingOpenForMs / 60_000);
  return `  Pairing: open for ${minutes} more ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * The info block shown by `npm run info` and `npm run mac:install`. A host with
 * TLS also reports its https address and the security code a phone shows
 * after pairing, so the two can be compared. Asking for this info reopens the
 * host's pairing window, which the Pairing line reports.
 */
export function formatInfo({ hostName, endpoint, pin, secureEndpoint = null, securityCode = null, pairingOpenForMs = null }) {
  const pairing = pairingLine(pairingOpenForMs);
  return [
    `WinDock is running on ${hostName || "this computer"}`,
    `  Address: ${endpoint || "(unknown)"}`,
    ...(secureEndpoint ? [`  Secure:  ${secureEndpoint}`] : []),
    `  PIN:     ${pin}`,
    ...(securityCode ? [`  Code:    ${securityCode}`] : []),
    ...(pairing ? [pairing] : []),
    "Enter this address and PIN in the WinDock app on your phone.",
    "",
  ].join("\n");
}

/**
 * Fetch pairing info from a local host.
 * @returns {Promise<{ok:true, info:object} | {ok:false, reason:"unreachable"|"refused", status?:number}>}
 */
export async function fetchPairing(port = DEFAULT_PORT, { timeoutMs = 3000, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/api/pairing`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  let info = null;
  try {
    info = await res.json();
  } catch {
    /* not a WinDock response */
  }
  if (res.status !== 200 || !info || typeof info.pin !== "string") {
    return { ok: false, reason: "refused", status: res.status };
  }
  return { ok: true, info };
}

/**
 * The pairing QR code as terminal text (half blocks), with a caption; empty
 * without a payload (pairing closed, TLS off, or an older host).
 */
export function formatQr(payload) {
  if (typeof payload !== "string" || !payload.startsWith("windock://pair?")) return "";
  try {
    return `${qrTerminalText(encodeQr(payload).modules)}Or scan this code with WinDock on your phone.\n`;
  } catch {
    return "";
  }
}

/** The QR payload from a local host's GET /api/host/pairing, or null. */
export async function fetchQrPayload(port = DEFAULT_PORT, { timeoutMs = 3000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/host/pairing`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return null;
    const body = await res.json();
    return body?.open && typeof body.qr?.text === "string" ? body.qr.text : null;
  } catch {
    return null;
  }
}

/** Text for a failed fetch. */
export function failureText(result, port) {
  if (result.reason === "unreachable") return `${NOT_RUNNING}\n`;
  return `Something answered on port ${port} but did not return WinDock pairing info (HTTP ${result.status}). `
    + "If it is an older WinDock host, restart it.\n";
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const port = infoPort();
  const result = await fetchPairing(port);
  if (result.ok) {
    process.stdout.write(formatInfo(result.info));
    // Asking above reopened pairing, so the QR (HTTPS hosts only) is current.
    process.stdout.write(formatQr(await fetchQrPayload(port)));
  } else {
    process.stderr.write(failureText(result, port));
    process.exit(1);
  }
}
