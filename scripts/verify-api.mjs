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
import { createSessionStore } from "../src/auth.js";
import { loadHostIdentity } from "../src/identity.js";
import { featuresOf, CONTROL_VERBS } from "../src/platform/contract.js";

const t = createChecker("api");
const PIN = "4321";

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
t.deepEqual(Object.keys(health.json).sort(), ["api", "app", "hostId", "hostName", "ok", "platform", "tls"],
  "health exposes only its documented fields");
t.equal(health.json.tls, null, "health reports tls: null without TLS");

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
t.equal((await call("/api/auth", { method: "POST", body: { pin: "0000" } })).status, 401, "a wrong pin is refused");
t.equal((await call("/api/auth", { method: "POST", body: { pin: "12" } })).status, 400, "a malformed pin is refused");
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
t.deepEqual(state.json.features, { controls: true, nowPlaying: true, capture: true, input: true },
  "the Windows provider keeps every feature");
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
t.ok(!sessionPairing.text.includes(PIN), "the refused /api/pairing response does not carry the PIN");

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
t.deepEqual(Object.keys(localPairing.json).sort(), ["endpoint", "hostId", "hostName", "pin", "secureEndpoint", "securityCode"],
  "/api/pairing exposes only its documented fields");
t.ok(localPairing.json.secureEndpoint === null && localPairing.json.securityCode === null,
  "/api/pairing reports no secure endpoint or code without TLS");
t.equal(localPairing.json.pin, PIN, "/api/pairing reports the PIN");
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
t.ok(!sessionOnly.text.includes(PIN), "the session refusal carries no PIN");
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
t.equal((banner.match(/PIN:\s*(\d{4})/) || [])[1], "0427", "the tray's PIN pattern still matches");
t.equal((banner.match(/open:\s*(\S+)/) || [])[1], "http://192.168.1.20:8620", "the tray's endpoint pattern still matches");
const hidden = readyBanner({ providerName: "macOS", endpoint: "http://192.168.1.20:8620", pin: "0427", hidePin: true });
t.ok(!hidden.includes("0427"), "WINDOCK_HIDE_PIN keeps the PIN out of the banner");
t.ok(hidden.includes('  PIN:      (run "npm run info" to show it)\n'), "the hidden banner points to npm run info");
t.ok(!/PIN:\s*\d{4}/.test(hidden), "the hidden banner has no PIN for a parser to find");

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
  provider, configStore, pin: "9876", trustLoopback: false,
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

await app.hub.close();
// fetch keeps connections alive; close() alone would wait for them forever.
app.server.closeAllConnections?.();
await new Promise((r) => app.server.close(r));
await rm(dir, { recursive: true, force: true });

t.done("api verification passed");
