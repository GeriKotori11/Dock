/**
 * `npm run devices`: list and revoke the phones paired with the running host.
 *
 *   npm run devices                    list paired devices
 *   npm run devices -- revoke <id>     revoke one (full id or a unique prefix)
 *   npm run devices -- revoke-all      revoke every paired device
 *
 * Talks to /api/devices over 127.0.0.1, which the host answers only for
 * loopback requests with a loopback Host header (never for a phone session).
 * A revoked phone is disconnected at once and must pair again with a new PIN.
 */

import { resolve } from "node:path";
import { infoPort, NOT_RUNNING } from "./windock-info.mjs";

export const SHORT_ID_LENGTH = 8;
const MIN_PREFIX = 4;

/** Local "YYYY-MM-DD HH:MM", or "unknown". */
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The device list as printed by `npm run devices`. */
export function formatDevices(devices) {
  if (!devices.length) return "No paired devices.\n";
  const width = Math.max(4, ...devices.map((d) => [...d.name].length));
  const lines = [`${devices.length} paired ${devices.length === 1 ? "device" : "devices"} (newest first)`];
  for (const d of devices) {
    const name = d.name + " ".repeat(width - [...d.name].length);
    lines.push(`  ${name}  ${d.id.slice(0, SHORT_ID_LENGTH)}  paired ${formatTime(d.issuedAt)}  last seen ${formatTime(d.lastSeenAt)}`);
  }
  lines.push('Revoke one with: npm run devices -- revoke <id>');
  return `${lines.join("\n")}\n`;
}

/**
 * Match a typed id (full, or a prefix of at least four characters) against the
 * listed devices. @returns {{ok:true, device:object} | {ok:false, reason:"none"|"ambiguous"|"short"}}
 */
export function resolveDevice(devices, typed) {
  const wanted = String(typed ?? "").trim().toLowerCase();
  if (wanted.length < MIN_PREFIX) return { ok: false, reason: "short" };
  const exact = devices.find((d) => d.id === wanted);
  if (exact) return { ok: true, device: exact };
  const matches = devices.filter((d) => d.id.startsWith(wanted));
  if (matches.length === 1) return { ok: true, device: matches[0] };
  return { ok: false, reason: matches.length ? "ambiguous" : "none" };
}

/**
 * One request to the local host's device API.
 * @returns {Promise<{ok:true, status:number, json:object} | {ok:false, reason:"unreachable"|"refused", status?:number}>}
 */
export async function deviceRequest(port, path = "", { method = "GET", timeoutMs = 3000, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/api/devices${path}`, { method, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not a WinDock response */
  }
  if (!json || typeof json !== "object") return { ok: false, reason: "refused", status: res.status };
  return { ok: true, status: res.status, json };
}

function refusedText(result, port) {
  if (result.reason === "unreachable") return `${NOT_RUNNING}\n`;
  return `Something answered on port ${port} but did not return WinDock device info (HTTP ${result.status}). `
    + "If it is an older WinDock host, restart it.\n";
}

/** Run one command; returns { code, out, err }. */
export async function run(args, port, options = {}) {
  const [command, id] = args;
  const list = await deviceRequest(port, "", options);
  if (!list.ok) return { code: 1, out: "", err: refusedText(list, port) };
  if (list.status !== 200 || !Array.isArray(list.json.devices)) {
    return { code: 1, out: "", err: refusedText({ reason: "refused", status: list.status }, port) };
  }
  const devices = list.json.devices;

  if (!command) return { code: 0, out: formatDevices(devices), err: "" };

  if (command === "revoke-all") {
    const done = await deviceRequest(port, "", { ...options, method: "DELETE" });
    if (!done.ok || done.status !== 200) return { code: 1, out: "", err: refusedText(done.ok ? { reason: "refused", status: done.status } : done, port) };
    const n = done.json.revoked ?? devices.length;
    return { code: 0, out: `Revoked ${n} paired ${n === 1 ? "device" : "devices"}. They must pair again with a new PIN.\n`, err: "" };
  }

  if (command === "revoke") {
    const found = resolveDevice(devices, id);
    if (!found.ok) {
      const why = {
        short: "Give the device id shown by npm run devices (at least four characters).",
        none: `No paired device matches "${id}".`,
        ambiguous: `More than one paired device starts with "${id}". Type more of the id.`,
      }[found.reason];
      return { code: 1, out: "", err: `${why}\n` };
    }
    const { device } = found;
    const done = await deviceRequest(port, `/${device.id}`, { ...options, method: "DELETE" });
    if (done.ok && done.status === 404) return { code: 1, out: "", err: `No paired device matches "${id}".\n` };
    if (!done.ok || done.status !== 200) return { code: 1, out: "", err: refusedText(done.ok ? { reason: "refused", status: done.status } : done, port) };
    return { code: 0, out: `Revoked ${device.name} (${device.id.slice(0, SHORT_ID_LENGTH)}). It must pair again with a new PIN.\n`, err: "" };
  }

  return {
    code: 1,
    out: "",
    err: "Usage: npm run devices [-- revoke <id> | -- revoke-all]\n",
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const result = await run(process.argv.slice(2), infoPort());
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exitCode = result.code;
}
