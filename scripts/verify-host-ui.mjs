/**
 * Host control page (docs/design/HOST-CONTROL-PAGE.md): the cross-site guard
 * on local-only routes, the pairing model (close/rotate/generation/reason),
 * host-side device labels, the QR payload and encoder, the /host and
 * /api/host/* routes, live events, and the page's pure helpers.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { createChecker } from "./lib/assert.mjs";
import { createApp, crossSiteBlocked, isJsonRequest, displayHostName, interfaceKind, otherAddresses, HOST_SECURITY_HEADERS } from "../server.js";
import { createWindowsProvider } from "../src/platform/windows.js";
import { createConfigStore } from "../src/config.js";
import { generateTlsIdentity } from "../src/tls.js";
import {
  createPairing, createLockout, createSessionStore, sanitizeDeviceLabel, DEVICE_LABEL_MAX, PAIRING_WINDOW_MS, GLOBAL_FAIL_BUDGET,
} from "../src/auth.js";
import {
  encodeQr, qrSvgPath, qrTerminalText, byteCapacity, buildPairingPayload, encodePayloadName, uuidToBase64url, fingerprintToBase64url, pairingQr,
} from "../src/qr.js";
import { formatQr } from "./windock-info.mjs";
import * as page from "../host-ui/host.js";

const t = createChecker("host-ui");
const ROOT = join(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "windock-host-ui-"));

// ---------------------------------------------------------------------------
// Pairing model
// ---------------------------------------------------------------------------
{
  let clock = 1_000_000;
  const pins = ["111111", "222222", "333333", "444444", "555555"];
  const pairing = createPairing({ pin: "000000", nextPin: () => pins.shift(), now: () => clock });
  t.ok(pairing.isOpen() && pairing.closedReason === null, "a new pairing window is open with no closed reason");
  t.equal(pairing.generation, 1, "generation starts at 1");

  pairing.close({ rotate: true });
  t.ok(!pairing.isOpen(), "close() closes the window");
  t.equal(pairing.closedReason, "stopped", "close() defaults to reason stopped");
  t.equal(pairing.pin, "111111", "close({ rotate: true }) rotates the PIN");
  t.equal(pairing.remainingMs(), 0, "a closed window has no time left");
  t.equal(pairing.generation, 2, "stopping bumps the generation");

  t.equal(pairing.reopen(), PAIRING_WINDOW_MS, "reopen grants a full window");
  t.ok(pairing.isOpen() && pairing.closedReason === null, "reopen clears the closed reason");
  t.equal(pairing.pin, "111111", "reopen keeps the (already rotated) PIN");
  t.equal(pairing.generation, 3, "opening bumps the generation");

  clock += PAIRING_WINDOW_MS;
  t.equal(pairing.closedReason, "timeout", "running out of time closes with reason timeout");
  t.equal(pairing.generation, 4, "a timeout bumps the generation once");
  t.equal(pairing.generation, 4, "reading again does not bump it again");
  t.equal(pairing.pin, "111111", "D4: a timeout keeps the PIN");
  pairing.reopen();
  t.equal(pairing.pin, "111111", "D4: reopening after a timeout keeps the scanned PIN valid");
  t.ok(pairing.matches("111111"), "the kept PIN still matches after reopen");

  const gen = pairing.generation;
  pairing.recordSuccess();
  t.ok(pairing.isOpen() && pairing.pin === "222222", "a pairing rotates the PIN and keeps the window open");
  t.equal(pairing.generation, gen + 1, "a rotation after pairing bumps the generation");

  for (let i = 0; i < GLOBAL_FAIL_BUDGET - 1; i += 1) pairing.recordFailure();
  t.ok(pairing.isOpen(), "nine wrong PINs keep the window open");
  const g2 = pairing.generation;
  t.ok(pairing.recordFailure().exhausted, "the tenth wrong PIN spends the budget");
  t.equal(pairing.closedReason, "budget", "a spent budget closes with reason budget");
  t.equal(pairing.pin, "333333", "a spent budget rotates the PIN");
  t.equal(pairing.generation, g2 + 1, "a spent budget bumps the generation");

  pairing.reopen();
  pairing.close({ reason: "no-address" });
  t.equal(pairing.closedReason, "no-address", "close can record reason no-address");
  t.equal(pairing.pin, "333333", "closing for no address keeps the PIN");
  const g3 = pairing.generation;
  pairing.touch();
  t.equal(pairing.generation, g3 + 1, "touch() (address changed) bumps the generation");
  t.throws(() => pairing.close({ reason: "bogus" }), "an unknown close reason is refused");
}

// ---------------------------------------------------------------------------
// Device labels
// ---------------------------------------------------------------------------
{
  t.equal(sanitizeDeviceLabel("  Geri’s\u0007 iPhone ​ "), "Geri’s iPhone", "labels lose control and format characters and are trimmed");
  t.equal(sanitizeDeviceLabel(""), null, "an empty label is null");
  t.equal(sanitizeDeviceLabel("   "), null, "a blank label is null");
  t.equal(sanitizeDeviceLabel(null), null, "a null label is null");
  t.equal(sanitizeDeviceLabel(42), null, "a non-string label is null");
  t.equal(Array.from(sanitizeDeviceLabel("😀".repeat(60))).length, DEVICE_LABEL_MAX, "labels are cut to 40 code points");

  const path = join(scratch, "sessions.json");
  const store = createSessionStore({ path });
  store.issue({ name: "iPhone" });
  const [device] = store.list();
  t.equal(device.label, null, "a new device has no label");
  t.deepEqual(store.setLabel(device.id, " Geri’s iPhone "), { id: device.id, label: "Geri’s iPhone" }, "setLabel stores the cleaned label");
  t.equal(store.setLabel("0000000000000000", "x"), null, "setLabel on an unknown id is null");
  await store.flush();
  const reloaded = createSessionStore({ path });
  t.equal(reloaded.list()[0].label, "Geri’s iPhone", "the label persists with the session record");
  t.equal(reloaded.list()[0].name, "iPhone", "the phone's own name is kept beside the label");
  reloaded.setLabel(device.id, null);
  await reloaded.flush();
  t.equal(createSessionStore({ path }).list()[0].label, null, "a cleared label stays cleared after reload");
  const raw = JSON.parse(await readFile(path, "utf8"));
  t.ok(!("label" in raw.sessions[0]), "a cleared label is not written to disk");
}

// ---------------------------------------------------------------------------
// QR payload (section 9.1) and encoder
// ---------------------------------------------------------------------------
const SAMPLES = [
  "windock://pair?v=1&id=Ww6POixBTX6aFnPCvk2R8A&addr=192.168.1.34:8620&fp=biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9qE&pin=482913&name=Geris-MacBook-Air",
  "windock://pair?v=1&id=0FvYxz2KR1yUq3nE8iWbPg&addr=192.168.1.20:8620&fp=o_BcHojSSRew5sNa8o0ed0C5xqXSH4Pgm0xX1qIefAk&pin=315780&name=DESKTOP-7H2KQ9L",
];
function fieldsOf(sample) {
  const q = new URLSearchParams(sample.split("?")[1]);
  const hex = Buffer.from(q.get("id"), "base64url").toString("hex");
  const [address, port] = q.get("addr").split(":");
  return {
    hostId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    address, port: Number(port),
    fingerprint: Buffer.from(q.get("fp"), "base64url").toString("hex"),
    pin: q.get("pin"), name: q.get("name"),
  };
}
{
  SAMPLES.forEach((sample, i) => {
    const fields = fieldsOf(sample);
    t.equal(buildPairingPayload(fields), sample, `the payload builder reproduces sample ${i + 1} from section 9.7 exactly`);
  });
  t.equal(SAMPLES[0].length, 148, "sample 1 is 148 bytes");
  t.equal(SAMPLES[1].length, 146, "sample 2 is 146 bytes");
  t.ok(fieldsOf(SAMPLES[0]).fingerprint.startsWith("6e21b4f093ad"), "sample 1's fingerprint matches its security code");

  const fields = { hostId: "5b0e8f3a-2c41-4d7e-9a16-73c2be4d91f0", address: "192.168.1.34", port: 8620, fingerprint: "ab".repeat(32), pin: "012345", name: "Mac" };
  const text = buildPairingPayload(fields);
  const keys = [...new URLSearchParams(text.split("?")[1]).keys()];
  t.deepEqual(keys, ["v", "id", "addr", "fp", "pin", "name"], "payload fields are written in the documented order");
  t.ok(text.startsWith("windock://pair?v=1&"), "the payload is a windock://pair link, v=1");
  const id = uuidToBase64url(fields.hostId);
  const fp = fingerprintToBase64url(fields.fingerprint);
  t.equal(id.length, 22, "id is 22 base64url characters");
  t.equal(fp.length, 43, "fp is 43 base64url characters");
  t.ok(/^[A-Za-z0-9_-]+$/.test(id + fp), "id and fp use the base64url alphabet without padding");
  t.equal(Buffer.from(id, "base64url").toString("hex"), fields.hostId.replace(/-/g, ""), "id decodes to the host ID's 16 bytes");
  t.equal(Buffer.from(fp, "base64url").toString("hex"), fields.fingerprint, "fp decodes to the 32 fingerprint bytes");
  t.ok(text.includes("&pin=012345&"), "the PIN keeps its leading zero");
  t.throws(() => buildPairingPayload({ ...fields, pin: "12345" }), "a 5-digit PIN is refused");
  t.throws(() => buildPairingPayload({ ...fields, hostId: "nope" }), "a non-UUID host ID is refused");
  t.throws(() => buildPairingPayload({ ...fields, fingerprint: "ab" }), "a short fingerprint is refused");
  t.throws(() => buildPairingPayload({ ...fields, address: "mac.local" }), "a non-IPv4 address is refused");

  t.equal(encodePayloadName("Geri's Mac (2)"), "Geri%27s%20Mac%20%282%29", "names keep only RFC 3986 unreserved characters unencoded");
  t.equal(encodePayloadName("a\u0000b‮c\n"), "abc", "control and format characters are removed from the name");
  const long = encodePayloadName("x".repeat(50));
  t.equal(long, "x".repeat(32), "an ASCII name is cut to 32 bytes");
  const multi = encodePayloadName("Gerī’s MacBook Air 😀😀😀");
  t.ok(multi.length <= 32, `a multi-byte name stays within 32 encoded bytes (${multi.length})`);
  t.ok((() => { try { decodeURIComponent(multi); return true; } catch { return false; } })(), "a truncated name never splits a character");
  t.equal(encodePayloadName("ü".repeat(10)), "%C3%BC".repeat(5), "truncation stops before a character that would not fit");
  const maxed = buildPairingPayload({ ...fields, address: "192.168.100.200", port: 65535, name: "W".repeat(80) });
  t.equal(maxed.length, 167, "every field at full length is 167 bytes (section 9.2)");
  t.equal(encodeQr(maxed).version, 9, "the longest payload still fits version 9");
}
{
  // Capacities at ECC M, byte mode.
  t.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(byteCapacity), [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
    "byte capacity per version matches the QR specification at level M");
  for (let v = 1; v <= 10; v += 1) {
    t.equal(encodeQr("a".repeat(byteCapacity(v))).version, v, `a payload of exactly the version-${v} capacity uses version ${v}`);
    if (v < 10) t.equal(encodeQr("a".repeat(byteCapacity(v) + 1)).version, v + 1, `one byte more moves to version ${v + 1}`);
  }
  t.throws(() => encodeQr("a".repeat(214)), "payloads above version 10 are refused");

  // The two sample payloads: version 8, and identical to the codes in the
  // design mockups, which were decoded back from rendered PNGs (CoreImage).
  const mockups = await readFile(join(ROOT, "docs/design/host-control-mockups.html"), "utf8");
  const ids = ["qr-mac", "qr-win"];
  SAMPLES.forEach((sample, i) => {
    const qr = encodeQr(sample);
    t.equal(qr.version, 8, `sample ${i + 1} encodes at version 8`);
    t.equal(qr.size, 49, `sample ${i + 1} is 49 x 49 modules`);
    const m = mockups.match(new RegExp(`<symbol id="${ids[i]}"[^>]*>.*?<path fill="#090E10" d="([^"]+)"`));
    const theirs = new Set([...m[1].matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((x) => `${x[1]},${x[2]}`));
    const ours = new Set();
    qr.modules.forEach((row, y) => row.forEach((dark, x) => dark && ours.add(`${x},${y}`)));
    const same = theirs.size === ours.size && [...ours].every((k) => theirs.has(k));
    t.ok(same, `sample ${i + 1} matches the mockup's verified QR module for module`);
    t.equal(encodeQr(sample).modules.map((r) => r.map(Number).join("")).join("/"), qr.modules.map((r) => r.map(Number).join("")).join("/"),
      `sample ${i + 1} encodes identically every time`);

    // Format information: both copies agree, level M, the reported mask, valid BCH.
    const at = (x, y) => (qr.modules[y][x] ? 1 : 0);
    const a = [];
    for (let k = 0; k <= 5; k += 1) a.push(at(8, k));
    a.push(at(8, 7), at(8, 8), at(7, 8));
    for (let k = 9; k < 15; k += 1) a.push(at(14 - k, 8));
    const b = [];
    for (let k = 0; k < 8; k += 1) b.push(at(qr.size - 1 - k, 8));
    for (let k = 8; k < 15; k += 1) b.push(at(8, qr.size - 15 + k));
    const value = (bits) => bits.reduce((acc, bit, k) => acc | (bit << k), 0);
    t.equal(value(a), value(b), `sample ${i + 1}: both format-information copies agree`);
    const info = value(a) ^ 0x5412;
    t.equal(info >> 13, 0, `sample ${i + 1}: format information says level M`);
    t.equal((info >> 10) & 7, qr.mask, `sample ${i + 1}: format information carries the chosen mask`);
    let rem = info >> 10;
    for (let k = 0; k < 10; k += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    t.equal(rem & 0x3ff, info & 0x3ff, `sample ${i + 1}: format information has a valid BCH code`);
    t.equal(at(8, qr.size - 8), 1, `sample ${i + 1}: the dark module is set`);
  });
  const digest = createHash("sha256").update(encodeQr(SAMPLES[0]).modules.map((r) => r.map(Number).join("")).join("\n")).digest("hex");
  t.equal(digest, "58d2233600fdb76578c1a88f2d84eca16e4a7e6317a6a6a916b93aa3ca4b187f", "sample 1's module matrix is pinned (stable output)");

  const small = encodeQr("WinDock");
  const path = qrSvgPath(small.modules);
  let covered = 0;
  for (const mm of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) { covered += Number(mm[3]); t.ok(mm[3] === mm[4], "every path run closes on itself"); }
  const dark = small.modules.flat().filter(Boolean).length;
  t.equal(covered, dark, "the SVG path covers exactly the dark modules");
  t.ok(/^(M\d+ \d+h\d+v1h-\d+z)+$/.test(path), "the SVG path uses only unit-height runs");

  const term = qrTerminalText(small.modules);
  t.equal(term.trimEnd().split("\n").length, Math.ceil((small.size + 8) / 2), "the terminal QR uses one line per two module rows, quiet zone included");
  t.ok(formatQr(SAMPLES[0]).includes("▀") || formatQr(SAMPLES[0]).includes("▄"), "npm run info draws the QR with half blocks");
  t.ok(!formatQr(null), "npm run info draws no QR without a payload");

  const viaHelper = pairingQr(fieldsOf(SAMPLES[0]));
  t.equal(viaHelper.text, SAMPLES[0], "pairingQr returns the payload text");
  t.equal(viaHelper.size, 49, "pairingQr returns the module count");
  t.equal(viaHelper.path, qrSvgPath(encodeQr(SAMPLES[0]).modules), "pairingQr returns the SVG path");
}

// ---------------------------------------------------------------------------
// Helpers in server.js
// ---------------------------------------------------------------------------
{
  const req = (headers, encrypted = false) => ({ headers, socket: { encrypted } });
  t.ok(!crossSiteBlocked(req({ host: "127.0.0.1:8620" })), "no fetch metadata and no Origin passes (CLI, tray, shells)");
  t.ok(crossSiteBlocked(req({ host: "127.0.0.1:8620", "sec-fetch-site": "cross-site" })), "Sec-Fetch-Site cross-site is blocked");
  t.ok(crossSiteBlocked(req({ host: "127.0.0.1:8620", "sec-fetch-site": "same-site" })), "Sec-Fetch-Site same-site is blocked");
  t.ok(!crossSiteBlocked(req({ host: "127.0.0.1:8620", "sec-fetch-site": "same-origin" })), "Sec-Fetch-Site same-origin passes");
  t.ok(!crossSiteBlocked(req({ host: "127.0.0.1:8620", "sec-fetch-site": "none" })), "Sec-Fetch-Site none (typed URL) passes");
  t.ok(crossSiteBlocked(req({ host: "127.0.0.1:8620", origin: "http://evil.example" })), "a foreign Origin is blocked");
  t.ok(crossSiteBlocked(req({ host: "127.0.0.1:8620", origin: "null" })), "Origin: null is blocked");
  t.ok(crossSiteBlocked(req({ host: "127.0.0.1:8620", origin: "http://127.0.0.1:9999" })), "another port's Origin is blocked");
  t.ok(crossSiteBlocked(req({ host: "127.0.0.1:8620", origin: "https://127.0.0.1:8620" })), "the other scheme's Origin is blocked");
  t.ok(!crossSiteBlocked(req({ host: "127.0.0.1:8620", origin: "http://127.0.0.1:8620" })), "the request's own Origin passes");
  t.ok(isJsonRequest(req({ "content-type": "application/json; charset=utf-8" })), "application/json with a charset is JSON");
  t.ok(!isJsonRequest(req({ "content-type": "text/plain" })), "text/plain is not JSON");
  t.ok(!isJsonRequest(req({})), "no content type is not JSON");
  t.equal(displayHostName("Geris-MacBook-Air.local"), "Geris-MacBook-Air", "the .local suffix is dropped from the shown name");
  t.equal(displayHostName("DESKTOP-7H2KQ9L"), "DESKTOP-7H2KQ9L", "other names are unchanged");
  t.equal(interfaceKind("Wi-Fi"), "wifi", "a Wi-Fi interface is wifi");
  t.equal(interfaceKind("Ethernet 2"), "ethernet", "an Ethernet interface is ethernet");
  t.deepEqual(otherAddresses({
    en0: [{ family: "IPv4", address: "192.168.1.34", internal: false }],
    "Ethernet 2": [{ family: "IPv4", address: "10.0.0.12", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
    lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    utun3: [{ family: "IPv4", address: "100.64.0.2", internal: false }],
  }, "192.168.1.34"), [{ address: "10.0.0.12", interface: "Ethernet 2", kind: "ethernet" }], "other addresses list only extra private IPv4 addresses");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const provider = () => createWindowsProvider({
  helperPath: "H.exe",
  exec: async (file, args) => {
    if (file === "H.exe") return { stdout: "" };
    const script = args[args.length - 1];
    if (script.includes("MainWindowHandle")) return { stdout: "[]" };
    if (script.includes("WScript.Shell")) return { stdout: "[]" };
    return { stdout: "{}" };
  },
});
const tlsId = generateTlsIdentity({ commonName: "host-ui test" });
const HOST_ID = "5b0e8f3a-2c41-4d7e-9a16-73c2be4d91f0";

async function listen(options = {}) {
  const app = await createApp({
    provider: provider(),
    configStore: createConfigStore({ path: join(scratch, `config-${Math.random()}.json`) }),
    identity: { hostId: HOST_ID },
    tls: tlsId,
    lockout: createLockout({ maxFails: 1000 }),
    ...options,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  app.state.endpoint = `http://192.168.1.34:${port}`;
  app.state.secureEndpoint = `https://192.168.1.34:${port}`;
  return { app, port };
}
async function stop(app) {
  await app.hub.close();
  await app.inputHub.close();
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
}

function call(port, path, { method = "GET", headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const r = request({
      host: "127.0.0.1", port, path, method, agent: false,
      headers: { host: host ?? `127.0.0.1:${port}`, ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      const data = [];
      res.on("data", (c) => data.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(data).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, cookie: String(res.headers["set-cookie"] || "").split(";")[0] });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const JSON_CT = { "content-type": "application/json" };
const IMG = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" };

{
  const { app, port } = await listen({ pin: "246810", shell: "macos-menubar" });
  const LAN = `192.168.1.34:${port}`;

  // ---- /health ----
  const health = await call(port, "/health");
  t.equal(health.json.hostUi, true, "/health says hostUi: true");

  // ---- the <img> attack on GET /api/pairing (section 13.4) ----
  for (let i = 0; i < 3; i += 1) await call(port, "/api/auth", { method: "POST", headers: JSON_CT, body: { pin: "999999" } });
  t.equal(app.pairing.failures, 3, "three wrong PINs are counted");
  const img = await call(port, "/api/pairing", { headers: IMG });
  t.equal(img.status, 403, "an <img>-style cross-site GET of /api/pairing is refused");
  t.ok(!img.text.includes("246810"), "the refusal carries no PIN");
  t.equal(app.pairing.failures, 3, "the cross-site GET does not reset the wrong-PIN budget");
  for (let i = 0; i < GLOBAL_FAIL_BUDGET - 3; i += 1) await call(port, "/api/auth", { method: "POST", headers: JSON_CT, body: { pin: "999999" } });
  t.equal(app.pairing.closedReason, "budget", "ten wrong PINs close pairing (budget)");
  const rotated = app.pairing.pin;
  t.ok(rotated !== "246810", "the budget rotated the PIN");
  const img2 = await call(port, "/api/pairing", { headers: IMG });
  t.equal(img2.status, 403, "a cross-site GET of /api/pairing after the budget is refused");
  t.ok(!app.pairing.isOpen(), "the cross-site GET does not reopen pairing");
  t.equal(app.pairing.failures, GLOBAL_FAIL_BUDGET, "the spent budget is not reset by it");
  for (const [label, headers] of [
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
    ["a foreign Origin", { origin: "http://evil.example" }],
    ["Origin: null", { origin: "null" }],
  ]) {
    t.equal((await call(port, "/api/pairing", { headers })).status, 403, `GET /api/pairing with ${label} is refused`);
  }
  t.ok(!app.pairing.isOpen(), "none of the refused requests reopened pairing");
  const sameOriginInfo = await call(port, "/api/pairing", { headers: { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${port}` } });
  t.equal(sameOriginInfo.status, 200, "a same-origin GET /api/pairing still works");
  const cli = await call(port, "/api/pairing");
  t.equal(cli.status, 200, "the CLI (no fetch metadata) still reads /api/pairing");
  t.ok(app.pairing.isOpen() && app.pairing.failures === 0, "GET /api/pairing still reopens pairing and resets the budget for the CLI");
  t.equal(cli.json.pin, rotated, "GET /api/pairing reports the current PIN");

  // ---- /api/devices guard ----
  t.equal((await call(port, "/api/devices", { headers: { "sec-fetch-site": "cross-site" } })).status, 403, "a cross-site GET /api/devices is refused");
  t.equal((await call(port, "/api/devices", { method: "DELETE", headers: { origin: "http://evil.example" } })).status, 403, "a cross-origin DELETE /api/devices is refused");

  // ---- /host and /api/host/* are local only ----
  t.equal((await call(port, "/host", { host: LAN })).status, 404, "/host answers 404 behind a LAN Host");
  t.equal((await call(port, "/host/host.js", { host: LAN })).status, 404, "/host assets answer 404 behind a LAN Host");
  const lanStatus = await call(port, "/api/host/status", { host: LAN });
  t.equal(lanStatus.status, 403, "/api/host/status answers 403 behind a LAN Host");
  t.equal(lanStatus.json?.error, "local only", "the refusal says local only");
  t.equal((await call(port, "/api/host/pairing", { host: "evil.example" })).status, 403, "/api/host/pairing refuses a rebinding Host");
  t.equal((await call(port, "/api/host/pairing/open", { method: "POST", host: LAN, headers: JSON_CT, body: {} })).status, 403, "opening pairing from the LAN is refused");

  // ---- cross-site matrix on the new routes ----
  for (const path of ["/host", "/host/host.css", "/api/host/status", "/api/host/pairing", "/api/host/events"]) {
    t.equal((await call(port, path, { headers: { "sec-fetch-site": "cross-site" } })).status, 403, `${path}: Sec-Fetch-Site cross-site is refused`);
    t.equal((await call(port, path, { headers: { "sec-fetch-site": "same-site" } })).status, 403, `${path}: Sec-Fetch-Site same-site is refused`);
    t.equal((await call(port, path, { headers: { origin: "http://evil.example" } })).status, 403, `${path}: a foreign Origin is refused`);
  }
  const openBefore = app.pairing.generation;
  t.equal((await call(port, "/api/host/pairing/open", { method: "POST", headers: { ...JSON_CT, origin: "http://evil.example" }, body: {} })).status, 403,
    "a cross-origin POST /api/host/pairing/open is refused");
  t.equal((await call(port, "/api/host/pairing/close", { method: "POST", headers: { ...JSON_CT, "sec-fetch-site": "cross-site" }, body: {} })).status, 403,
    "a cross-site POST /api/host/pairing/close is refused");
  t.equal(app.pairing.generation, openBefore, "refused requests change nothing");

  // ---- content type on mutating /api/host/* ----
  t.equal((await call(port, "/api/host/pairing/open", { method: "POST" })).status, 415, "POST without a content type is refused (415)");
  t.equal((await call(port, "/api/host/pairing/close", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415,
    "POST with text/plain is refused (415)");
  t.equal((await call(port, "/api/host/pairing/close", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" })).status, 415,
    "POST with a form content type is refused (415)");
  t.equal(app.pairing.generation, openBefore, "415 refusals change nothing");

  // ---- security headers ----
  const pageRes = await call(port, "/host");
  t.equal(pageRes.status, 200, "GET /host serves the page");
  t.ok(pageRes.headers["content-type"].startsWith("text/html"), "the page is HTML");
  for (const [path, label] of [["/host", "page"], ["/host/", "page (slash)"], ["/host/host.css", "stylesheet"], ["/host/host.js", "script"], ["/api/host/status", "status"], ["/api/host/pairing", "pairing"], ["/api/host/nope", "unknown route"]]) {
    const res = path === "/host" ? pageRes : await call(port, path);
    for (const [name, value] of Object.entries(HOST_SECURITY_HEADERS)) {
      t.equal(res.headers[name], value, `${label}: ${name}`);
    }
  }
  t.ok(HOST_SECURITY_HEADERS["content-security-policy"].includes("frame-ancestors 'none'"), "the CSP forbids framing");
  t.ok(HOST_SECURITY_HEADERS["content-security-policy"].includes("script-src 'self'") && !HOST_SECURITY_HEADERS["content-security-policy"].includes("unsafe"),
    "the CSP allows only same-origin scripts and styles, nothing inline");
  for (const evil of ["/host/..%2fserver.js", "/host/..%2f..%2fpackage.json", "/host/%2e%2e%2fsrc%2fauth.js"]) {
    const res = await call(port, evil);
    t.ok(res.status !== 200 && !/createApp|"dependencies"|createPairing/.test(res.text), `${evil} serves nothing outside host-ui/`);
  }
  const dotted = await call(port, "/host/%2e%2e/server.js");
  t.ok(dotted.status !== 200 && !dotted.text.includes("createApp"), "/host never serves files outside host-ui/");
  t.equal((await call(port, "/host/missing.js")).status, 404, "/host answers 404 for a missing asset");
  t.equal((await call(port, "/hostile")).status, 404, "/hostile is not part of /host");
  t.equal((await call(port, "/host", { method: "POST", headers: JSON_CT, body: {} })).status, 405, "/host is GET only");

  // ---- the page source: CSP-compatible, no storage ----
  const html = await readFile(join(ROOT, "host-ui/index.html"), "utf8");
  const js = await readFile(join(ROOT, "host-ui/host.js"), "utf8");
  t.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "the page has no inline script");
  t.ok(!/\sstyle=/i.test(html) && !/<style/i.test(html), "the page has no inline styles");
  t.ok(!/\son[a-z]+=/i.test(html), "the page has no inline event handlers");
  t.ok(!/localStorage|sessionStorage|indexedDB/.test(js), "the page never stores anything (the PIN stays in memory)");
  t.ok(!/setAttribute\(\s*["']style/.test(js), "the page never sets style attributes (CSP)");
  t.ok(!/console\.log/.test(js), "the page never logs (the QR link carries the PIN)");

  // ---- status ----
  const status = await call(port, "/api/host/status");
  t.equal(status.status, 200, "GET /api/host/status answers");
  t.deepEqual(Object.keys(status.json).sort(), ["app", "capture", "devices", "discovery", "firewall", "hostId", "hostName", "network", "pairing", "plainHttp", "platform", "platformName", "shell", "tls", "version"],
    "the status snapshot has the documented fields");
  t.ok(!status.text.includes(app.pairing.pin), "the status snapshot never carries the PIN");
  t.equal(status.json.shell, "macos-menubar", "status.shell comes from the shell option (WINDOCK_SHELL)");
  t.equal(status.json.hostId, HOST_ID, "status reports the host ID");
  t.equal(status.json.network.address, "192.168.1.34", "status reports the advertised address");
  t.equal(status.json.network.port, port, "status reports the port");
  t.equal(status.json.tls.code, tlsId.code, "status reports the security code");
  t.deepEqual(status.json.discovery, { bonjour: "off", udp: "off" }, "discovery is off when nothing started it");
  t.equal(status.json.firewall, "unknown", "firewall is unknown on the host side");
  t.ok(["open", "remainingMs", "closedReason", "generation"].every((k) => k in status.json.pairing), "status.pairing has open, remainingMs, closedReason, generation");
  t.ok(typeof status.json.version === "string", "status reports the package version");

  // ---- pairing body ----
  const open = await call(port, "/api/host/pairing");
  t.equal(open.json.open, true, "GET /api/host/pairing reports open");
  t.equal(open.json.pin, app.pairing.pin, "the open body carries the current PIN");
  t.equal(open.json.address, `192.168.1.34:${port}`, "the open body carries address:port");
  t.equal(open.json.securityCode, tlsId.code, "the open body carries the security code");
  t.ok(open.json.qr && open.json.qr.text.startsWith("windock://pair?v=1&"), "the open body carries the QR payload");
  t.ok(open.json.qr.text.includes(`&pin=${app.pairing.pin}&`) && open.json.qr.text.includes(`&addr=192.168.1.34:${port}&`), "the QR carries the PIN and address");
  t.equal(open.json.qr.text, buildPairingPayload({ hostId: HOST_ID, address: "192.168.1.34", port, fingerprint: tlsId.fingerprint, pin: app.pairing.pin, name: displayHostName() }),
    "the QR payload is built from the host ID, address, fingerprint, PIN and name");
  t.equal(open.json.qr.size, encodeQr(open.json.qr.text).size, "qr.size is the module count");
  t.equal(open.json.qr.path, qrSvgPath(encodeQr(open.json.qr.text).modules), "qr.path is the module path");

  const gen0 = app.pairing.generation;
  const pinBeforeStop = app.pairing.pin;
  const stopped = await call(port, "/api/host/pairing/close", { method: "POST", headers: JSON_CT, body: {} });
  t.equal(stopped.status, 200, "POST /api/host/pairing/close answers");
  t.deepEqual(stopped.json, { open: false, closedReason: "stopped", generation: gen0 + 1 }, "stop closes with reason stopped and a new generation");
  t.ok(app.pairing.pin !== pinBeforeStop, "Stop pairing rotates the PIN");
  const closedBody = await call(port, "/api/host/pairing");
  t.ok(!("pin" in closedBody.json) && !("qr" in closedBody.json), "a closed window's body carries no PIN or QR");
  t.ok(!closedBody.text.includes(app.pairing.pin) && !closedBody.text.includes(pinBeforeStop), "neither the old nor the new PIN appears while closed");
  t.equal(app.pairing.isOpen(), false, "GET /api/host/pairing never reopens");
  const pinAfterStop = app.pairing.pin;
  const reopened = await call(port, "/api/host/pairing/open", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: {} });
  t.equal(reopened.json.open, true, "POST /api/host/pairing/open opens pairing");
  t.equal(reopened.json.pin, pinAfterStop, "opening does not rotate the PIN");
  t.equal(reopened.json.generation, gen0 + 2, "opening bumps the generation");
  t.ok(reopened.json.remainingMs > PAIRING_WINDOW_MS - 1000, "opening grants a full 10 minutes");
  t.equal((await call(port, "/api/host/pairing/open", { method: "POST", headers: JSON_CT, body: "not json" })).status, 400, "a malformed JSON body is refused");

  // ---- live events, devices, labels, connected ----
  const events = [];
  let sseRes;
  let ended = false;
  let heartbeat = false;
  await new Promise((resolve) => {
    const r = request({ host: "127.0.0.1", port, path: "/api/host/events", agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      sseRes = res;
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        if (buf.includes(": heartbeat")) heartbeat = true;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (block.includes("event: status") && data) events.push(JSON.parse(data.slice(6)));
        }
        resolve();
      });
      res.on("end", () => { ended = true; });
      res.on("close", () => { ended = true; });
    });
    r.end();
  });
  t.equal(sseRes.statusCode, 200, "GET /api/host/events answers 200");
  t.ok(sseRes.headers["content-type"].startsWith("text/event-stream"), "events are server-sent events");
  t.equal(sseRes.headers["cache-control"], "no-store", "the event stream is not cached");
  t.equal(sseRes.headers["x-frame-options"], "DENY", "the event stream has the security headers");
  const waitFor = async (pred, label) => {
    for (let i = 0; i < 100; i += 1) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    t.ok(false, `timed out waiting for an event: ${label}`);
    return null;
  };
  const first = await waitFor(() => true, "initial snapshot");
  t.ok(first && first.app === "windock", "the stream starts with a status snapshot");
  t.ok(!events.some((e) => JSON.stringify(e).includes(app.pairing.pin)), "events never carry the PIN");
  const devGen0 = first.devices.generation;
  const pairGen0 = first.pairing.generation;

  const paired = await call(port, "/api/auth", { method: "POST", headers: JSON_CT, body: { pin: app.pairing.pin, deviceName: "iPhone" } });
  t.equal(paired.status, 200, "a phone pairs");
  const afterPair = await waitFor((e) => e.devices.generation > devGen0, "pair");
  t.ok(afterPair && afterPair.devices.count === 1, "pairing emits a status event with the new device count");
  t.ok(afterPair && afterPair.pairing.generation > pairGen0, "pairing bumps the pairing generation (new PIN, new QR)");

  const list1 = await call(port, "/api/devices");
  const dev = list1.json.devices[0];
  t.deepEqual(Object.keys(dev).sort(), ["connected", "id", "issuedAt", "label", "lastSeenAt", "name"], "GET /api/devices adds label and connected");
  t.equal(dev.label, null, "a new device has label null");
  t.equal(dev.connected, false, "a device without a dock socket is not connected");

  let g = afterPair.devices.generation;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { host: LAN, cookie: paired.cookie } });
  await new Promise((resolve, reject) => { ws.once("message", resolve); ws.once("error", reject); });
  const afterConnect = await waitFor((e) => e.devices.generation > g, "connect");
  t.ok(afterConnect, "a phone's dock socket connecting emits a status event");
  t.equal((await call(port, "/api/devices")).json.devices[0].connected, true, "a device with an open dock socket is connected");
  g = afterConnect.devices.generation;
  ws.close();
  const afterDisconnect = await waitFor((e) => e.devices.generation > g, "disconnect");
  t.ok(afterDisconnect, "the socket closing emits a status event");
  t.equal((await call(port, "/api/devices")).json.devices[0].connected, false, "the device is no longer connected");
  const loopWs = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise((resolve, reject) => { loopWs.once("message", resolve); loopWs.once("error", reject); });
  t.equal((await call(port, "/api/devices")).json.devices[0].connected, false, "a loopback dock socket marks no phone connected");
  loopWs.close();

  g = afterDisconnect.devices.generation;
  const renamed = await call(port, `/api/devices/${dev.id}`, { method: "PATCH", headers: JSON_CT, body: { label: "  Geri’s\u0000 iPhone  " } });
  t.equal(renamed.status, 200, "PATCH /api/devices/<id> answers");
  t.deepEqual(renamed.json, { ok: true, id: dev.id, label: "Geri’s iPhone" }, "the label is sanitized like a device name");
  t.ok(await waitFor((e) => e.devices.generation > g, "rename"), "renaming emits a status event");
  const list2 = (await call(port, "/api/devices")).json.devices[0];
  t.ok(list2.label === "Geri’s iPhone" && list2.name === "iPhone", "the label sits beside the phone's own name");
  t.equal((await call(port, `/api/devices/${dev.id}`, { method: "PATCH", headers: JSON_CT, body: { label: "y".repeat(80) } })).json.label, "y".repeat(40), "labels are cut to 40 characters");
  t.equal((await call(port, `/api/devices/${dev.id}`, { method: "PATCH", headers: JSON_CT, body: { label: "" } })).json.label, null, "an empty label clears it");
  await call(port, `/api/devices/${dev.id}`, { method: "PATCH", headers: JSON_CT, body: { label: "x" } });
  t.equal((await call(port, `/api/devices/${dev.id}`, { method: "PATCH", headers: JSON_CT, body: { label: null } })).json.label, null, "a null label clears it");
  t.equal((await call(port, `/api/devices/${dev.id}`, { method: "PATCH", headers: JSON_CT, body: { label: 5 } })).status, 400, "a non-string label is refused");
  t.equal((await call(port, `/api/devices/${dev.id}`, { method: "PATCH", headers: JSON_CT, body: {} })).status, 400, "a missing label is refused");
  t.equal((await call(port, `/api/devices/${dev.id}`, { method: "PATCH", body: '{"label":"x"}' })).status, 415, "PATCH without a JSON content type is refused");
  const unknown = await call(port, "/api/devices/0000000000000000", { method: "PATCH", headers: JSON_CT, body: { label: "x" } });
  t.equal(unknown.status, 404, "PATCH on an unknown device is 404");
  t.equal(unknown.json.error, "unknown device", "the 404 says unknown device");
  t.equal((await call(port, "/api/devices/zz", { method: "PATCH", headers: JSON_CT, body: { label: "x" } })).status, 404, "PATCH on a malformed id is 404");
  t.equal((await call(port, `/api/devices/${dev.id}`, { method: "PATCH", headers: { ...JSON_CT, cookie: paired.cookie }, host: LAN, body: { label: "x" } })).status, 403,
    "a phone session cannot rename devices");

  g = events.at(-1).devices.generation;
  t.equal((await call(port, `/api/devices/${dev.id}`, { method: "DELETE" })).status, 200, "the device is removed");
  const afterRevoke = await waitFor((e) => e.devices.generation > g, "revoke");
  t.ok(afterRevoke && afterRevoke.devices.count === 0, "revoking emits a status event");

  const pg = events.at(-1).pairing.generation;
  await call(port, "/api/host/pairing/close", { method: "POST", headers: JSON_CT, body: {} });
  t.ok(await waitFor((e) => e.pairing.generation > pg && e.pairing.closedReason === "stopped", "stop"), "stopping pairing emits a status event");

  await app.hub.close();
  await app.inputHub.close();
  await new Promise((r) => app.server.close(r)); // must not hang on the open stream
  await new Promise((r) => setTimeout(r, 50));
  t.ok(ended, "closing the server ends the event stream");
}

// ---- timeout keeps the PIN (D4), heartbeat, events on timeout ----
{
  let clock = 5_000_000;
  const pairing = createPairing({ pin: "135790", nextPin: () => "999999", now: () => clock });
  const { app, port } = await listen({ pairing, eventsHeartbeatMs: 40, eventsCheckMs: 30 });
  let text = "";
  let req;
  await new Promise((resolve) => {
    req = request({ host: "127.0.0.1", port, path: "/api/host/events", agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; resolve(); });
    });
    req.end();
  });
  await new Promise((r) => setTimeout(r, 120));
  t.ok(text.includes(": heartbeat"), "the event stream sends comment heartbeats");
  clock += PAIRING_WINDOW_MS + 1;
  await new Promise((r) => setTimeout(r, 120));
  t.ok(/"closedReason":"timeout"/.test(text), "a timeout reaches the event stream");
  const body = await call(port, "/api/host/pairing");
  t.deepEqual([body.json.open, body.json.closedReason], [false, "timeout"], "GET /api/host/pairing reports the timeout");
  t.equal(pairing.pin, "135790", "D4: a timeout keeps the PIN");
  const again = await call(port, "/api/host/pairing/open", { method: "POST", headers: JSON_CT, body: {} });
  t.equal(again.json.pin, "135790", "D4: reopening after a timeout shows the same PIN");
  req.destroy();
  await stop(app);
}

// ---- TLS off: no QR; no-address: open refuses; loopback trust off ----
{
  const { app, port } = await listen({ tls: null });
  const body = await call(port, "/api/host/pairing");
  t.equal(body.json.qr, null, "without TLS there is no QR");
  t.equal(body.json.securityCode, null, "without TLS there is no security code");
  t.equal((await call(port, "/api/host/status")).json.tls, null, "status.tls is null without TLS");
  app.pairing.close({ reason: "no-address" });
  const refused = await call(port, "/api/host/pairing/open", { method: "POST", headers: JSON_CT, body: {} });
  t.deepEqual([refused.json.open, refused.json.closedReason], [false, "no-address"], "without a network address pairing stays closed");
  await stop(app);
}
{
  const { app, port } = await listen({ trustLoopback: false });
  t.equal((await call(port, "/host")).status, 404, "/host is 404 when loopback trust is off");
  t.equal((await call(port, "/api/host/status")).status, 403, "/api/host/status is 403 when loopback trust is off");
  await stop(app);
}

// ---------------------------------------------------------------------------
// Page helpers (host-ui/host.js)
// ---------------------------------------------------------------------------
{
  const c = page.countdownState;
  t.deepEqual([c(600_000).strong, c(600_000).action], ["10 more minutes", "stop"], "10:00 left reads 10 more minutes with Stop pairing");
  t.equal(c(540_001).strong, "10 more minutes", "minutes round up");
  t.equal(c(120_000).strong, "2 more minutes", "2:00 left reads 2 more minutes");
  t.equal(c(119_999).strong, "1 more minute", "1–2 minutes left reads 1 more minute");
  t.equal(c(60_000).strong, "1 more minute", "exactly a minute left reads 1 more minute");
  t.deepEqual([c(59_999).lead, c(59_999).strong, c(59_999).action], ["Closes in ", "less than a minute", "keep"], "under a minute: Closes in less than a minute, Keep open");
  t.equal(c(0).kind, "closed", "0 left is closed");
  t.deepEqual(page.pinParts("482913"), { head: "482", tail: "913", label: "PIN 4 8 2 9 1 3" }, "the PIN shows as 3 + 3 and is spelled for screen readers");
  t.equal(page.securityCodeParts("6E21-B4F0-93AD").label, "Security code 6 E 2 1, B 4 F 0, 9 3 A D", "the security code is spelled for screen readers");
  t.equal(page.discoveryCaption({ bonjour: "on", udp: "on" }), page.COPY.netOk, "both on: phones find it");
  t.equal(page.discoveryCaption({ bonjour: "failed", udp: "on" }), page.COPY.netBonjourFailed, "Bonjour failed caption");
  t.equal(page.discoveryCaption({ bonjour: "off", udp: "on" }), page.COPY.netBonjourOff, "Bonjour off caption");
  t.equal(page.discoveryCaption({ bonjour: "on", udp: "failed" }), page.COPY.netUdpFailed, "UDP failed caption");
  t.equal(page.discoveryCaption({ bonjour: "failed", udp: "failed" }), page.COPY.netBothFailed, "both failed caption");
  t.equal(page.chipState({ firewall: "ok", network: { address: "1.2.3.4" } }), "running", "chip: running");
  t.equal(page.chipState({ firewall: "blocked", network: { address: "1.2.3.4" } }), "attention", "chip: firewall raises it");
  t.equal(page.chipState({ firewall: "unknown", network: { address: null } }), "attention", "chip: no address raises it");
  t.equal(page.effectiveFirewall("blocked", "unknown"), "blocked", "firewall: the shell's blocked wins over the host's unknown");
  t.equal(page.effectiveFirewall("ok", "blocked"), "ok", "firewall: the shell's ok wins over the host");
  t.equal(page.effectiveFirewall("unknown", "blocked"), "blocked", "firewall: a shell unknown falls back to the host");
  t.equal(page.effectiveFirewall(null, "unknown"), "unknown", "firewall: no shell report, host unknown");
  t.equal(page.effectiveFirewall("bogus", undefined), "unknown", "firewall: junk reads as unknown");
  t.equal(page.chipState({ firewall: "unknown", network: { address: "1.2.3.4" } }, "blocked"), "attention", "chip: a shell-reported block raises it");
  t.equal(page.chipState({ firewall: "unknown", network: { address: "1.2.3.4" } }, "ok"), "running", "chip: shell ok with host unknown stays running");
  const up = { firewall: "unknown", network: { address: "1.2.3.4" } };
  t.equal(page.problemBanner(up, "blocked"), "firewall", "problem banner: shell-reported firewall block");
  t.equal(page.problemBanner({ firewall: "blocked", network: { address: null } }), "firewall", "problem banner: firewall outranks no address");
  t.equal(page.problemBanner({ firewall: "ok", network: { address: null } }), "noaddr", "problem banner: no address");
  t.equal(page.problemBanner(up, "ok"), null, "problem banner: none");
  t.equal(page.firstRunBanner(up, "blocked"), "firewall", "first run shows the firewall banner");
  t.equal(page.firstRunBanner({ firewall: "blocked", network: { address: "1.2.3.4" } }), "firewall", "first run shows a host-reported firewall block");
  t.equal(page.firstRunBanner({ firewall: "ok", network: { address: null } }), null, "first run leaves no address to the pairing column");
  t.equal(page.firstRunBanner(null, "blocked"), null, "no first-run banner before a status arrives");
  t.equal(page.isAttached(true, { shell: null }), true, "attach mode: shell present, host not started by it");
  t.equal(page.isAttached(true, { shell: "macos-menubar" }), false, "not attached: the shell started the host");
  t.equal(page.isAttached(false, { shell: null }), false, "not attached: plain browser");
  t.equal(page.isAttached(true, null), false, "not attached until a status arrives");
  t.equal(page.COPY.noteAttached, "WinDock was started outside this app, so it can’t restart or stop it.", "attached note copy (section 14 note.attached)");
  const now = new Date(2026, 9, 21, 12, 0).getTime();
  const day = 86_400_000;
  const base = { id: "a", name: "iPhone", label: null, issuedAt: now - 9 * day, lastSeenAt: now - 9 * day, connected: false };
  t.deepEqual(page.deviceCaption({ ...base, connected: true, label: "Geri’s iPhone" }, now, "en-GB"), { connected: true, first: "Connected now", second: "iPhone" },
    "connected + renamed: Connected now · phone's own name");
  t.equal(page.deviceCaption({ ...base, lastSeenAt: now - 3600_000 }, now, "en-GB").first, "Seen today", "seen today");
  t.equal(page.deviceCaption({ ...base, lastSeenAt: now - day }, now, "en-GB").first, "Seen yesterday", "seen yesterday");
  t.equal(page.deviceCaption({ ...base, lastSeenAt: now - 5 * day }, now, "en-GB").first, "Seen 16 Oct", "older: Seen {date}");
  t.deepEqual(page.deviceCaption(base, now, "en-GB"), { connected: false, first: "Not seen since pairing", second: "Paired 12 Oct" }, "never seen after pairing");
  t.equal(page.shortDate(new Date(2025, 2, 3).getTime(), now, "en-GB"), "3 Mar 2025", "another year's date carries the year");
  const devs = [
    { id: "old", connected: false, lastSeenAt: 1, issuedAt: 1 },
    { id: "live", connected: true, lastSeenAt: 2, issuedAt: 2 },
    { id: "recent", connected: false, lastSeenAt: 5, issuedAt: 3 },
  ];
  t.deepEqual(page.sortDevices(devs).map((d) => d.id), ["live", "recent", "old"], "connected first, then most recently seen");
  t.deepEqual(page.stableOrder(["old", "live"], [...devs, { id: "new", connected: false, lastSeenAt: 9, issuedAt: 9 }].filter((d) => d.id !== "recent")), ["new", "old", "live"],
    "the visible order stays frozen; new phones go first, gone ones drop out");
  t.equal(page.labelToSend("   "), null, "an empty rename clears the label");
  t.equal(page.labelToSend(` ${"z".repeat(50)} `), "z".repeat(40), "a rename is trimmed and cut to 40");
  t.equal(page.browserNote(null, "macos"), page.COPY.noteTerminalMac, "browser from Terminal (macOS) note");
  t.equal(page.browserNote("windows-tray", "windows"), page.COPY.noteShellWin, "browser with a shell-started host (Windows) note");
  t.equal(page.detectOs(undefined, { platform: "Win32" }), "windows", "the OS comes from the browser without a shell");
  t.equal(page.detectOs("macos", { platform: "Win32" }), "macos", "the shell's OS wins");
  t.equal(page.otherAddressText({ address: "10.0.0.12", kind: "ethernet", interface: "en5" }), "10.0.0.12 (Ethernet)", "other address text");
  t.equal(page.displayName({ name: "iPhone", label: "Geri’s iPhone" }), "Geri’s iPhone", "a label wins over the phone's name");
}

await rm(scratch, { recursive: true, force: true });
process.stdout.write(`${t.assertions} assertions\n`);
t.done("host-ui verification passed");
