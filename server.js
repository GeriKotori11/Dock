/**
 * WinDock host.
 *
 * Serves the PWA, exposes the authenticated API, answers LAN discovery, and
 * broadcasts dock state over WebSocket. Platform work is delegated entirely to
 * the provider, so this file contains no OS-specific code.
 */

import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { hostname, networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createProvider } from "./src/platform/index.js";
import { validateControl, isDestructiveVerb, CONTROL_VERBS, featuresOf } from "./src/platform/contract.js";
import { createConfigStore, defaultDataDir } from "./src/config.js";
import { loadHostIdentity } from "./src/identity.js";
import { createSyncHub } from "./src/sync.js";
import { createInputHub } from "./src/input-hub.js";
import { validateSignature } from "./src/input.js";
import { createIconCache, FALLBACK_ICON } from "./src/icons.js";
import { startDiscovery, primaryAddress, DISCOVERY_PORT } from "./src/discovery.js";
import { startBonjour, buildTxt } from "./src/bonjour.js";
import { loadOrCreateTlsIdentity, createSharedPortListener, FIRST_BYTE_TIMEOUT_MS } from "./src/tls.js";
import { pairingQr } from "./src/qr.js";
import {
  newPin,
  isValidPinShape,
  createLockout,
  createPairing,
  createSessionStore,
  sessionCookie,
  tokenFromRequest,
  authorize,
  isTrustedLoopback,
  DEVICE_ID_RE,
} from "./src/auth.js";

export const DEFAULT_PORT = 8620;
export const BODY_MAX_BYTES = 64 * 1024;
/** Version of the host HTTP API advertised by /health. */
export const API_VERSION = 1;
const PUBLIC_DIR = resolve(import.meta.dirname, "public");
/** The host control page: served only to this computer, never to phones. */
const HOST_UI_DIR = resolve(import.meta.dirname, "host-ui");
/** The package version, reported by /api/host/status. */
export const HOST_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
})();
/** SSE comment heartbeat for /api/host/events. */
export const EVENTS_HEARTBEAT_MS = 15_000;
/** How often an open event stream re-checks status for changes nobody announced. */
export const EVENTS_CHECK_MS = 2_000;
/** How often start() re-reads the LAN address. */
export const ADDRESS_CHECK_MS = 5_000;

/**
 * Headers for the host page and every /api/host/* response (section 13.4 of
 * docs/design/HOST-CONTROL-PAGE.md): no framing, no caching, no referrer, no
 * cross-origin embedding.
 */
export const HOST_SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

/** Read a bounded JSON body. Oversized or malformed input is rejected. */
async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  // Reject immediately at the cap, but keep draining without retaining bytes.
  // Throwing inside an async iterator destroys/pauses the request socket and
  // can reset the response or the next request on a keep-alive connection.
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      if (size > BODY_MAX_BYTES) return;
      size += chunk.length;
      if (size > BODY_MAX_BYTES) {
        chunks.length = 0;
        const err = new Error("body too large");
        err.status = 413;
        reject(err);
      } else {
        chunks.push(chunk);
      }
    });
    req.once("end", resolve);
    req.once("error", reject);
  });
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    const err = new Error("invalid JSON body");
    err.status = 400;
    throw err;
  }
}

/** Same-origin guard for state-changing requests (CSRF defence). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // native client
  const host = req.headers.host;
  if (!host) return false;
  try {
    const scheme = req.socket.encrypted ? "https:" : "http:";
    return new URL(origin).origin === new URL(`${scheme}//${host}`).origin;
  } catch {
    return false;
  }
}

/**
 * Cross-site guard for local-only routes. A browser page on another site can
 * still make this computer's browser send a request to 127.0.0.1 (an <img>,
 * a form, a fetch), so a local-only route refuses any request a browser marks
 * as cross-site or same-site, and any request whose Origin is not its own.
 * Native clients (CLI, tray, shells) send neither header and pass.
 */
export function crossSiteBlocked(req) {
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return true;
  return req.headers.origin !== undefined && !sameOrigin(req);
}

/** True when the request body is declared as JSON (forces a CORS preflight cross-origin). */
export function isJsonRequest(req) {
  return String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() === "application/json";
}

/** Interface name to a coarse link kind for "Also reachable at"; null when unknown. */
export function interfaceKind(name) {
  if (/wi-?fi|wlan|wireless|airport|^wl/i.test(name)) return "wifi";
  if (/ethernet|^eth\d|^enp|^eno|^ens/i.test(name)) return "ethernet";
  return null;
}

/** The computer name as people see it: macOS's ".local" suffix dropped (as Bonjour does). */
export function displayHostName(name = hostname()) {
  return String(name).replace(/\.local\.?$/i, "").slice(0, 255);
}

/** Other LAN IPv4 addresses of this computer (not `primary`), for the status snapshot. */
export function otherAddresses(interfaces, primary) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const entry of list || []) {
      const family = entry.family === 4 || entry.family === "IPv4";
      if (!family || entry.internal || !isIPv4(entry.address || "") || entry.address === primary) continue;
      const [a, b] = entry.address.split(".").map(Number);
      const privateIp = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      if (!privateIp || out.some((o) => o.address === entry.address)) continue;
      out.push({ address: entry.address, interface: name, kind: interfaceKind(name) });
    }
  }
  return out.slice(0, 8);
}

/** Resolve a static path, refusing anything that escapes the public dir. */
export function resolveStatic(urlPath, root = PUBLIC_DIR) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const rel = normalize(clean).replace(/^([/\\])+/, "");
  if (rel.split(/[/\\]/).includes("..")) return null;
  const full = resolve(root, rel === "" ? "index.html" : rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export async function createApp({
  provider = createProvider(),
  configStore = createConfigStore(),
  pin = newPin(),
  // How each new code is made after a pairing or a spent failure budget, and
  // the clock for the pairing window; both injectable for tests and fixtures.
  nextPin = () => newPin(),
  now = Date.now,
  pairing = createPairing({ pin, nextPin, now }),
  sessions = createSessionStore(),
  lockout = createLockout(),
  allowDestructive = true,
  trustLoopback = true,
  identity = null,
  endpoint = null,
  secureEndpoint = null,
  tls = null,
  plainHttp = true,
  firstByteTimeoutMs = FIRST_BYTE_TIMEOUT_MS,
  // Which native shell spawned the host (WINDOCK_SHELL), null from a terminal.
  shell = null,
  interfaces = () => networkInterfaces(),
  eventsHeartbeatMs = EVENTS_HEARTBEAT_MS,
  eventsCheckMs = EVENTS_CHECK_MS,
} = {}) {
  // `endpoint` is the LAN URL the host advertises and `secureEndpoint` its
  // https form; start() fills them in once the listening port is known.
  // `tls` ({ key, cert, fingerprint, code }) adds HTTPS on the same port.
  if (!plainHttp && !tls) throw new TypeError("plainHttp: false needs tls");
  const state = {
    get pin() { return pairing.pin; },
    endpoint,
    secureEndpoint,
    // The advertised LAN IPv4 address; start() keeps it current. Undefined
    // means "derive it from `endpoint`".
    address: undefined,
  };
  // Discovery health for the status snapshot; start() fills it in.
  const discoveryState = { bonjour: "off", udp: "off" };
  const shellName = typeof shell === "string" && /^[a-z0-9-]{1,32}$/.test(shell) ? shell : null;
  const appIcon = createIconCache(provider);
  const features = featuresOf(provider);
  // Installed-app catalog, stale-while-revalidate. `catalog` holds the last
  // successful scan; `scanning` is the single in-flight scan, so concurrent
  // callers share it and scans never overlap. A failed scan keeps the old list.
  let catalog = null;
  let scanning = null;
  function scanCatalog() {
    if (!scanning) {
      scanning = Promise.resolve()
        .then(() => provider.listInstalledApps())
        .then((apps) => {
          catalog = { apps, ids: new Set(apps.map((app) => app.id)), time: Date.now() };
          return apps;
        })
        .finally(() => { scanning = null; });
    }
    return scanning;
  }
  async function installedApps() {
    if (!catalog) return scanCatalog();
    if (Date.now() - catalog.time > 60_000) scanCatalog().catch(() => {});
    return catalog.apps;
  }

  async function dockState() {
    // Never wait on a catalog scan here: kick one off (or a stale refresh) and
    // treat tiles as available until a successful scan says otherwise.
    installedApps().catch(() => {});
    const [config, running] = await Promise.all([
      configStore.load(),
      provider.listRunningApps().catch(() => []),
    ]);
    const runningIds = new Set(running.map((r) => r.id));
    return {
      platform: provider.id,
      platformName: provider.displayName,
      hostName: hostname(),
      features,
      tiles: config.tiles.map((tile) =>
        tile.kind === "app"
          ? { ...tile, running: runningIds.has(tile.id), available: catalog ? catalog.ids.has(tile.id) : true }
          : { ...tile, available: features.controls },
      ),
      running,
      verbs: features.controls ? CONTROL_VERBS : [],
      allowDestructive,
    };
  }

  // ---- host control page: status, pairing body, live events ----

  let devicesGeneration = 1;
  const events = new Set(); // open /api/host/events responses
  let emitQueued = false;
  let lastSignature = "";
  let timeoutTimer = null;
  let checkTimer = null;

  function endpointUrl() {
    try {
      return state.endpoint ? new URL(state.endpoint) : null;
    } catch {
      return null;
    }
  }
  function currentAddress() {
    if (state.address !== undefined) return state.address;
    const url = endpointUrl();
    return url && isIPv4(url.hostname) ? url.hostname : null;
  }
  function currentPort() {
    const fromUrl = Number(endpointUrl()?.port);
    if (Number.isInteger(fromUrl) && fromUrl > 0) return fromUrl;
    const bound = listener.address?.();
    return bound && typeof bound === "object" ? bound.port : null;
  }
  function connectedDeviceIds() {
    const ids = new Set();
    for (const hash of hub.connectedSessions()) {
      const id = sessions.idOf?.(hash);
      if (id) ids.add(id);
    }
    return ids;
  }
  function devicesWithPresence() {
    const connected = connectedDeviceIds();
    return sessions.list().map((d) => ({ ...d, label: d.label ?? null, connected: connected.has(d.id) }));
  }

  /** The status snapshot (section 13.2). Never carries the PIN. */
  function hostStatus() {
    const address = currentAddress();
    const port = currentPort();
    let others = [];
    try {
      others = otherAddresses(interfaces(), address);
    } catch {
      others = [];
    }
    const open = pairing.isOpen();
    let capture = null;
    try {
      capture = provider.capture ? { phase: provider.capture.status()?.phase ?? "idle" } : null;
    } catch {
      capture = null;
    }
    return {
      app: "windock",
      version: HOST_VERSION,
      hostId: identity?.hostId ?? null,
      hostName: displayHostName(),
      platform: provider.id,
      platformName: provider.displayName ?? null,
      shell: shellName,
      network: {
        address,
        port,
        endpoint: state.endpoint ?? null,
        secureEndpoint: tls ? state.secureEndpoint ?? null : null,
        others,
      },
      tls: tls ? { code: tls.code } : null,
      plainHttp,
      discovery: { ...discoveryState },
      firewall: "unknown",
      pairing: {
        open,
        remainingMs: pairing.remainingMs(),
        closedReason: pairing.closedReason,
        generation: pairing.generation,
      },
      devices: { count: sessions.size, generation: devicesGeneration },
      capture,
    };
  }

  /** GET /api/host/pairing: the PIN and QR while open, only the reason while closed. */
  function pairingBody() {
    if (!pairing.isOpen()) {
      return { open: false, closedReason: pairing.closedReason, generation: pairing.generation };
    }
    const address = currentAddress();
    const port = currentPort();
    let qr = null;
    // QR pairing pins the certificate fingerprint, so it needs TLS.
    if (tls && identity?.hostId && address && port) {
      try {
        const code = pairingQr({
          hostId: identity.hostId, address, port, fingerprint: tls.fingerprint, pin: pairing.pin, name: displayHostName(),
        });
        qr = { text: code.text, size: code.size, version: code.version, path: code.path };
      } catch {
        qr = null;
      }
    }
    return {
      open: true,
      pin: pairing.pin,
      securityCode: tls ? tls.code : null,
      address: address && port ? `${address}:${port}` : null,
      endpoint: state.endpoint ?? null,
      secureEndpoint: tls ? state.secureEndpoint ?? null : null,
      hostName: displayHostName(),
      remainingMs: pairing.remainingMs(),
      generation: pairing.generation,
      qr,
    };
  }

  function writeEvent(res, json) {
    try {
      res.write(`event: status\ndata: ${json}\n\n`);
    } catch {
      /* the close handler removes it */
    }
  }
  function signatureOf(status) {
    // Everything but the countdown, which changes every millisecond.
    return JSON.stringify({ ...status, pairing: { ...status.pairing, remainingMs: undefined } });
  }
  function emitStatus() {
    const status = hostStatus();
    lastSignature = signatureOf(status);
    const json = JSON.stringify(status);
    for (const res of events) writeEvent(res, json);
  }
  function scheduleTimeoutNotice() {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
    const left = pairing.remainingMs();
    if (left > 0) {
      timeoutTimer = setTimeout(changed, left + 25);
      timeoutTimer.unref?.();
    }
  }
  /** Something in the status snapshot changed: tell every open event stream (coalesced). */
  function changed() {
    scheduleTimeoutNotice();
    if (emitQueued) return;
    emitQueued = true;
    setImmediate(() => {
      emitQueued = false;
      if (events.size) emitStatus();
    });
  }
  function devicesChanged() {
    devicesGeneration += 1;
    changed();
  }
  scheduleTimeoutNotice();

  function openEvents(req, res) {
    res.writeHead(200, {
      ...HOST_SECURITY_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      // The socket closes with the stream, so a server shutdown never waits
      // on a keep-alive connection.
      connection: "close",
    });
    res.write("retry: 2000\n\n");
    events.add(res);
    const status = hostStatus();
    lastSignature = signatureOf(status);
    writeEvent(res, JSON.stringify(status));
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { /* closed */ }
    }, eventsHeartbeatMs);
    heartbeat.unref?.();
    if (!checkTimer) {
      // Catch changes nothing announces (capture phase, extra addresses).
      checkTimer = setInterval(() => {
        if (!events.size) return;
        const now = hostStatus();
        if (signatureOf(now) !== lastSignature) emitStatus();
      }, eventsCheckMs);
      checkTimer.unref?.();
    }
    const done = () => {
      clearInterval(heartbeat);
      events.delete(res);
      if (!events.size && checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
      }
    };
    req.on("close", done);
    res.on("close", done);
  }
  function endEvents() {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = null;
    for (const res of events) {
      try { res.end(); } catch { /* gone */ }
    }
    events.clear();
  }

  const hostJson = (res, status, body) => sendJson(res, status, body, HOST_SECURITY_HEADERS);

  /** /host and /host/*: the control page, for this computer only. */
  async function serveHostUi(req, res, path, local) {
    // Not advertised to anyone else: a LAN client sees a plain 404.
    if (!local) return sendJson(res, 404, { error: "not found" });
    if (crossSiteBlocked(req)) return hostJson(res, 403, { error: "cross-site request" });
    if (req.method !== "GET" && req.method !== "HEAD") return hostJson(res, 405, { error: "method not allowed" });
    const file = resolveStatic(path === "/host" ? "/" : path.slice("/host".length), HOST_UI_DIR);
    if (!file) return hostJson(res, 403, { error: "forbidden" });
    let body;
    try {
      body = await readFile(file);
    } catch {
      return hostJson(res, 404, { error: "not found" });
    }
    res.writeHead(200, {
      ...HOST_SECURITY_HEADERS,
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "content-length": body.length,
    });
    return res.end(req.method === "HEAD" ? undefined : body);
  }

  /** /api/host/*: status, events and the pairing window, for this computer only. */
  async function serveHostApi(req, res, path, local) {
    if (!local) return hostJson(res, 403, { error: "local only" });
    if (crossSiteBlocked(req)) return hostJson(res, 403, { error: "cross-site request" });
    const mutating = !["GET", "HEAD"].includes(req.method);
    if (mutating && !isJsonRequest(req)) {
      return hostJson(res, 415, { error: "content-type must be application/json" });
    }
    if (path === "/api/host/status" && req.method === "GET") return hostJson(res, 200, hostStatus());
    if (path === "/api/host/events" && req.method === "GET") return openEvents(req, res);
    if (path === "/api/host/pairing" && req.method === "GET") return hostJson(res, 200, pairingBody());
    if (path === "/api/host/pairing/open" && req.method === "POST") {
      await readJsonBody(req);
      // No network address: nothing to pair with; it reopens by itself.
      if (pairing.closedReason !== "no-address") {
        pairing.reopen();
        changed();
      }
      return hostJson(res, 200, pairingBody());
    }
    if (path === "/api/host/pairing/close" && req.method === "POST") {
      await readJsonBody(req);
      // Stop pairing: close now and rotate, so a photographed code is dead.
      pairing.close({ rotate: true, reason: "stopped" });
      changed();
      return hostJson(res, 200, pairingBody());
    }
    return hostJson(res, 404, { error: "not found" });
  }

  const handler = async (req, res) => {
    const remote = req.socket.remoteAddress || "";
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    try {
      if (path === "/health") {
        // Public and probed by the phone apps, which reject bodies over 4096
        // bytes. Identifiers only: never the PIN, tokens or paths.
        sendJson(res, 200, {
          ok: true,
          app: "windock",
          platform: provider.id,
          hostId: identity?.hostId ?? null,
          hostName: String(hostname()).slice(0, 255),
          api: API_VERSION,
          // A hint only, and over plain HTTP an unauthenticated one: a phone
          // must compare its pin with the certificate the TLS handshake
          // actually presented, never with this field.
          tls: tls ? { fingerprint: tls.fingerprint, code: tls.code } : null,
          // Not secret: lets the phone explain a "pairing closed" refusal.
          pairingOpen: pairing.isOpen(),
          // This host serves the control page at /host, so phones can name
          // "Pair a new phone" in their instructions.
          hostUi: true,
        });
        return;
      }

      if (path === "/api/auth" && req.method === "POST") {
        if (!sameOrigin(req)) return sendJson(res, 403, { error: "bad origin" });
        const status = lockout.status(remote);
        if (status.locked) {
          return sendJson(res, 429, { error: "locked", retryInMs: status.retryInMs });
        }
        const body = await readJsonBody(req);
        // A closed window refuses before the PIN is looked at, and counts as
        // nobody's failure: only a local GET /api/pairing reopens it.
        if (!pairing.isOpen()) return sendJson(res, 403, { error: "pairing closed" });
        if (!isValidPinShape(body.pin)) {
          lockout.recordFailure(remote);
          return sendJson(res, 400, { error: "invalid pin" });
        }
        if (!pairing.matches(body.pin)) {
          const fail = lockout.recordFailure(remote);
          // Wrong guesses from every client share one budget; spending it
          // rotates the code and closes the window.
          if (pairing.recordFailure().exhausted) changed();
          return sendJson(res, 401, { error: "wrong pin", locked: fail.locked });
        }
        lockout.recordSuccess(remote);
        pairing.recordSuccess(); // each code pairs exactly one device
        const token = sessions.issue({ name: body.deviceName });
        devicesChanged();
        return sendJson(res, 200, { ok: true }, {
          "set-cookie": sessionCookie(token, { secure: Boolean(req.socket.encrypted) }),
        });
      }

      const local = trustLoopback && isTrustedLoopback(req, remote);
      if (path === "/host" || path.startsWith("/host/")) return await serveHostUi(req, res, path, local);
      if (path.startsWith("/api/host/")) return await serveHostApi(req, res, path, local);

      if (!path.startsWith("/api/")) {
        const file = resolveStatic(path);
        if (!file) return sendJson(res, 403, { error: "forbidden" });
        try {
          const body = await readFile(file);
          res.writeHead(200, {
            "content-type": MIME[extname(file)] || "application/octet-stream",
            "content-length": body.length,
            "x-content-type-options": "nosniff",
          });
          return res.end(body);
        } catch {
          return sendJson(res, 404, { error: "not found" });
        }
      }

      if (path === "/api/session" && req.method === "DELETE") {
        // "Forget this computer" from a phone: revokes exactly the session the
        // cookie names. Loopback trust does not apply, since there is no
        // session to forget without a cookie.
        if (!sameOrigin(req)) return sendJson(res, 403, { error: "bad origin" });
        const status = lockout.status(remote);
        if (status.locked) return sendJson(res, 429, { error: "locked", retryInMs: status.retryInMs });
        const token = tokenFromRequest(req);
        if (!token) return sendJson(res, 400, { error: "no session" });
        const clear = { "set-cookie": sessionCookie("", { secure: Boolean(req.socket.encrypted), maxAgeMs: 0 }) };
        const hash = sessions.verify(token) ? sessions.revokeToken(token) : null;
        if (!hash) return sendJson(res, 401, { error: "unauthorized" }, clear);
        hub.disconnect(hash);
        inputHub.disconnect(hash);
        devicesChanged();
        return sendJson(res, 200, { ok: true }, clear);
      }

      const auth = authorize({ req, sessions, lockout, remote, trustLoopback });
      if (!auth.ok) {
        return sendJson(res, auth.code, { error: auth.via, retryInMs: auth.retryInMs });
      }

      if (path === "/api/pairing" && req.method === "GET") {
        // The PIN itself: only for software on this machine (`npm run info`),
        // never for a paired phone's session.
        if (auth.via !== "loopback") return sendJson(res, 403, { error: "local only" });
        // A web page elsewhere must not reopen pairing (and reset the
        // wrong-PIN budget) by pointing an <img> at this URL.
        if (crossSiteBlocked(req)) return sendJson(res, 403, { error: "cross-site request" });
        // Showing the PIN on this computer is what (re)opens pairing.
        pairing.reopen();
        changed();
        return sendJson(res, 200, {
          endpoint: state.endpoint ?? null,
          pin: state.pin,
          hostName: String(hostname()).slice(0, 255),
          hostId: identity?.hostId ?? null,
          secureEndpoint: tls ? state.secureEndpoint ?? null : null,
          securityCode: tls ? tls.code : null,
          pairingOpenForMs: pairing.remainingMs(),
        });
      }

      const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
      if (mutating && !sameOrigin(req)) return sendJson(res, 403, { error: "bad origin" });

      if (path === "/api/devices" || path.startsWith("/api/devices/")) {
        // Paired-device management: software on this machine only.
        if (auth.via !== "loopback") return sendJson(res, 403, { error: "local only" });
        if (crossSiteBlocked(req)) return sendJson(res, 403, { error: "cross-site request" });
        if (path === "/api/devices" && req.method === "GET") {
          return sendJson(res, 200, { devices: devicesWithPresence() });
        }
        if (path === "/api/devices" && req.method === "DELETE") {
          const revoked = sessions.revokeAll().length;
          hub.disconnectAll();
          inputHub.disconnectAll();
          devicesChanged();
          return sendJson(res, 200, { ok: true, revoked });
        }
        const id = path.slice("/api/devices/".length);
        if (req.method === "DELETE" && path.startsWith("/api/devices/")) {
          const hash = DEVICE_ID_RE.test(id) ? sessions.revoke(id) : null;
          if (!hash) return sendJson(res, 404, { error: "unknown device" });
          hub.disconnect(hash);
          inputHub.disconnect(hash);
          devicesChanged();
          return sendJson(res, 200, { ok: true, id });
        }
        if (req.method === "PATCH" && path.startsWith("/api/devices/")) {
          // A host-side label ("Rename…" on the control page); the phone
          // keeps sending its own name.
          if (!isJsonRequest(req)) return sendJson(res, 415, { error: "content-type must be application/json" });
          const body = await readJsonBody(req);
          if (!Object.hasOwn(body, "label") || (body.label !== null && typeof body.label !== "string")) {
            return sendJson(res, 400, { error: "label must be a string or null" });
          }
          const saved = DEVICE_ID_RE.test(id) ? sessions.setLabel(id, body.label) : null;
          if (!saved) return sendJson(res, 404, { error: "unknown device" });
          devicesChanged();
          return sendJson(res, 200, { ok: true, id, label: saved.label });
        }
        return sendJson(res, 404, { error: "not found" });
      }

      if (path === "/api/state" && req.method === "GET") {
        return sendJson(res, 200, await dockState());
      }

      if (path === "/api/apps/installed" && req.method === "GET") {
        return sendJson(res, 200, { apps: await installedApps() });
      }

      if (path === "/api/apps/icon" && req.method === "GET") {
        const app = (await installedApps()).find((item) => item.id === url.searchParams.get("id"));
        if (!app) return sendJson(res, 404, { error: "unknown app" });
        const png = await appIcon(app);
        const body = png || FALLBACK_ICON;
        res.writeHead(200, {
          "content-type": png ? "image/png" : "image/svg+xml",
          "content-length": body.length,
          "cache-control": png ? "private, max-age=3600" : "private, no-store",
          "x-content-type-options": "nosniff",
        });
        return res.end(body);
      }

      if (path === "/api/tiles" && req.method === "GET") {
        return sendJson(res, 200, await configStore.load());
      }

      if (path === "/api/tiles" && req.method === "PUT") {
        const body = await readJsonBody(req);
        const saved = await configStore.save({ tiles: body.tiles });
        await hub.broadcast();
        return sendJson(res, 200, saved);
      }

      if (path === "/api/apps/launch" && req.method === "POST") {
        const body = await readJsonBody(req);
        let app = (await installedApps()).find((a) => a.id === body.id);
        if (!app) {
          // Possibly installed since the last scan: rescan once before refusing.
          const fresh = await scanCatalog().catch(() => catalog?.apps || []);
          app = fresh.find((a) => a.id === body.id);
        }
        if (!app) return sendJson(res, 404, { error: "unknown app" });
        try {
          await provider.launchApp(app);
        } catch (err) {
          if (err?.status) throw err;
          // Native error text stays on the host.
          return sendJson(res, 502, { error: "launch failed" });
        }
        await hub.broadcast();
        return sendJson(res, 200, { ok: true, id: app.id });
      }

      if ((path === "/api/apps/focus" || path === "/api/apps/close") && req.method === "POST") {
        const body = await readJsonBody(req);
        const pid = Number(body.pid);
        if (!Number.isInteger(pid) || pid <= 0) {
          return sendJson(res, 400, { error: "pid must be a positive integer" });
        }
        const running = await provider.listRunningApps();
        const match = running.find((r) => r.pid === pid);
        if (!match) return sendJson(res, 404, { error: "process not running" });
        if (path.endsWith("focus")) await provider.focusApp(match);
        else await provider.closeApp(match);
        await hub.broadcast();
        return sendJson(res, 200, { ok: true, pid });
      }

      if (path === "/api/control" && req.method === "POST") {
        const body = await readJsonBody(req);
        const checked = validateControl(body.verb, body.value ?? null);
        if (!features.controls) return sendJson(res, 501, { error: "controls unavailable" });
        if (!checked.ok) return sendJson(res, 400, { error: checked.error });
        if (isDestructiveVerb(checked.verb) && !allowDestructive) {
          return sendJson(res, 403, { error: "power actions disabled" });
        }
        await provider.control(checked.verb, checked.value);
        return sendJson(res, 200, { ok: true, verb: checked.verb });
      }

      if (path === "/api/nowplaying" && req.method === "GET") {
        if (!features.nowPlaying) return sendJson(res, 200, { nowPlaying: null });
        return sendJson(res, 200, { nowPlaying: await provider.nowPlaying().catch(() => null) });
      }

      if (path === "/api/capture" && req.method === "GET") {
        return sendJson(res, 200, provider.capture?.status() || { available: false, phase: "idle" });
      }
      const captureActions = { "/api/capture/screenshot": "screenshot", "/api/capture/start": "start", "/api/capture/stop": "stop" };
      if (Object.hasOwn(captureActions, path) && req.method === "POST") {
        const body = await readJsonBody(req);
        if (Object.keys(body).length) return sendJson(res, 400, { error: "capture actions take no options" });
        if (!provider.capture) return sendJson(res, 501, { error: "Screen capture is available on Windows." });
        return sendJson(res, 200, await provider.capture[captureActions[path]]());
      }

      if (path === "/api/stats" && req.method === "GET") {
        return sendJson(res, 200, await provider.systemStats().catch(() => ({})));
      }

      if (path === "/api/input" && req.method === "GET") {
        return sendJson(res, 200, { available: Boolean(provider.input), keyboard: Boolean(provider.input), signatureInsert: Boolean(provider.input) });
      }
      if (["/api/signature", "/api/signature/insert"].includes(path) && req.method === "POST") {
        const signature = validateSignature(await readJsonBody(req));
        if (!provider.input) return sendJson(res, 501, { error: "Saving signatures needs the updated Windows host." });
        return sendJson(res, 200, await provider.input.saveSignature(signature, path.endsWith("/insert")));
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const status = err?.status || 500;
      sendJson(res, status, { error: status === 500 ? "internal error" : err.message });
    }
  };

  // `server` stays a plain http.Server so callers (and every existing test)
  // can listen on it directly. With TLS, `listener` owns the port and hands
  // each connection to `server` or `secureServer` by its first byte.
  const server = createServer(handler);
  const secureServer = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, handler) : null;
  const servers = secureServer ? [server, secureServer] : [server];
  const listener = secureServer
    ? createSharedPortListener({ server, secureServer, plainHttp, firstByteTimeoutMs })
    : server;

  const authorizeSocket = (req) =>
    authorize({ req, sessions, lockout, remote: req.socket.remoteAddress || "", trustLoopback });
  // Each socket remembers the session it was opened under, so revoking a
  // device closes its sockets at once.
  const sessionOf = (req) => authorizeSocket(req).hash ?? null;
  const hub = createSyncHub({
    servers,
    isAuthorized: (req) => authorizeSocket(req).ok,
    sessionOf,
    getState: dockState,
    onSessionsChange: devicesChanged,
  });

  const inputHub = createInputHub({ servers, input: provider.input, isAuthorized: (req) => authorizeSocket(req).ok, sessionOf });
  server.on("close", () => { provider.capture?.dispose().catch(() => {}); provider.input?.dispose(); });
  // Event streams never go idle, so closing a server ends them first;
  // otherwise close() would wait for them forever.
  for (const target of new Set([server, secureServer, listener].filter(Boolean))) {
    const close = target.close;
    target.close = function closeWithEvents(...args) {
      endEvents();
      return close.apply(this, args);
    };
  }
  return {
    server, secureServer, listener, tls, hub, inputHub, provider, configStore, dockState, state, pairing, sessions, lockout, identity,
    hostStatus, pairingBody, discoveryState, notifyChanged: changed, endEvents,
  };
}

/**
 * Transport switches from the environment. TLS is on unless WINDOCK_TLS=0;
 * plain HTTP stays on (for phone apps that predate TLS) unless
 * WINDOCK_PLAIN_HTTP=0, which is only valid with TLS on.
 */
export function transportOptions(env = process.env) {
  const tls = env.WINDOCK_TLS !== "0";
  const plainHttp = env.WINDOCK_PLAIN_HTTP !== "0";
  if (!tls && !plainHttp) throw new Error("WINDOCK_PLAIN_HTTP=0 needs TLS; remove WINDOCK_TLS=0");
  return { tls, plainHttp };
}

export async function start({
  port = Number(process.env.PORT) || DEFAULT_PORT,
  host = process.env.WINDOCK_HOST || "",
  env = process.env,
  discoveryPort = DISCOVERY_PORT,
  advertise = startBonjour,
} = {}) {
  const address = primaryAddress(undefined, host);
  const transport = transportOptions(env);
  // Sessions load synchronously when the store is built, so they are in place
  // before the server listens; host restarts keep paired devices paired.
  const dataDir = defaultDataDir({ env });
  const sessions = createSessionStore({ path: join(dataDir, "sessions.json") });
  const identity = await loadHostIdentity({ path: join(dataDir, "host.json") });
  const tls = transport.tls
    ? await loadOrCreateTlsIdentity({ dir: dataDir, commonName: `WinDock ${identity.hostId}` })
    : null;
  const app = await createApp({ sessions, identity, tls, plainHttp: transport.plainHttp, shell: env.WINDOCK_SHELL || null });
  await new Promise((resolve, reject) => {
    app.listener.once("error", reject);
    app.listener.listen(port, () => { app.listener.off("error", reject); resolve(); });
  });

  port = app.listener.address().port;
  const base = address || "localhost";
  const secureEndpoint = tls ? `https://${base}:${port}` : null;
  // Discovery and `open:` keep the http URL: phone apps that predate TLS
  // parse it and could not verify an https certificate. Only with plain HTTP
  // switched off is the https URL advertised instead.
  const endpoint = transport.plainHttp ? `http://${base}:${port}` : secureEndpoint;
  app.state.endpoint = endpoint;
  app.state.secureEndpoint = secureEndpoint;
  app.state.address = address;
  // Without a LAN address no phone can reach the host: pairing stays closed
  // ("no-address") until one appears.
  if (!address) app.pairing.close({ reason: "no-address" });
  app.discoveryState.udp = "on";
  const discovery = startDiscovery({
    endpoint: () => app.state.endpoint,
    port: discoveryPort,
    onError: () => { app.discoveryState.udp = "failed"; app.notifyChanged(); },
  });
  // Bonjour `_windock._tcp` for phones that cannot broadcast (iPhones). The
  // TXT record is only a hint; phones still verify /health and the pin.
  app.discoveryState.bonjour = env.WINDOCK_BONJOUR === "0" ? "off" : "on";
  const bonjour = env.WINDOCK_BONJOUR === "0"
    ? { kind: "none", stop: async () => {} }
    : advertise({
      name: hostname(),
      port,
      txt: buildTxt({ hostId: identity.hostId, tls: Boolean(tls), address, hostName: hostname() }),
      // Every line the advertiser logs reports that advertising is off.
      log: (line) => {
        process.stderr.write(`WinDock bonjour: ${line}\n`);
        app.discoveryState.bonjour = "failed";
        app.notifyChanged();
      },
    });
  if (env.WINDOCK_BONJOUR !== "0" && bonjour.kind === "none") app.discoveryState.bonjour = "failed";

  // Follow the LAN address: the status, the advertised endpoint, the UDP
  // reply and the QR code all use the current one.
  let current = address;
  const addressTimer = setInterval(() => {
    let next = null;
    try {
      next = primaryAddress(undefined, host);
    } catch {
      next = null; // WINDOCK_HOST no longer assigned
    }
    if (next === current) return;
    current = next;
    const nextBase = next || "localhost";
    app.state.address = next;
    app.state.secureEndpoint = tls ? `https://${nextBase}:${port}` : null;
    app.state.endpoint = transport.plainHttp ? `http://${nextBase}:${port}` : app.state.secureEndpoint;
    if (!next) {
      if (app.pairing.isOpen()) app.pairing.close({ reason: "no-address" });
      else app.pairing.touch();
    } else if (app.pairing.closedReason === "no-address") {
      app.pairing.reopen();
    } else {
      app.pairing.touch();
    }
    app.notifyChanged();
  }, ADDRESS_CHECK_MS);
  addressTimer.unref?.();
  app.listener.once("close", () => { clearInterval(addressTimer); bonjour.stop().catch(() => {}); });
  return { ...app, endpoint, secureEndpoint, discovery, bonjour, port };
}

/**
 * The startup banner. The Windows tray parses `open:\s*(\S+)` and
 * `PIN:\s*(\d{4,8})` from it, so the default form must not change. With
 * `hidePin` (WINDOCK_HIDE_PIN=1, set by the macOS LaunchAgent) the PIN stays
 * out of stdout and therefore out of any log file. With TLS on, one
 * `secure:` line is appended after the unchanged lines.
 */
export function readyBanner({ providerName, endpoint, pin, hidePin = false, secureEndpoint = null, securityCode = null }) {
  const pinText = hidePin ? '(run "npm run info" to show it)' : pin;
  const lines = `WinDock host ready\n  provider: ${providerName}\n  open:     ${endpoint}\n  PIN:      ${pinText}\n`;
  // The security code is not secret: it is how a person checks a phone's pin.
  return secureEndpoint ? `${lines}  secure:   ${secureEndpoint}  code ${securityCode}\n` : lines;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  start()
    .then(({ endpoint, secureEndpoint, tls, state, provider }) => {
      process.stdout.write(readyBanner({
        providerName: provider.displayName,
        endpoint,
        pin: state.pin,
        hidePin: process.env.WINDOCK_HIDE_PIN === "1",
        secureEndpoint,
        securityCode: tls?.code ?? null,
      }));
    })
    .catch((err) => {
      process.stderr.write(`WinDock failed to start: ${err.message}\n`);
      process.exit(1);
    });
}
