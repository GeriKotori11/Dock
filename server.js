/**
 * WinDock host.
 *
 * Serves the PWA, exposes the authenticated API, answers LAN discovery, and
 * broadcasts dock state over WebSocket. Platform work is delegated entirely to
 * the provider, so this file contains no OS-specific code.
 */

import { createServer } from "node:http";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
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
import {
  newPin,
  isValidPinShape,
  safeEqual,
  createLockout,
  createSessionStore,
  sessionCookie,
  authorize,
} from "./src/auth.js";

export const DEFAULT_PORT = 8620;
export const BODY_MAX_BYTES = 64 * 1024;
/** Version of the host HTTP API advertised by /health. */
export const API_VERSION = 1;
const PUBLIC_DIR = resolve(import.meta.dirname, "public");

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
  sessions = createSessionStore(),
  lockout = createLockout(),
  allowDestructive = true,
  trustLoopback = true,
  identity = null,
} = {}) {
  const state = { pin };
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

  const server = createServer(async (req, res) => {
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
        if (!isValidPinShape(body.pin)) {
          lockout.recordFailure(remote);
          return sendJson(res, 400, { error: "invalid pin" });
        }
        if (!safeEqual(body.pin, state.pin)) {
          const fail = lockout.recordFailure(remote);
          return sendJson(res, 401, { error: "wrong pin", locked: fail.locked });
        }
        lockout.recordSuccess(remote);
        const token = sessions.issue();
        return sendJson(res, 200, { ok: true }, {
          "set-cookie": sessionCookie(token, { secure: Boolean(req.socket.encrypted) }),
        });
      }

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

      const auth = authorize({ req, sessions, lockout, remote, trustLoopback });
      if (!auth.ok) {
        return sendJson(res, auth.code, { error: auth.via, retryInMs: auth.retryInMs });
      }

      const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
      if (mutating && !sameOrigin(req)) return sendJson(res, 403, { error: "bad origin" });

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
  });

  const hub = createSyncHub({
    server,
    isAuthorized: (req) =>
      authorize({
        req,
        sessions,
        lockout,
        remote: req.socket.remoteAddress || "",
        trustLoopback,
      }).ok,
    getState: dockState,
  });

  const inputHub = createInputHub({ server, input: provider.input, isAuthorized: (req) =>
    authorize({ req, sessions, lockout, remote: req.socket.remoteAddress || "", trustLoopback }).ok,
  });
  server.on("close", () => { provider.capture?.dispose().catch(() => {}); provider.input?.dispose(); });
  return { server, hub, inputHub, provider, configStore, dockState, state, sessions, lockout, identity };
}

export async function start({ port = Number(process.env.PORT) || DEFAULT_PORT, host = process.env.WINDOCK_HOST || "" } = {}) {
  const address = primaryAddress(undefined, host);
  // Sessions load synchronously when the store is built, so they are in place
  // before the server listens; host restarts keep paired devices paired.
  const dataDir = defaultDataDir();
  const sessions = createSessionStore({ path: join(dataDir, "sessions.json") });
  const identity = await loadHostIdentity({ path: join(dataDir, "host.json") });
  const app = await createApp({ sessions, identity });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, () => { app.server.off("error", reject); resolve(); });
  });

  port = app.server.address().port;
  const endpoint = address ? `http://${address}:${port}` : `http://localhost:${port}`;
  const discovery = startDiscovery({ endpoint, port: DISCOVERY_PORT });
  return { ...app, endpoint, discovery, port };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  start()
    .then(({ endpoint, state, provider }) => {
      process.stdout.write(
        `WinDock host ready\n  provider: ${provider.displayName}\n  open:     ${endpoint}\n  PIN:      ${state.pin}\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(`WinDock failed to start: ${err.message}\n`);
      process.exit(1);
    });
}
