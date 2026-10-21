/** G9: the HTTP API serves its documented routes under a live server. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, Agent } from "node:http";
import { createChecker } from "./lib/assert.mjs";
import { WebSocket } from "ws";
import { createApp, readyBanner } from "../server.js";
import { createWindowsProvider } from "../src/platform/windows.js";
import { createConfigStore } from "../src/config.js";
import { createSessionStore, createLockout, hashToken, LOCK_MS, PAIRING_WINDOW_MS, LAST_SEEN_INTERVAL_MS } from "../src/auth.js";
import { writeFile } from "node:fs/promises";
import { formatInfo, NOT_RUNNING } from "./windock-info.mjs";
import { run as runDevices, formatDevices, resolveDevice } from "./windock-devices.mjs";
import { loadHostIdentity } from "../src/identity.js";
import { featuresOf, CONTROL_VERBS } from "../src/platform/contract.js";

const t = createChecker("api");
const PIN = "432100";

const INSTALLED = JSON.stringify([
  { name: "Firefox", target: "C:\\Apps\\firefox.exe", args: "", icon: "", source: "startmenu" },
  { name: "Notepad", target: "C:\\Windows\\notepad.exe", args: "", icon: "", source: "startmenu" },
]);
const RUNNING = JSON.stringify([
  { Id: 4812, ProcessName: "firefox", MainWindowTitle: "FF", Handle: 12, Path: "C:\\Apps\\firefox.exe" },
]);

const helperCalls = [];
const provider = createWindowsProvider({
  helperPath: "H.exe",
  exec: async (file, args) => {
    if (file === "H.exe") {
      helperCalls.push(args);
      if (args[0] === "control" && args[1] === "brightness-set") throw new Error("unsupported monitor; private native diagnostics");
      if (args[0] === "nowplaying") return { stdout: '{"title":"Track","artist":"Band","playing":true}' };
      return { stdout: "" };
    }
    const script = args[args.length - 1];
    if (script.includes("MainWindowHandle")) return { stdout: RUNNING };
    if (script.includes("WScript.Shell")) return { stdout: INSTALLED };
    return { stdout: '{"cpu":10,"memTotal":100,"memFree":40,"battery":null,"charging":null}' };
  },
});

const dir = await mkdtemp(join(tmpdir(), "windock-api-"));
const configStore = createConfigStore({ path: join(dir, "config.json") });
// Loopback trust would short-circuit every auth check, since these requests
// originate from 127.0.0.1. Disabling it makes the entire suite below exercise
// the real pairing + session path; loopback trust itself is verified separately
// at the end of this file.
const app = await createApp({ provider, configStore, pin: PIN, trustLoopback: false });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;

let cookie = "";
async function call(path, { method = "GET", body, origin = base, withCookie = true } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (origin) headers.origin = origin;
  if (withCookie && cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON response (static asset) */
  }
  return { status: res.status, json, text, headers: res.headers };
}

// ---- public routes ----
const health = await call("/health");
t.equal(health.status, 200, "GET /health is public and returns 200");
t.equal(health.json.ok, true, "health reports ok");
t.equal(health.json.platform, "windows", "health names the active provider");
t.equal(health.json.app, "windock", "health still identifies the app");
t.equal(health.json.hostId, null, "health reports a null hostId when the app has no identity");
t.ok(typeof health.json.hostName === "string" && health.json.hostName.length > 0, "health names the host");
t.equal(health.json.api, 1, "health advertises API version 1");
t.ok(Buffer.byteLength(health.text) <= 4096, `the health body fits the 4096-byte probe limit (${Buffer.byteLength(health.text)} bytes)`);
t.ok(!health.text.includes(PIN), "health never includes the PIN");
t.deepEqual(Object.keys(health.json).sort(), ["api", "app", "hostId", "hostName", "hostUi", "ok", "pairingOpen", "platform", "tls"],
  "health exposes only its documented fields");
t.equal(health.json.hostUi, true, "health says this host serves the control page (hostUi)");
t.equal(health.json.tls, null, "health reports tls: null without TLS");
t.equal(health.json.pairingOpen, true, "health reports pairing open after the host starts");

// ---- static ----
const index = await call("/");
t.equal(index.status, 200, "GET / serves the PWA shell");
t.ok(index.text.includes("<title>WinDock</title>"), "the shell carries the app title");
t.equal(index.headers.get("x-content-type-options"), "nosniff", "static responses set nosniff");
const manifest = await call("/manifest.webmanifest");
t.equal(manifest.status, 200, "the manifest is served");
t.ok(manifest.headers.get("content-type").includes("manifest+json"), "manifest content type is correct");
t.equal((await call("/does-not-exist.js")).status, 404, "a missing asset returns 404");
t.equal((await call("/../server.js")).status, 404, "traversal above public is refused");

// ---- pairing ----
t.equal((await call("/api/auth", { method: "POST", body: { pin: "000000" } })).status, 401, "a wrong pin is refused");
t.equal((await call("/api/auth", { method: "POST", body: { pin: "12" } })).status, 400, "a malformed pin is refused");
const fourDigits = await call("/api/auth", { method: "POST", body: { pin: "4321" } });
t.equal(fourDigits.status, 400, "a four-digit pin is malformed now that codes have six digits");
t.equal(fourDigits.json.error, "invalid pin", "a four-digit pin is reported as invalid pin");
t.equal(
  (await call("/api/auth", { method: "POST", body: { pin: PIN }, origin: "http://evil.test" })).status,
  403,
  "a cross-origin pairing attempt is refused",
);
const paired = await call("/api/auth", { method: "POST", body: { pin: PIN } });
t.equal(paired.status, 200, "the correct pin pairs successfully");
t.ok(cookie.startsWith("windock_session="), "pairing issues a session cookie");

// ---- authenticated routes ----
const state = await call("/api/state");
t.equal(state.status, 200, "GET /api/state succeeds when paired");
t.equal(state.json.platform, "windows", "state names the provider");
t.ok(Array.isArray(state.json.tiles), "state carries a tiles array");
t.ok(Array.isArray(state.json.running), "state carries a running array");
t.ok(Array.isArray(state.json.verbs), "state advertises the control verbs");
t.deepEqual({ ...state.json.features, close: undefined, media: undefined, volume: undefined, power: undefined, spotify: undefined },
  { controls: true, nowPlaying: true, capture: true, input: true },
  "the Windows provider keeps every legacy feature (dock-controls keys: verify-dock-controls)");
t.equal(state.json.verbs.length, CONTROL_VERBS.length, "the Windows provider advertises every control verb");

const installed = await call("/api/apps/installed");
t.equal(installed.status, 200, "GET /api/apps/installed succeeds");
t.equal(installed.json.apps.length, 2, "the installed inventory is returned");

// ---- tiles ----
const put = await call("/api/tiles", {
  method: "PUT",
  body: {
    tiles: [
      { kind: "app", id: "c:/apps/firefox.exe", target: "C:\\Apps\\firefox.exe", label: "Firefox" },
      { kind: "control", verb: "mute-toggle", label: "Mute" },
      { kind: "control", verb: "hack; rm -rf /", label: "Bad" },
    ],
  },
});
t.equal(put.status, 200, "PUT /api/tiles succeeds");
t.equal(put.json.tiles.length, 2, "the hostile tile is dropped on save");
t.ok(put.json.tiles.every((x) => x.verb !== "hack; rm -rf /"), "no hostile verb is persisted");

const after = await call("/api/state");
const ffTile = after.json.tiles.find((x) => x.kind === "app");
t.equal(ffTile.running, true, "a pinned app with a live process is marked running");
t.equal(ffTile.available, true, "a pinned app in the catalog is available");
t.equal(after.json.tiles.find((x) => x.kind === "control").available, true, "control tiles are available on Windows");

// ---- empty slots (spacers) round-trip through save, state and the snapshot ----
const FIREFOX_TILE = { kind: "app", id: "c:/apps/firefox.exe", target: "C:\\Apps\\firefox.exe", label: "Firefox" };
const MUTE_TILE = { kind: "control", verb: "mute-toggle", label: "Mute" };
const gapped = await call("/api/tiles", { method: "PUT", body: { tiles: [
  { kind: "spacer", label: "junk", id: "x", running: true },
  FIREFOX_TILE, { kind: "spacer" }, { kind: "spacer" }, MUTE_TILE, { kind: "spacer" }, { kind: "spacer" },
] } });
const GAPPED_KINDS = ["spacer", "app", "spacer", "spacer", "control"];
t.equal(gapped.status, 200, "PUT /api/tiles accepts empty slots");
t.deepEqual(gapped.json.tiles.map((x) => x.kind), GAPPED_KINDS, "gaps keep their places and trailing ones are trimmed on save");
t.deepEqual(gapped.json.tiles[0], { kind: "spacer" }, "an empty slot persists as its kind only (no label, id or live state)");
const gappedState = await call("/api/state");
t.deepEqual(gappedState.json.tiles.map((x) => x.kind), GAPPED_KINDS, "GET /api/state carries the gaps in order");
t.deepEqual(gappedState.json.tiles[2], { kind: "spacer" }, "state sends an empty slot with no running or availability flags");
t.equal(gappedState.json.tiles[1].running, true, "a real tile beside a gap keeps its live running state");
const gappedSnapshot = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { cookie, origin: base } });
  const timer = setTimeout(() => { ws.terminate(); reject(new Error("no snapshot")); }, 3000);
  ws.on("message", (d) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(String(d))); });
  ws.on("error", (e) => { clearTimeout(timer); reject(e); });
});
t.deepEqual(gappedSnapshot.tiles.map((x) => x.kind), GAPPED_KINDS, "the WebSocket snapshot carries the gaps in order");
t.deepEqual(gappedSnapshot.tiles[3], { kind: "spacer" }, "the snapshot's empty slot carries nothing else");
const onlyGaps = await call("/api/tiles", { method: "PUT", body: { tiles: [{ kind: "spacer" }, { kind: "spacer" }] } });
t.deepEqual(onlyGaps.json.tiles, [], "a dock of only empty slots saves as an empty dock");
t.equal((await call("/api/tiles", { method: "PUT", body: { tiles: [FIREFOX_TILE, MUTE_TILE] } })).json.tiles.length, 2, "the plain dock is restored");

// ---- actions ----
const launch = await call("/api/apps/launch", { method: "POST", body: { id: "c:/windows/notepad.exe" } });
t.equal(launch.status, 200, "POST /api/apps/launch succeeds for a known app");
t.deepEqual(helperCalls.at(-1), ["launch", "C:\\Windows\\notepad.exe"], "launch reaches the helper with exact argv");
t.equal((await call("/api/apps/launch", { method: "POST", body: { id: "c:/nope.exe" } })).status, 404,
  "launching an unknown app returns 404");

const focus = await call("/api/apps/focus", { method: "POST", body: { pid: 4812 } });
t.equal(focus.status, 200, "POST /api/apps/focus succeeds for a live pid");
t.deepEqual(helperCalls.at(-1), ["focus", "4812"], "focus reaches the helper with exact argv");
t.equal((await call("/api/apps/focus", { method: "POST", body: { pid: 999999 } })).status, 404,
  "focusing a dead pid returns 404");
t.equal((await call("/api/apps/focus", { method: "POST", body: { pid: -1 } })).status, 400,
  "a negative pid is rejected");
t.equal((await call("/api/apps/focus", { method: "POST", body: { pid: "4812; id" } })).status, 400,
  "a non-numeric pid is rejected");

const control = await call("/api/control", { method: "POST", body: { verb: "volume-set", value: 30 } });
t.equal(control.status, 200, "POST /api/control succeeds for a valid verb");
t.deepEqual(helperCalls.at(-1), ["control", "volume-set", "30"], "control reaches the helper with exact argv");
const brightnessFailure = await call("/api/control", { method: "POST", body: { verb: "brightness-set", value: 50 } });
t.equal(brightnessFailure.status, 503, "unsupported brightness reaches the phone as an actionable failure");
t.ok(brightnessFailure.json.error.includes("DDC/CI"), "brightness API response explains the monitor setting");
t.ok(!brightnessFailure.json.error.includes("private native"), "brightness API response does not disclose native diagnostics");
t.equal((await call("/api/control", { method: "POST", body: { verb: "nope" } })).status, 400,
  "an unknown verb is rejected");
t.equal((await call("/api/control", { method: "POST", body: { verb: "volume-set", value: 500 } })).status, 400,
  "an out-of-range value is rejected");

const np = await call("/api/nowplaying");
t.equal(np.status, 200, "GET /api/nowplaying succeeds");
t.equal(np.json.nowPlaying.title, "Track", "now playing reports the current title");

t.equal((await call("/api/stats")).status, 200, "GET /api/stats succeeds");
t.equal((await call("/api/nope")).status, 404, "an unknown API route returns 404");

// ---- CSRF and body limits ----
t.equal(
  (await call("/api/control", { method: "POST", body: { verb: "lock" }, origin: "http://evil.test" })).status,
  403,
  "a cross-origin state change is refused even with a valid session",
);
const big = await fetch(`${base}/api/tiles`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie, origin: base },
  body: JSON.stringify({ tiles: Array.from({ length: 200000 }, () => ({ kind: "control", verb: "lock" })) }),
});
t.equal(big.status, 413, "an oversized body is refused");
t.equal((await big.json()).error, "body too large", "the entire 413 response arrives without a reset");

// Exercise an upload without Content-Length and reuse exactly one connection.
// The body limit must reject it before persistence and leave the socket usable.
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
function rawCall(method, path, chunks = []) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, {
      method, agent, headers: { cookie, origin: base, "content-type": "application/json" },
    }, (res) => {
      const data = [];
      res.on("data", (chunk) => data.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString(), reused: req.reusedSocket }));
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}
try {
  const chunked = await rawCall("PUT", "/api/tiles", Array(20).fill("x".repeat(8192)));
  t.equal(chunked.status, 413, "an oversized chunked body is refused");
  t.equal(JSON.parse(chunked.body).error, "body too large", "chunked rejection has a complete response");
  const following = await rawCall("GET", "/api/tiles");
  t.equal(following.reused, true, "follow-up uses the same keep-alive socket");
  t.equal(following.status, 200, "the next request succeeds on that socket");
  t.equal(JSON.parse(following.body).tiles.length, 2, "rejected uploads do not overwrite tiles");
} finally {
  agent.destroy();
}

const badJson = await fetch(`${base}/api/tiles`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie, origin: base },
  body: "{not json",
});
t.equal(badJson.status, 400, "a malformed JSON body is refused");
await badJson.arrayBuffer();

// ---- unauthenticated access ----
const saved = cookie;
cookie = "";
const anon = await fetch(`${base}/api/state`, { headers: { origin: base, cookie: "windock_session=bogus" } });
t.equal(anon.status, 401, "an invalid session cannot read state");
await anon.arrayBuffer();
const anonAction = await fetch(`${base}/api/control`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, cookie: "windock_session=bogus" },
  body: JSON.stringify({ verb: "shutdown" }),
});
t.equal(anonAction.status, 401, "an invalid session cannot trigger a power action");
await anonAction.arrayBuffer();
cookie = saved;

// ---- /api/pairing is never readable by a paired session ----
const sessionPairing = await call("/api/pairing");
t.equal(sessionPairing.status, 403, "a paired session cannot read /api/pairing when loopback is not trusted");
t.ok(!sessionPairing.text.includes(app.state.pin), "the refused /api/pairing response does not carry the PIN");

// ---- loopback trust is a real feature, limited to loopback Host literals ----
const trusting = await createApp({ provider, configStore, pin: PIN, trustLoopback: true });
await new Promise((r) => trusting.server.listen(0, "127.0.0.1", r));
const tport = trusting.server.address().port;
const trusted = await fetch(`http://127.0.0.1:${tport}/api/state`);
t.equal(trusted.status, 200, "loopback is trusted when trustLoopback is enabled");
await trusted.arrayBuffer();

/** A request to the loopback listener with an explicit Host header (fetch cannot set Host). */
function hostCall(host, path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request({
      host: "127.0.0.1", port: tport, path, method, agent: false,
      headers: { host, ...(payload ? { "content-type": "application/json" } : {}), ...headers },
    }, (res) => {
      const data = [];
      res.on("data", (chunk) => data.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(data).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
/** Resolve with the upgrade outcome: "open" or the refusing HTTP status. */
function upgradeOutcome(host, path = "/", headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${tport}${path}`, { headers: { host, ...headers } });
    const timer = setTimeout(() => { ws.terminate(); resolve("timeout"); }, 2500);
    ws.on("open", () => { clearTimeout(timer); ws.terminate(); resolve("open"); });
    ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.on("error", () => { clearTimeout(timer); resolve("error"); });
  });
}

const EVIL = `evil.example:${tport}`;
for (const host of [`127.0.0.1:${tport}`, `localhost:${tport}`, `[::1]:${tport}`]) {
  t.equal((await hostCall(host, "/api/state")).status, 200, `loopback with Host ${host} is trusted`);
}
t.equal((await hostCall(EVIL, "/api/state")).status, 401, "loopback with a rebinding Host cannot read state");
for (const host of ["127.evil.com", "localhost.evil.com"]) {
  t.equal((await hostCall(`${host}:${tport}`, "/api/state")).status, 401, `Host ${host} is not treated as loopback`);
}
const launchesBefore = helperCalls.length;
const evilLaunch = await hostCall(EVIL, "/api/apps/launch", {
  method: "POST", body: { id: "c:/windows/notepad.exe" }, headers: { origin: `http://${EVIL}` },
});
t.equal(evilLaunch.status, 401, "a rebinding page cannot launch apps (same-origin Origin and Host)");
const evilPower = await hostCall(EVIL, "/api/control", {
  method: "POST", body: { verb: "shutdown" }, headers: { origin: `http://${EVIL}` },
});
t.equal(evilPower.status, 401, "a rebinding page cannot run power actions");
t.equal(helperCalls.length, launchesBefore, "refused rebinding requests never reach the native helper");
t.equal(await upgradeOutcome(EVIL, "/", { origin: `http://${EVIL}` }), 401, "a rebinding page cannot open the sync socket");
t.equal(await upgradeOutcome(EVIL), 401, "a rebinding Host without Origin cannot open the sync socket");
t.equal(await upgradeOutcome(EVIL, "/input", { origin: `http://${EVIL}` }), 401, "a rebinding page cannot open the input socket");
t.equal(await upgradeOutcome(`127.0.0.1:${tport}`), "open", "positive control: a loopback Host opens the sync socket");

// /api/pairing: local software only.
const localPairing = await hostCall(`127.0.0.1:${tport}`, "/api/pairing");
t.equal(localPairing.status, 200, "loopback with a loopback Host reads /api/pairing");
t.deepEqual(Object.keys(localPairing.json).sort(), ["endpoint", "hostId", "hostName", "pairingOpenForMs", "pin", "secureEndpoint", "securityCode"],
  "/api/pairing exposes only its documented fields");
t.ok(localPairing.json.secureEndpoint === null && localPairing.json.securityCode === null,
  "/api/pairing reports no secure endpoint or code without TLS");
t.equal(localPairing.json.pin, PIN, "/api/pairing reports the PIN");
t.equal(localPairing.json.pairingOpenForMs, PAIRING_WINDOW_MS, "/api/pairing reopens pairing for a full ten minutes");
t.equal(localPairing.json.endpoint, null, "/api/pairing endpoint defaults to null");
t.ok(typeof localPairing.json.hostName === "string" && localPairing.json.hostName.length > 0, "/api/pairing names the host");
t.equal(localPairing.json.hostId, null, "/api/pairing hostId is null without an identity");
t.equal(localPairing.headers["cache-control"], "no-store", "/api/pairing is not cacheable");
t.equal((await hostCall(`localhost:${tport}`, "/api/pairing")).status, 200, "Host localhost also reads /api/pairing");
const evilPairing = await hostCall(EVIL, "/api/pairing");
t.equal(evilPairing.status, 401, "a rebinding Host cannot read /api/pairing");
t.ok(!evilPairing.text.includes(PIN), "the rebinding refusal carries no PIN");

// A session cookie still works behind a non-loopback Host, but never for /api/pairing.
const evilPair = await hostCall(EVIL, "/api/auth", { method: "POST", body: { pin: PIN } });
t.equal(evilPair.status, 200, "pairing with the PIN works under any Host");
const evilCookie = String(evilPair.headers["set-cookie"] || "").split(";")[0];
t.ok(evilCookie.startsWith("windock_session="), "pairing under a non-loopback Host issues a session");
t.equal((await hostCall(EVIL, "/api/state", { headers: { cookie: evilCookie } })).status, 200,
  "a valid session is honoured when the Host is not loopback");
const sessionOnly = await hostCall(EVIL, "/api/pairing", { headers: { cookie: evilCookie } });
t.equal(sessionOnly.status, 403, "a valid session behind a non-loopback Host cannot read /api/pairing");
t.ok(!sessionOnly.text.includes(trusting.state.pin), "the session refusal carries no PIN");
for (const [method, path] of [["GET", "/api/devices"], ["DELETE", "/api/devices"], ["DELETE", "/api/devices/0123456789abcdef"]]) {
  const res = await hostCall(EVIL, path, { method, headers: { cookie: evilCookie } });
  t.equal(res.status, 403, `a phone session cannot ${method} ${path}`);
}
t.equal((await hostCall(EVIL, "/api/devices")).status, 401, "a rebinding Host without a session cannot list devices");
t.equal(trusting.sessions.size, 1, "refused device calls revoke nothing");
t.equal(await upgradeOutcome(EVIL, "/", { cookie: evilCookie }), "open", "a valid session opens the sync socket under a non-loopback Host");
await trusting.hub.close();
trusting.server.closeAllConnections?.();
await new Promise((r) => trusting.server.close(r));

// The advertised endpoint passes through to /api/pairing.
const advertised = await createApp({ provider, configStore, pin: PIN, endpoint: "http://192.168.1.20:8620" });
await new Promise((r) => advertised.server.listen(0, "127.0.0.1", r));
const advPairing = await (await fetch(`http://127.0.0.1:${advertised.server.address().port}/api/pairing`)).json();
t.equal(advPairing.endpoint, "http://192.168.1.20:8620", "/api/pairing reports the endpoint passed to createApp");
await advertised.hub.close();
advertised.server.closeAllConnections?.();
await new Promise((r) => advertised.server.close(r));

// ---- startup banner: the tray parses it, so the default form is byte-stable ----
const banner = readyBanner({ providerName: "Windows", endpoint: "http://192.168.1.20:8620", pin: "0427" });
t.equal(banner, "WinDock host ready\n  provider: Windows\n  open:     http://192.168.1.20:8620\n  PIN:      0427\n",
  "the default banner is unchanged");
t.equal((banner.match(/PIN:\s*(\d{4,8})/) || [])[1], "0427", "the tray's PIN pattern still matches");
const sixBanner = readyBanner({ providerName: "Windows", endpoint: "http://192.168.1.20:8620", pin: "042718" });
t.equal(sixBanner, "WinDock host ready\n  provider: Windows\n  open:     http://192.168.1.20:8620\n  PIN:      042718\n",
  "a six-digit code keeps the banner format");
t.equal((sixBanner.match(/PIN:\s*(\d{4,8})/) || [])[1], "042718", "the tray's widened PIN pattern reads all six digits");
t.equal((banner.match(/open:\s*(\S+)/) || [])[1], "http://192.168.1.20:8620", "the tray's endpoint pattern still matches");
const hidden = readyBanner({ providerName: "macOS", endpoint: "http://192.168.1.20:8620", pin: "0427", hidePin: true });
t.ok(!hidden.includes("0427"), "WINDOCK_HIDE_PIN keeps the PIN out of the banner");
t.ok(hidden.includes('  PIN:      (run "npm run info" to show it)\n'), "the hidden banner points to npm run info");
t.ok(!/PIN:\s*\d{4,8}/.test(hidden), "the hidden banner has no PIN for a parser to find");

// ---- identity in /health and sessions that survive a host restart ----
async function stop(a) {
  await a.hub.close();
  a.server.closeAllConnections?.();
  await new Promise((r) => a.server.close(r));
}
const identity = await loadHostIdentity({ path: join(dir, "host.json") });
const sessionsPath = join(dir, "sessions.json");
const first = await createApp({
  provider, configStore, pin: PIN, trustLoopback: false, identity,
  sessions: createSessionStore({ path: sessionsPath }),
});
await new Promise((r) => first.server.listen(0, "127.0.0.1", r));
const firstBase = `http://127.0.0.1:${first.server.address().port}`;
const idHealth = await fetch(`${firstBase}/health`);
const idHealthText = await idHealth.text();
t.equal(JSON.parse(idHealthText).hostId, identity.hostId, "health reports the persisted host id");
t.ok(Buffer.byteLength(idHealthText) <= 4096, "the health body with an identity fits 4096 bytes");
t.ok(!idHealthText.includes(PIN), "health with an identity never includes the PIN");
const pairFirst = await fetch(`${firstBase}/api/auth`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: firstBase },
  body: JSON.stringify({ pin: PIN }),
});
t.equal(pairFirst.status, 200, "pairing succeeds on a host with a persistent store");
const persistentCookie = (pairFirst.headers.get("set-cookie") || "").split(";")[0];
await pairFirst.arrayBuffer();
await first.sessions.flush();
await stop(first);

const second = await createApp({
  provider, configStore, pin: "987600", trustLoopback: false,
  identity: await loadHostIdentity({ path: join(dir, "host.json") }),
  sessions: createSessionStore({ path: sessionsPath }),
});
await new Promise((r) => second.server.listen(0, "127.0.0.1", r));
const secondBase = `http://127.0.0.1:${second.server.address().port}`;
const restarted = await fetch(`${secondBase}/api/state`, { headers: { cookie: persistentCookie } });
t.equal(restarted.status, 200, "a paired session still works after a host restart (new PIN, new port)");
await restarted.arrayBuffer();
const reHealth = await (await fetch(`${secondBase}/health`)).json();
t.equal(reHealth.hostId, identity.hostId, "the host id is unchanged after a restart");
const stranger = await fetch(`${secondBase}/api/state`, { headers: { cookie: "windock_session=bogus" } });
t.equal(stranger.status, 401, "an unknown session is still refused after a restart");
await stranger.arrayBuffer();
await stop(second);

// ---- per-host features ----
t.deepEqual({ ...featuresOf({}) }, { controls: true, nowPlaying: true, capture: false, input: false },
  "featuresOf defaults controls and now playing on, capture and input off");
t.ok(Object.isFrozen(featuresOf({})), "featuresOf returns a frozen object");
t.deepEqual({ ...featuresOf({ features: { controls: false, nowPlaying: false } }) },
  { controls: false, nowPlaying: false, capture: false, input: false }, "a macOS-like provider opts out of controls and now playing");
t.deepEqual({ ...featuresOf({ capture: {}, input: {}, features: {} }) },
  { controls: true, nowPlaying: true, capture: true, input: true }, "capture and input follow the provider's modules");

function fakeProvider(overrides = {}) {
  const calls = { list: 0, control: 0, nowPlaying: 0, launch: [] };
  let scans = [[{ id: "app.one", name: "One", target: "/Apps/One.app" }]];
  const provider = {
    id: "fake", displayName: "Fake", calls,
    setScans(next) { scans = next; },
    async listInstalledApps() {
      calls.list += 1;
      await new Promise((r) => setTimeout(r, 15));
      const next = scans.length > 1 ? scans.shift() : scans[0];
      if (next instanceof Error) throw next;
      return next;
    },
    async listRunningApps() { return []; },
    async launchApp(app) { calls.launch.push(app.id); },
    async focusApp(app) {},
    async closeApp(app) {},
    async control(verb, value) { calls.control += 1; },
    async nowPlaying() { calls.nowPlaying += 1; return { title: "T", playing: true }; },
    async systemStats() { return {}; },
    ...overrides,
  };
  return provider;
}
async function serve(provider, file) {
  const a = await createApp({ provider, configStore: createConfigStore({ path: join(dir, file) }), pin: PIN, trustLoopback: true });
  await new Promise((r) => a.server.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${a.server.address().port}`;
  const req = async (path, body, method = body ? "POST" : "GET") => {
    const res = await fetch(b + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { a, req };
}

const mac = fakeProvider({ features: { controls: false, nowPlaying: false } });
const macHost = await serve(mac, "mac.json");
const macState = await macHost.req("/api/state");
t.deepEqual(macState.json.features, { controls: false, nowPlaying: false, capture: false, input: false }, "state reports a macOS-like host's features");
t.deepEqual(macState.json.verbs, [], "a host without controls advertises no verbs");
const macControl = await macHost.req("/api/control", { verb: "mute-toggle" });
t.equal(macControl.status, 501, "control on a host without controls returns 501");
t.equal(macControl.json.error, "controls unavailable", "the 501 names the missing feature");
t.equal(mac.calls.control, 0, "the provider's control is never called when controls are unavailable");
const macNp = await macHost.req("/api/nowplaying");
t.equal(macNp.status, 200, "now playing still answers without the feature");
t.equal(macNp.json.nowPlaying, null, "now playing is null without the feature");
t.equal(mac.calls.nowPlaying, 0, "the provider's nowPlaying is never called without the feature");

// Stale tiles: catalog lacks a pinned id once a scan has succeeded.
await macHost.req("/api/tiles", { tiles: [
  { kind: "app", id: "app.one", target: "/Apps/One.app", label: "One" },
  { kind: "app", id: "com.example.gone", target: "/Applications/Gone.app", label: "Gone" },
  { kind: "control", verb: "mute-toggle", label: "Mute" },
] }, "PUT");
await macHost.req("/api/apps/installed");
const stale = await macHost.req("/api/state");
t.equal(stale.json.tiles.find((x) => x.id === "app.one").available, true, "a cataloged tile is available");
t.equal(stale.json.tiles.find((x) => x.id === "com.example.gone").available, false, "a tile missing from the catalog is unavailable");
t.equal(stale.json.tiles.find((x) => x.kind === "control").available, false, "control tiles are unavailable without controls");

// Launch: refresh once on a miss, 404 when still unknown, 502 without native text.
mac.setScans([[{ id: "app.one", name: "One", target: "/Apps/One.app" }, { id: "app.new", name: "New", target: "/Apps/New.app" }]]);
const listBefore = mac.calls.list;
const launchedNew = await macHost.req("/api/apps/launch", { id: "app.new" });
t.equal(launchedNew.status, 200, "launching a newly installed app rescans and succeeds");
t.equal(mac.calls.list - listBefore, 1, "a catalog miss forces exactly one fresh scan");
t.deepEqual(mac.calls.launch, ["app.new"], "the newly found app reaches the provider");
const gone = await macHost.req("/api/apps/launch", { id: "com.example.gone" });
t.equal(gone.status, 404, "an app still missing after the rescan returns 404");
t.equal(gone.json.error, "unknown app", "the 404 says unknown app");
mac.launchApp = async () => { throw new Error("LSOpenURLsWithRole() failed with error -10810 for /Apps/One.app"); };
const failed = await macHost.req("/api/apps/launch", { id: "app.one" });
t.equal(failed.status, 502, "a provider launch failure returns 502");
t.deepEqual(failed.json, { error: "launch failed" }, "the 502 carries no native error text");
mac.launchApp = async () => { const e = new Error("Launching apps needs the updated host."); e.status = 501; throw e; };
const unsupported = await macHost.req("/api/apps/launch", { id: "app.one" });
t.equal(unsupported.status, 501, "a provider 501 still passes through");
await macHost.a.hub.close(); macHost.a.server.closeAllConnections?.(); await new Promise((r) => macHost.a.server.close(r));

// Single flight: parallel first requests share one scan; a stale refresh runs in the background.
const busy = fakeProvider();
const busyHost = await serve(busy, "busy.json");
const parallel = await Promise.all(Array.from({ length: 6 }, () => busyHost.req("/api/apps/installed")));
t.ok(parallel.every((r) => r.status === 200 && r.json.apps.length === 1), "parallel catalog requests all succeed");
t.equal(busy.calls.list, 1, "parallel requests share one scan");
const realNow = Date.now;
Date.now = () => realNow() + 61_000;
busy.setScans([new Error("scan failed"), [{ id: "app.one", name: "One", target: "/Apps/One.app" }]]);
const staleReads = await Promise.all(Array.from({ length: 4 }, () => busyHost.req("/api/apps/installed")));
t.ok(staleReads.every((r) => r.json.apps.length === 1), "stale reads return the cached list immediately");
t.equal(busy.calls.list, 2, "a stale cache starts exactly one background refresh");
await new Promise((r) => setTimeout(r, 40));
const afterFail = await busyHost.req("/api/apps/installed");
t.equal(afterFail.json.apps.length, 1, "a failed refresh keeps the old list");
Date.now = realNow;
await busyHost.a.hub.close(); busyHost.a.server.closeAllConnections?.(); await new Promise((r) => busyHost.a.server.close(r));

// First dockState does not wait for a slow first scan, and reports tiles as available.
const slow = fakeProvider({ async listInstalledApps() { slow.calls.list += 1; await new Promise((r) => setTimeout(r, 400)); return []; } });
const slowHost = await serve(slow, "slow.json");
await slowHost.req("/api/tiles", { tiles: [{ kind: "app", id: "app.x", target: "/Apps/X.app", label: "X" }] }, "PUT");
const started = realNow();
const unknown = await slowHost.req("/api/state");
t.ok(realNow() - started < 300, "state does not block on the first catalog scan");
t.equal(unknown.json.tiles[0].available, true, "tiles are available while the catalog is unknown");
t.equal(slow.calls.list, 1, "state kicks off the first scan");
await new Promise((r) => setTimeout(r, 450));
await slowHost.a.hub.close(); slowHost.a.server.closeAllConnections?.(); await new Promise((r) => slowHost.a.server.close(r));

// ---- pairing window, rotation, global budget and paired devices ----
{
  let clock = 1_000_000_000;
  const now = () => clock;
  const codes = ["111111", "222222", "333333", "444444", "555555", "666666", "777777"];
  const inputSessions = [];
  const devProvider = fakeProvider({
    input: {
      // Never ready, so the input hub's 8 s startup lease outlives the test.
      open() { const session = { closed: false, ready: new Promise(() => {}), send() {}, close() { session.closed = true; } }; inputSessions.push(session); return session; },
      dispose() {},
    },
  });
  const pairing = await createApp({
    provider: devProvider,
    configStore: createConfigStore({ path: join(dir, "pairing.json") }),
    pin: "246810",
    nextPin: () => codes.shift(),
    now,
    lockout: createLockout({ now }),
    sessions: createSessionStore({ now }),
    trustLoopback: true,
  });
  // Dual-stack, so requests can come from two loopback addresses (127.0.0.1
  // and ::1) and exercise the global budget across clients.
  await new Promise((r) => pairing.server.listen(0, "::", r));
  const pport = pairing.server.address().port;
  const LAN = `192.168.100.3:${pport}`;
  /** A request with an explicit Host; a LAN Host keeps loopback trust off (a "phone"). */
  const req = (path, { method = "GET", body, host = LAN, address = "127.0.0.1", headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const r = request({
        host: address, port: pport, path, method, agent: false,
        headers: { host, ...(payload ? { "content-type": "application/json" } : {}), ...headers },
      }, (res) => {
        const data = [];
        res.on("data", (c) => data.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(data).toString();
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json, text, cookie: String(res.headers["set-cookie"] || "").split(";")[0] });
        });
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  const LOCAL = `127.0.0.1:${pport}`;
  const pair = (pin, extra = {}, address = "127.0.0.1") => req("/api/auth", { method: "POST", body: { pin, ...extra }, address });
  const healthOpen = async () => (await req("/health")).json.pairingOpen;
  const reopen = () => req("/api/pairing", { host: LOCAL });

  // Window: open at start, closed after ten minutes, without counting failures.
  t.equal(await healthOpen(), true, "health: pairing is open right after start");
  clock += PAIRING_WINDOW_MS;
  t.equal(await healthOpen(), false, "health: pairing closes ten minutes after start");
  const closedRight = await pair("246810");
  t.equal(closedRight.status, 403, "a closed window refuses even the right code");
  t.deepEqual(closedRight.json, { error: "pairing closed" }, "the refusal says pairing closed");
  t.ok(!closedRight.cookie, "a closed window issues no session");
  for (let i = 0; i < 8; i += 1) await pair("999999");
  const stillClosed = await pair("999999");
  t.equal(stillClosed.status, 403, "repeated attempts on a closed window stay 403, never a 429 lockout");
  t.equal(pairing.pairing.failures, 0, "attempts on a closed window count no global failures");
  t.equal((await pair("12")).status, 403, "a closed window answers before checking the PIN's shape");
  t.equal(pairing.pairing.pin, "246810", "a closed window does not rotate the code");

  // Reopen via a local GET /api/pairing.
  const reopened = await reopen();
  t.equal(reopened.status, 200, "a local GET /api/pairing succeeds");
  t.equal(reopened.json.pairingOpenForMs, PAIRING_WINDOW_MS, "the local GET reopens pairing for ten minutes");
  t.equal(reopened.json.pin, "246810", "the local GET reports the current code");
  t.equal(await healthOpen(), true, "health: pairing is open again after the local GET");
  t.equal((await req("/api/pairing")).status, 401, "a phone without a session cannot reopen pairing");
  clock += 5 * 60 * 1000;
  t.equal((await reopen()).json.pairingOpenForMs, PAIRING_WINDOW_MS, "each local GET extends the window to a full ten minutes");

  // Rotation after success; device names.
  const first = await pair("246810", { deviceName: "iPhone" });
  t.equal(first.status, 200, "the current code pairs while the window is open");
  t.ok(first.cookie.startsWith("windock_session="), "pairing issues a session cookie");
  t.equal(pairing.pairing.pin, "111111", "a successful pairing rotates the code");
  const reused = await pair("246810");
  t.equal(reused.status, 401, "the used code then fails");
  t.equal(reused.json.error, "wrong pin", "the used code is simply a wrong pin");
  clock += 10;
  const second = await pair("111111", { deviceName: "  Pixel\u0000\u001b[31m 8\n" });
  t.equal(second.status, 200, "the rotated code pairs the next device");
  clock += 10;
  const third = await pair("222222", { deviceName: "x".repeat(200) });
  clock += 10;
  const fourth = await pair("333333", { deviceName: 12345 });
  t.ok(third.status === 200 && fourth.status === 200, "every rotated code pairs exactly one more device");

  // Phone sessions are refused the local-only routes.
  for (const [method, path] of [["GET", "/api/pairing"], ["GET", "/api/devices"], ["DELETE", "/api/devices"]]) {
    const res = await req(path, { method, headers: { cookie: first.cookie } });
    t.equal(res.status, 403, `a phone session gets 403 for ${method} ${path}`);
    t.deepEqual(res.json, { error: "local only" }, `the ${method} ${path} refusal says local only`);
  }
  t.equal(pairing.pairing.pin, "444444", "a refused phone GET /api/pairing does not reveal or rotate the code");

  // Device list: newest first, sanitized names, no secrets.
  const listed = await req("/api/devices", { host: LOCAL });
  t.equal(listed.status, 200, "a local GET /api/devices succeeds");
  const devices = listed.json.devices;
  t.deepEqual(devices.map((d) => d.name), ["Phone", "x".repeat(60), "Pixel[31m 8", "iPhone"],
    "devices are listed newest first with sanitized names (control chars stripped, 60-char cap, non-string to Phone)");
  t.ok(devices.every((d) => /^[0-9a-f]{16}$/.test(d.id) && Number.isFinite(d.issuedAt) && Number.isFinite(d.lastSeenAt)),
    "each device has an id, issuedAt and lastSeenAt");
  t.deepEqual(Object.keys(listed.json), ["devices"], "GET /api/devices returns only a devices array");
  for (const c of [first, second, third, fourth]) {
    t.ok(!listed.text.includes(c.cookie.split("=")[1]) && !listed.text.includes(hashToken(decodeURIComponent(c.cookie.split("=")[1]))),
      "the device list carries no token or token hash");
  }
  const iphone = devices.find((d) => d.name === "iPhone");
  const pixel = devices.find((d) => d.name === "Pixel[31m 8");
  t.equal(iphone.lastSeenAt, iphone.issuedAt, "a new device was last seen when it paired");

  // lastSeenAt is refreshed at most once an hour.
  clock += LAST_SEEN_INTERVAL_MS / 2;
  t.equal((await req("/api/state", { headers: { cookie: first.cookie } })).status, 200, "the iPhone session reads state");
  const seenHalf = (await req("/api/devices", { host: LOCAL })).json.devices.find((d) => d.id === iphone.id);
  t.equal(seenHalf.lastSeenAt, iphone.issuedAt, "lastSeenAt is not rewritten within the hour");
  clock += LAST_SEEN_INTERVAL_MS / 2;
  await req("/api/state", { headers: { cookie: first.cookie } });
  const seenHour = (await req("/api/devices", { host: LOCAL })).json.devices.find((d) => d.id === iphone.id);
  t.equal(seenHour.lastSeenAt, clock, "lastSeenAt moves after an hour of use");

  // Revoking one device closes its sockets at once and leaves the others.
  const openSocket = (path, cookieHeader) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${pport}${path}`, { headers: { host: LAN, cookie: cookieHeader } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("socket timeout")); }, 2500);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.once("unexpected-response", (_q, res) => { clearTimeout(timer); res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); });
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
  const closedWith = (ws) => new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve({ code: "already" });
    const timer = setTimeout(() => resolve({ code: "timeout" }), 1500);
    ws.once("close", (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
  });
  const iphoneSync = await openSocket("/", first.cookie);
  const iphoneInput = await openSocket("/input", first.cookie);
  const pixelSync = await openSocket("/", second.cookie);
  const localSync = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${pport}/`, { headers: { host: LOCAL } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
  const iphoneSyncClosed = closedWith(iphoneSync);
  const iphoneInputClosed = closedWith(iphoneInput);
  const revokeStarted = realNow();
  const revoked = await req(`/api/devices/${iphone.id}`, { method: "DELETE", host: LOCAL });
  t.equal(revoked.status, 200, "a local DELETE /api/devices/<id> succeeds");
  t.deepEqual(revoked.json, { ok: true, id: iphone.id }, "the revoke reply names the device");
  const syncEnd = await iphoneSyncClosed;
  const inputEnd = await iphoneInputClosed;
  t.equal(syncEnd.code, 1008, "the revoked device's sync socket is closed (policy violation)");
  t.equal(syncEnd.reason, "session revoked", "the sync socket close says session revoked");
  t.equal(inputEnd.code, 1008, "the revoked device's input socket is closed (policy violation)");
  t.equal(inputEnd.reason, "session revoked", "the input socket close says session revoked");
  t.ok(realNow() - revokeStarted < 400, `revocation closes the sockets at once (${realNow() - revokeStarted} ms, not a lease timeout)`);
  t.ok(inputSessions[0]?.closed, "revocation releases the native input session");
  t.equal((await req("/api/state", { headers: { cookie: first.cookie } })).status, 401, "the revoked cookie then gets 401");
  t.equal((await req("/api/state", { headers: { cookie: second.cookie } })).status, 200, "another device stays paired");
  t.equal(pixelSync.readyState, pixelSync.OPEN, "another device's socket stays open");
  t.equal(localSync.readyState, localSync.OPEN, "a loopback-trusted socket is untouched by revocation");
  await t.rejects(() => openSocket("/", first.cookie), "the revoked cookie cannot open a new socket");
  t.equal((await req(`/api/devices/${iphone.id}`, { method: "DELETE", host: LOCAL })).status, 404, "revoking the same device again is 404");
  const unknownDevice = await req("/api/devices/0123456789abcdef", { method: "DELETE", host: LOCAL });
  t.equal(unknownDevice.status, 404, "revoking an unknown id is 404");
  t.deepEqual(unknownDevice.json, { error: "unknown device" }, "the 404 says unknown device");
  t.equal((await req("/api/devices/..%2f..", { method: "DELETE", host: LOCAL })).status, 404, "a malformed id is 404");
  t.equal((await req("/api/devices", { method: "DELETE", host: LOCAL, headers: { origin: "http://evil.example" } })).status, 403,
    "a cross-origin revoke-all is refused");
  t.equal(pairing.sessions.size, 3, "refused revokes leave the other sessions");

  // The npm run devices helper against this host.
  const listedText = await runDevices([], pport);
  t.equal(listedText.code, 0, "npm run devices lists devices");
  t.ok(listedText.out.startsWith("3 paired devices (newest first)\n"), "npm run devices counts the devices");
  t.ok(listedText.out.includes(`Pixel[31m 8`) && listedText.out.includes(pixel.id.slice(0, 8)), "npm run devices shows names and short ids");
  t.ok(!listedText.out.includes(pixel.id), "npm run devices shows the short id, not the full id");
  const byPrefix = await runDevices(["revoke", pixel.id.slice(0, 8)], pport);
  t.equal(byPrefix.code, 0, "npm run devices -- revoke <short id> succeeds");
  t.ok(byPrefix.out.startsWith("Revoked Pixel[31m 8"), "the revoke result names the device");
  t.equal((await req("/api/state", { headers: { cookie: second.cookie } })).status, 401, "the device revoked by the helper gets 401");
  t.equal((await runDevices(["revoke", "ffff"], pport)).code, 1, "revoking an unmatched id fails");
  t.equal((await runDevices(["revoke", "ab"], pport)).code, 1, "a too-short id is refused");
  t.equal((await runDevices(["frobnicate"], pport)).code, 1, "an unknown command prints usage");

  // Revoke all.
  const thirdSync = await openSocket("/", third.cookie);
  const fourthSync = await openSocket("/", fourth.cookie);
  const allClosed = Promise.all([closedWith(thirdSync), closedWith(fourthSync)]);
  const all = await runDevices(["revoke-all"], pport);
  t.equal(all.code, 0, "npm run devices -- revoke-all succeeds");
  t.equal(all.out, "Revoked 2 paired devices. They must pair again with a new PIN.\n", "revoke-all reports the count");
  t.deepEqual((await allClosed).map((e) => e.code), [1008, 1008], "revoke-all closes every session socket");
  for (const c of [third, fourth]) t.equal((await req("/api/state", { headers: { cookie: c.cookie } })).status, 401, "a cookie revoked by revoke-all gets 401");
  t.equal(localSync.readyState, localSync.OPEN, "revoke-all leaves loopback-trusted sockets open");
  t.equal((await runDevices([], pport)).out, "No paired devices.\n", "npm run devices reports no devices after revoke-all");
  const viaApi = await req("/api/devices", { method: "DELETE", host: LOCAL });
  t.deepEqual(viaApi.json, { ok: true, revoked: 0 }, "DELETE /api/devices reports how many were revoked");
  for (const ws of [pixelSync, localSync, iphoneSync, iphoneInput, thirdSync, fourthSync]) ws.terminate();

  // Global budget: ten wrong codes across two addresses rotate and close.
  await reopen();
  const beforeBudget = pairing.pairing.pin;
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await pair("000000", {}, "127.0.0.1")).status);
  t.equal((await pair(beforeBudget, {}, "127.0.0.1")).status, 429, "five failures lock one address out (per-IP lockout still applies)");
  for (let i = 0; i < 4; i += 1) statuses.push((await pair("000000", {}, "::1")).status);
  t.ok(statuses.every((code) => code === 401), "nine wrong codes from two addresses are each refused with 401");
  t.equal(pairing.pairing.pin, beforeBudget, "nine global failures leave the code alone");
  t.equal(await healthOpen(), true, "nine global failures leave pairing open");
  t.equal((await pair("000000", {}, "::1")).status, 401, "the tenth wrong code is still a 401");
  t.ok(pairing.pairing.pin !== beforeBudget, "the tenth global failure rotates the code");
  t.equal(await healthOpen(), false, "the tenth global failure closes pairing");
  clock += LOCK_MS + 1; // let both per-IP lockouts expire
  t.equal((await pair(beforeBudget, {}, "::1")).status, 403, "the old code is refused: pairing closed");
  const closedNew = await pair(pairing.pairing.pin, {}, "127.0.0.1");
  t.equal(closedNew.status, 403, "even the new code is refused until a local reopen");
  t.equal(closedNew.json.error, "pairing closed", "the budget refusal says pairing closed");
  clock += PAIRING_WINDOW_MS * 2;
  t.equal(await healthOpen(), false, "time alone does not reopen a window closed by the budget");
  const afterBudget = await reopen();
  t.equal(afterBudget.json.pairingOpenForMs, PAIRING_WINDOW_MS, "a local GET /api/pairing reopens after the budget is spent");
  t.equal(pairing.pairing.failures, 0, "reopening resets the global failure count");
  t.equal((await pair("000000", {}, "::1")).status, 401, "after the reopen a wrong code is an ordinary failure");
  t.equal(await healthOpen(), true, "one failure after the reopen leaves pairing open");
  const fresh = await pair(afterBudget.json.pin, { deviceName: "iPad" }, "127.0.0.1");
  t.equal(fresh.status, 200, "the code shown by the reopen pairs a device");
  t.ok(Buffer.byteLength((await req("/health")).text) <= 4096, "health with pairingOpen still fits 4096 bytes");

  await pairing.hub.close();
  await pairing.inputHub.close();
  pairing.server.closeAllConnections?.();
  await new Promise((r) => pairing.server.close(r));

  // The helper's offline message, and its pure helpers.
  const offline = await runDevices([], pport);
  t.equal(offline.code, 1, "npm run devices fails when the host is not running");
  t.equal(offline.err, `${NOT_RUNNING}\n`, "npm run devices says WinDock isn't running");
  t.equal(formatDevices([]), "No paired devices.\n", "an empty device list says so");
  const two = [{ id: "aaaa1111bbbb2222", name: "A" }, { id: "aaaa1111cccc3333", name: "B" }];
  t.equal(resolveDevice(two, "aaaa1111").reason, "ambiguous", "an ambiguous prefix is refused");
  t.equal(resolveDevice(two, "AAAA1111CCCC").device?.name, "B", "a unique prefix resolves, case-insensitively");
  t.equal(resolveDevice(two, "aaaa1111bbbb2222").device?.name, "A", "a full id resolves");
}

// ---- npm run info shows the reopened window ----
t.equal(formatInfo({ hostName: "M", endpoint: "http://192.168.1.20:8620", pin: "042718", pairingOpenForMs: PAIRING_WINDOW_MS }),
  "WinDock is running on M\n  Address: http://192.168.1.20:8620\n  PIN:     042718\n  Pairing: open for 10 more minutes\nEnter this address and PIN in the WinDock app on your phone.\n",
  "npm run info shows the six-digit PIN and the pairing window");
t.ok(formatInfo({ hostName: "M", endpoint: "x", pin: "1", pairingOpenForMs: 30_000 }).includes("  Pairing: open for 1 more minute\n"),
  "a partial minute rounds up, singular");

// ---- a pre-upgrade sessions.json keeps its phones paired ----
{
  const legacyPath = join(dir, "legacy-sessions.json");
  const legacyToken = "pre-upgrade-token-value";
  await writeFile(legacyPath, JSON.stringify({ version: 1, sessions: [
    { hash: hashToken(legacyToken), issuedAt: Date.now() - 1000, expiresAt: Date.now() + 1_000_000 },
  ] }));
  const upgraded = await createApp({ provider, configStore, pin: PIN, trustLoopback: true, sessions: createSessionStore({ path: legacyPath }) });
  await new Promise((r) => upgraded.server.listen(0, "127.0.0.1", r));
  const uport = upgraded.server.address().port;
  const uget = (path, headers) => new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: uport, path, agent: false, headers }, (res) => {
      const data = [];
      res.on("data", (c) => data.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(data).toString() || "null") }));
    });
    r.on("error", reject);
    r.end();
  });
  t.equal((await uget("/api/state", { host: `192.168.100.3:${uport}`, cookie: `windock_session=${legacyToken}` })).status, 200,
    "a phone paired before the upgrade stays paired");
  const upgradedList = (await uget("/api/devices", { host: `127.0.0.1:${uport}` })).json.devices;
  t.equal(upgradedList.length, 1, "the pre-upgrade phone is listed");
  t.equal(upgradedList[0].name, "Phone", "the pre-upgrade phone is named Phone");
  await upgraded.sessions.flush();
  await upgraded.hub.close();
  upgraded.server.closeAllConnections?.();
  await new Promise((r) => upgraded.server.close(r));
}

// ---- DELETE /api/session: a phone forgets itself; native pairing ----
{
  const codes = ["600002", "600003", "600004"];
  const forget = await createApp({
    // An input provider that never becomes ready keeps the /input socket open.
    provider: fakeProvider({
      input: { open() { return { ready: new Promise(() => {}), send() {}, close() {} }; }, dispose() {} },
    }),
    configStore: createConfigStore({ path: join(dir, "forget.json") }),
    pin: "600001",
    nextPin: () => codes.shift(),
    sessions: createSessionStore(),
    trustLoopback: true,
  });
  await new Promise((r) => forget.server.listen(0, "127.0.0.1", r));
  const fport = forget.server.address().port;
  const PHONE = `192.168.100.9:${fport}`;
  const LOCALHOST = `127.0.0.1:${fport}`;
  const freq = (path, { method = "GET", body, host = PHONE, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = request({
      host: "127.0.0.1", port: fport, path, method, agent: false,
      headers: { host, ...(payload ? { "content-type": "application/json" } : {}), ...headers },
    }, (res) => {
      const data = [];
      res.on("data", (c) => data.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(data).toString()); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, setCookie: res.headers["set-cookie"]?.[0] || "" });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
  // Native clients (the iOS and Android shells) send no Origin header.
  const nativePair = await freq("/api/auth", { method: "POST", body: { pin: "600001", deviceName: "iPhone" } });
  t.equal(nativePair.status, 200, "native POST /api/auth without an Origin header pairs");
  t.ok(/^windock_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/.test(nativePair.setCookie),
    "native pairing returns the session in Set-Cookie for the shell to hand to its WebView");
  const mine = nativePair.setCookie.split(";")[0];
  const otherPair = await freq("/api/auth", { method: "POST", body: { pin: "600002", deviceName: "Pixel" } });
  const other = otherPair.setCookie.split(";")[0];
  t.ok(other.startsWith("windock_session=") && other !== mine, "a second phone pairs with its own session");

  const sock = (path, cookieHeader) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${fport}${path}`, { headers: { host: PHONE, cookie: cookieHeader } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
  const ended = (ws) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: "timeout" }), 1500);
    ws.once("close", (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
  });
  const mySync = await sock("/", mine);
  const myInput = await sock("/input", mine);
  const otherSync = await sock("/", other);
  const mySyncEnd = ended(mySync);
  const myInputEnd = ended(myInput);

  t.deepEqual((await freq("/api/session", { method: "DELETE", headers: { cookie: mine, origin: "http://evil.example" } })).json,
    { error: "bad origin" }, "DELETE /api/session refuses a cross-origin request");
  t.equal((await freq("/api/state", { headers: { cookie: mine } })).status, 200, "a refused cross-origin forget leaves the session working");

  const forgot = await freq("/api/session", { method: "DELETE", headers: { cookie: mine } });
  t.equal(forgot.status, 200, "DELETE /api/session with the session cookie succeeds");
  t.deepEqual(forgot.json, { ok: true }, "DELETE /api/session answers { ok: true }");
  t.equal(forgot.setCookie, "windock_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "DELETE /api/session clears the cookie with the same attributes");
  t.deepEqual(await mySyncEnd, { code: 1008, reason: "session revoked" }, "forgetting closes this phone's sync socket");
  t.deepEqual(await myInputEnd, { code: 1008, reason: "session revoked" }, "forgetting closes this phone's input socket");
  t.equal((await freq("/api/state", { headers: { cookie: mine } })).status, 401, "the forgotten session then gets 401");
  t.equal((await freq("/api/state", { headers: { cookie: other } })).status, 200, "another phone's session is unaffected");
  t.equal(otherSync.readyState, otherSync.OPEN, "another phone's socket stays open");
  const remaining = (await freq("/api/devices", { host: LOCALHOST })).json.devices;
  t.deepEqual(remaining.map((d) => d.name), ["Pixel"], "only the forgetting phone left the device list");

  const again = await freq("/api/session", { method: "DELETE", headers: { cookie: mine } });
  t.equal(again.status, 401, "forgetting an already revoked session is 401");
  t.equal(again.setCookie, "windock_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "a stale cookie is still cleared");
  const none = await freq("/api/session", { method: "DELETE" });
  t.equal(none.status, 400, "DELETE /api/session without a cookie is 400");
  t.deepEqual(none.json, { error: "no session" }, "the refusal says no session");
  const loopbackNone = await freq("/api/session", { method: "DELETE", host: LOCALHOST });
  t.equal(loopbackNone.status, 400, "a loopback-trusted DELETE /api/session without a cookie is 400, not a free pass");
  t.deepEqual(loopbackNone.json, { error: "no session" }, "the loopback refusal says no session");
  t.equal((await freq("/api/devices", { host: LOCALHOST })).json.devices.length, 1, "a loopback forget without a cookie revokes nothing");
  otherSync.terminate();
  await forget.hub.close();
  forget.server.closeAllConnections?.();
  await new Promise((r) => forget.server.close(r));
}

await app.hub.close();
// fetch keeps connections alive; close() alone would wait for them forever.
app.server.closeAllConnections?.();
await new Promise((r) => app.server.close(r));
await rm(dir, { recursive: true, force: true });

t.done("api verification passed");
