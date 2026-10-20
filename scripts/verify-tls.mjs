/**
 * TLS transport: the self-signed certificate, its persistence and renewal,
 * and plain HTTP plus HTTPS (and ws plus wss) on one shared port.
 */
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { createChecker } from "./lib/assert.mjs";
import { createApp, readyBanner, start, transportOptions } from "../server.js";
import { createWindowsProvider } from "../src/platform/windows.js";
import { createConfigStore } from "../src/config.js";
import { replyFor, PROBE } from "../src/discovery.js";
import {
  loadOrCreateTlsIdentity,
  generateTlsIdentity,
  securityCode,
  KEY_FILE,
  CERT_FILE,
  CERT_YEARS,
} from "../src/tls.js";
import { formatInfo } from "./windock-info.mjs";

const t = createChecker("tls");
const PIN = "4321";
const DAY = 24 * 60 * 60 * 1000;
const colonForm = (hex) => hex.toUpperCase().match(/../g).join(":");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = await mkdtemp(join(tmpdir(), "windock-tls-"));

// ---- security code ----
t.equal(securityCode("3f2a9c01b7e4" + "0".repeat(52)), "3F2A-9C01-B7E4", "the code is the first 6 bytes, upper-case, in groups of 4");
t.ok(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(securityCode("ab".repeat(32))), "the code has the XXXX-XXXX-XXXX shape");
t.throws(() => securityCode("xyz"), "a non-hex fingerprint is refused");
t.throws(() => securityCode("abcd"), "a too-short fingerprint is refused");
t.throws(() => securityCode(null), "a missing fingerprint is refused");

// ---- the certificate ----
const HOST_ID = "0b6c7e0a-9a43-4c36-9b1c-2f0a3c5d6e7f";
const CN = `WinDock ${HOST_ID}`;
const dir = join(scratch, "data");
const before = Date.now();
const output = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => { output.push(String(chunk)); return realOut(chunk, ...rest); };
process.stderr.write = (chunk, ...rest) => { output.push(String(chunk)); return realErr(chunk, ...rest); };
const id = await loadOrCreateTlsIdentity({ dir, commonName: CN });
process.stdout.write = realOut;
process.stderr.write = realErr;
t.equal(output.join(""), "", "creating the identity logs nothing (no key material)");

const x509 = new X509Certificate(id.cert);
const key = createPrivateKey(id.key);
t.ok(id.key.startsWith("-----BEGIN PRIVATE KEY-----\n"), "the key is PEM PKCS#8");
t.equal(key.asymmetricKeyType, "ec", "the key is EC");
t.equal(key.asymmetricKeyDetails.namedCurve, "prime256v1", "the key is on P-256");
t.ok(x509.verify(x509.publicKey), "the certificate's self-signature verifies");
t.ok(x509.checkPrivateKey(key), "the key matches the certificate");
t.equal(x509.subject, `CN=${CN}`, "the subject is CN=WinDock <hostId>");
t.equal(x509.issuer, `CN=${CN}`, "the issuer equals the subject (self-signed)");
t.equal(x509.ca, false, "the certificate is not a CA");
t.deepEqual(x509.keyUsage, ["1.3.6.1.5.5.7.3.1"], "the extended key usage is serverAuth");
t.equal(x509.serialNumber.length, 32, "the serial is 16 bytes");
t.ok(parseInt(x509.serialNumber[0], 16) < 8, "the serial is positive");
const from = x509.validFromDate.getTime();
const to = x509.validToDate.getTime();
t.ok(Math.abs(from - (before - DAY)) < 5000, "validity starts one day before now");
const expectedTo = new Date(before); expectedTo.setUTCFullYear(expectedTo.getUTCFullYear() + CERT_YEARS);
t.ok(Math.abs(to - expectedTo.getTime()) < 5000, "validity ends 20 years from now");
t.ok(/^[0-9a-f]{64}$/.test(id.fingerprint), "the fingerprint is 64 lower-case hex digits");
t.equal(colonForm(id.fingerprint), x509.fingerprint256, "the fingerprint is the certificate's SHA-256");
t.equal(id.code, securityCode(id.fingerprint), "the identity carries its security code");

// GeneralizedTime from 2050 (RFC 5280).
const late = generateTlsIdentity({ commonName: "late", now: Date.UTC(2040, 5, 1, 12, 0, 0) });
const lateX = new X509Certificate(late.cert);
t.equal(lateX.validToDate.toISOString(), "2060-06-01T12:00:00.000Z", "a 2060 expiry is encoded and parsed (GeneralizedTime)");
t.equal(lateX.validFromDate.toISOString(), "2040-05-31T12:00:00.000Z", "a 2040 start is encoded and parsed (UTCTime)");
t.ok(lateX.verify(lateX.publicKey), "the GeneralizedTime certificate verifies");
const tbsTags = Buffer.from(lateX.raw);
t.ok(tbsTags.includes(Buffer.from("20600601120000Z", "ascii")), "the 2060 date uses the four-digit GeneralizedTime form");
t.ok(tbsTags.includes(Buffer.from("400531120000Z", "ascii")), "the 2040 date uses the two-digit UTCTime form");

// ---- persistence and modes ----
if (process.platform !== "win32") {
  t.equal((await stat(join(dir, KEY_FILE))).mode & 0o777, 0o600, "tls-key.pem is owner-only");
  t.equal((await stat(join(dir, CERT_FILE))).mode & 0o777, 0o600, "tls-cert.pem is owner-only");
}
t.equal(await readFile(join(dir, CERT_FILE), "utf8"), id.cert, "the certificate is persisted");
t.equal(await readFile(join(dir, KEY_FILE), "utf8"), id.key, "the key is persisted");
const again = await loadOrCreateTlsIdentity({ dir, commonName: CN });
t.equal(again.fingerprint, id.fingerprint, "a second load keeps the same fingerprint");
t.equal(again.key, id.key, "a second load keeps the same key");

async function regenerates(label, mutate, opts = {}) {
  const d = join(scratch, label.replace(/\W+/g, "-"));
  const first = await loadOrCreateTlsIdentity({ dir: d, commonName: CN });
  await mutate(d, first);
  const next = await loadOrCreateTlsIdentity({ dir: d, commonName: CN, ...opts });
  t.ok(next.fingerprint !== first.fingerprint, `${label}: a new certificate is made`);
  const nx = new X509Certificate(await readFile(join(d, CERT_FILE), "utf8"));
  t.ok(nx.checkPrivateKey(createPrivateKey(await readFile(join(d, KEY_FILE), "utf8"))), `${label}: the rewritten pair matches`);
  t.equal(colonForm(next.fingerprint), nx.fingerprint256, `${label}: the rewritten certificate is the returned one`);
  return next;
}
await regenerates("corrupt certificate", (d) => writeFile(join(d, CERT_FILE), "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n"));
await regenerates("corrupt key", (d) => writeFile(join(d, KEY_FILE), "garbage"));
await regenerates("missing key", (d) => rm(join(d, KEY_FILE)));
await regenerates("missing certificate", (d) => rm(join(d, CERT_FILE)));
await regenerates("mismatched key", (d) => writeFile(join(d, KEY_FILE), generateTlsIdentity({ commonName: "other" }).key));
const expiry = new X509Certificate(id.cert).validToDate.getTime();
await regenerates("expiring within 30 days", async () => {}, { now: () => expiry - 10 * DAY });
await regenerates("expired", async () => {}, { now: expiry + DAY });
const nearly = await loadOrCreateTlsIdentity({ dir, commonName: CN, now: expiry - 60 * DAY });
t.equal(nearly.fingerprint, id.fingerprint, "a certificate with more than 30 days left is kept");
const blocked = join(scratch, "a-file");
await writeFile(blocked, "not a directory");
const unwritable = await loadOrCreateTlsIdentity({ dir: blocked, commonName: CN });
t.ok(new X509Certificate(unwritable.cert).checkPrivateKey(createPrivateKey(unwritable.key)),
  "an unwritable data dir still yields a working identity (no throw)");
await t.rejects(() => loadOrCreateTlsIdentity({ commonName: CN }), "a missing dir is a programming error");

// ---- one port, both protocols ----
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

async function listen(options) {
  const app = await createApp({
    provider: provider(),
    configStore: createConfigStore({ path: join(scratch, `config-${Math.random()}.json`) }),
    pin: PIN,
    ...options,
  });
  await new Promise((r) => app.listener.listen(0, "127.0.0.1", r));
  return { app, port: app.listener.address().port };
}

async function stop(app) {
  await app.hub.close();
  await app.inputHub.close();
  app.listener.closeAllConnections();
  await new Promise((r) => app.listener.close(r));
}

/** One request over http or https; https records the presented certificate. */
function call(scheme, port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const request = scheme === "https" ? httpsRequest : httpRequest;
    const req = request({
      host: "127.0.0.1", port, path, method, agent: false, rejectUnauthorized: false,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    }, (res) => {
      const peer = scheme === "https" ? res.socket.getPeerCertificate() : null;
      const encrypted = Boolean(res.socket.encrypted);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, peer, encrypted });
      });
    });
    req.on("error", (error) => resolve({ status: 0, error }));
    req.setTimeout(3000, () => req.destroy(new Error("timed out")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const { app, port } = await listen({ tls: id, trustLoopback: false });
t.ok(app.server !== app.listener, "with TLS a front listener owns the port");
t.ok(app.secureServer, "with TLS an https server is created");
t.equal(app.server.constructor.name, "Server", "app.server is still the plain http.Server");

const plainHealth = await call("http", port, "/health");
const secureHealth = await call("https", port, "/health");
t.equal(plainHealth.status, 200, "/health answers plain HTTP on the shared port");
t.equal(secureHealth.status, 200, "/health answers HTTPS on the same port");
t.ok(!plainHealth.encrypted && secureHealth.encrypted, "one port served one plain and one encrypted response");
t.deepEqual(plainHealth.json?.tls, { fingerprint: id.fingerprint, code: id.code }, "/health over http carries the tls hint");
t.deepEqual(secureHealth.json?.tls, { fingerprint: id.fingerprint, code: id.code }, "/health over https carries the tls hint");
t.ok(Buffer.byteLength(secureHealth.text) <= 4096, `/health with tls fits 4096 bytes (${Buffer.byteLength(secureHealth.text)})`);
t.equal(secureHealth.peer?.fingerprint256, x509.fingerprint256, "the HTTPS handshake presents the pinned certificate");

// A raw TLS handshake presents the same certificate.
const peer = await new Promise((resolve) => {
  const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
    const cert = socket.getPeerCertificate();
    socket.end();
    resolve(cert);
  });
  socket.on("error", () => resolve(null));
});
t.equal(peer?.fingerprint256, x509.fingerprint256, "a TLS handshake's peer fingerprint matches the identity");
t.equal(peer?.subject?.CN, CN, "the handshake certificate names the host");

// Pipelined keep-alive requests survive the first-byte peek.
const pipelined = await new Promise((resolve) => {
  const socket = netConnect(port, "127.0.0.1", () => {
    socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  });
  let text = "";
  socket.on("data", (d) => { text += d; });
  socket.on("close", () => resolve(text));
  socket.on("error", () => resolve(text));
  setTimeout(() => { socket.destroy(); resolve(text); }, 3000);
});
t.equal((pipelined.match(/HTTP\/1\.1 200 OK/g) || []).length, 2, "two pipelined plain requests get two responses");

// Pairing: Secure cookie over https, none over http; origin checks see TLS.
const secureAuth = await call("https", port, "/api/auth", { method: "POST", body: { pin: PIN }, headers: { origin: `https://127.0.0.1:${port}` } });
t.equal(secureAuth.status, 200, "pairing over https with an https Origin succeeds");
const secureCookie = String(secureAuth.headers["set-cookie"]);
t.ok(/;\s*Secure/.test(secureCookie), "the https session cookie is Secure");
const plainAuth = await call("http", port, "/api/auth", { method: "POST", body: { pin: PIN }, headers: { origin: `http://127.0.0.1:${port}` } });
t.equal(plainAuth.status, 200, "pairing over plain http still works");
t.ok(!/Secure/.test(String(plainAuth.headers["set-cookie"])), "the plain http cookie is not Secure");
const crossScheme = await call("https", port, "/api/auth", { method: "POST", body: { pin: PIN }, headers: { origin: `http://127.0.0.1:${port}` } });
t.equal(crossScheme.status, 403, "over https, an http Origin is a different origin (req.socket.encrypted is set)");
const plainCookie = String(plainAuth.headers["set-cookie"]).split(";")[0];
const tlsCookie = secureCookie.split(";")[0];
t.equal((await call("https", port, "/api/state", { headers: { cookie: plainCookie } })).status, 200, "a cookie issued over http authenticates over https");
t.equal((await call("http", port, "/api/state", { headers: { cookie: tlsCookie } })).status, 200, "a cookie issued over https authenticates over http (same session store)");
t.equal((await call("https", port, "/api/state")).status, 401, "https without a cookie is refused");
t.equal((await call("https", port, "/api/state", { headers: { cookie: "windock_session=bogus" } })).status, 401, "https with a bogus cookie is refused");

// WebSocket upgrades on both protocols.
function firstMessage(url, headers, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, rejectUnauthorized: false });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* closing */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    ws.on("message", (d) => finish(String(d)));
    ws.on("error", () => finish(null));
    ws.on("unexpected-response", () => finish(null));
  });
}
const wss = await firstMessage(`wss://127.0.0.1:${port}`, { cookie: plainCookie, origin: `https://127.0.0.1:${port}` });
t.equal(JSON.parse(wss || "{}").type, "snapshot", "wss with a session cookie receives a snapshot");
const ws = await firstMessage(`ws://127.0.0.1:${port}`, { cookie: tlsCookie, origin: `http://127.0.0.1:${port}` });
t.equal(JSON.parse(ws || "{}").type, "snapshot", "ws on the same port receives a snapshot");
t.equal(await firstMessage(`wss://127.0.0.1:${port}`, {}), null, "wss without a session is refused");
t.equal(await firstMessage(`wss://127.0.0.1:${port}`, { cookie: plainCookie, origin: `http://127.0.0.1:${port}` }), null,
  "wss with an http Origin is refused as cross-origin");
const input = await firstMessage(`wss://127.0.0.1:${port}/input`, { cookie: plainCookie });
t.equal(JSON.parse(input || "{}").type, "error", "the /input channel is reachable over wss (and reports no touchpad here)");

// Loopback pairing info reports the secure endpoint and code.
const { app: local, port: localPort } = await listen({ tls: id, endpoint: "http://192.168.1.20:8620", secureEndpoint: "https://192.168.1.20:8620" });
const pairing = await call("https", localPort, "/api/pairing");
t.equal(pairing.status, 200, "loopback reads /api/pairing over https");
t.equal(pairing.json.secureEndpoint, "https://192.168.1.20:8620", "/api/pairing reports the secure endpoint");
t.equal(pairing.json.securityCode, id.code, "/api/pairing reports the security code");
t.equal(pairing.json.endpoint, "http://192.168.1.20:8620", "/api/pairing keeps the http endpoint");
await stop(local);

// Idle connections: closed after the first-byte timeout, never leaked.
const { app: idleApp, port: idlePort } = await listen({ tls: id, firstByteTimeoutMs: 200 });
const idleStarted = Date.now();
const idleClosed = await new Promise((resolve) => {
  const socket = netConnect(idlePort, "127.0.0.1");
  socket.on("error", () => {});
  socket.on("close", () => resolve(Date.now() - idleStarted));
  setTimeout(() => { socket.destroy(); resolve(-1); }, 3000);
});
t.ok(idleClosed >= 150 && idleClosed < 2000, `a silent connection is closed after the first-byte timeout (${idleClosed} ms)`);
await new Promise((resolve) => {
  const socket = netConnect(idlePort, "127.0.0.1", () => socket.destroy());
  socket.on("close", resolve);
});
await sleep(50);
t.equal(idleApp.listener.pendingCount, 0, "a connection that closes before sending a byte is forgotten");
await new Promise((resolve) => {
  const socket = netConnect(idlePort, "127.0.0.1", () => socket.end());
  socket.on("error", () => {});
  socket.on("close", resolve);
});
await sleep(50);
t.equal(idleApp.listener.pendingCount, 0, "a connection that half-closes before sending a byte is dropped");
t.equal((await call("https", idlePort, "/health")).status, 200, "the listener still serves after dropped connections");
await stop(idleApp);

// HTTP header timeouts still apply to connections handed over by the listener.
const slow = await createApp({ provider: provider(), configStore: createConfigStore({ path: join(scratch, "slow.json") }), tls: id });
slow.server.headersTimeout = 300;
slow.server.requestTimeout = 300;
slow.server.connectionsCheckingInterval = 100;
await new Promise((r) => slow.listener.listen(0, "127.0.0.1", r));
const slowReply = await new Promise((resolve) => {
  const socket = netConnect(slow.listener.address().port, "127.0.0.1", () => socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n"));
  let text = "";
  socket.on("data", (d) => { text += d; });
  socket.on("error", () => {});
  socket.on("close", () => resolve(text));
  setTimeout(() => { socket.destroy(); resolve("still open"); }, 3000);
});
t.ok(slowReply.startsWith("HTTP/1.1 408"), `an incomplete plain request still times out (got ${JSON.stringify(slowReply.slice(0, 20))})`);
await stop(slow);

// Plain HTTP disabled: https works, a plain connection is closed.
const { app: strict, port: strictPort } = await listen({ tls: id, plainHttp: false });
const refused = await call("http", strictPort, "/health");
t.equal(refused.status, 0, "with plain HTTP off, a plain request gets no response");
t.equal((await call("https", strictPort, "/health")).status, 200, "with plain HTTP off, https still works");
await stop(strict);

// No TLS: the listener is the http server and /health says so.
const { app: plain, port: plainPort } = await listen({});
t.equal(plain.listener, plain.server, "without TLS the listener is the http server");
t.equal(plain.secureServer, null, "without TLS there is no https server");
t.equal((await call("http", plainPort, "/health")).json.tls, null, "/health reports tls: null without TLS");
t.equal((await call("https", plainPort, "/health")).status, 0, "without TLS, https is not served");
await stop(plain);
await t.rejects(() => createApp({ provider: provider(), plainHttp: false }), "plainHttp: false without tls is refused");

await stop(app);

// ---- start(), environment and banner ----
t.deepEqual(transportOptions({}), { tls: true, plainHttp: true }, "TLS and plain HTTP are both on by default");
t.deepEqual(transportOptions({ WINDOCK_TLS: "0" }), { tls: false, plainHttp: true }, "WINDOCK_TLS=0 turns TLS off");
t.deepEqual(transportOptions({ WINDOCK_PLAIN_HTTP: "0" }), { tls: true, plainHttp: false }, "WINDOCK_PLAIN_HTTP=0 turns plain HTTP off");
t.throws(() => transportOptions({ WINDOCK_TLS: "0", WINDOCK_PLAIN_HTTP: "0" }), "turning both off is refused");

const env = { WINDOCK_CONFIG: join(scratch, "host", "config.json") };
const savedConfig = process.env.WINDOCK_CONFIG;
process.env.WINDOCK_CONFIG = env.WINDOCK_CONFIG; // the default config store reads it
async function startStop(extraEnv) {
  const started = await start({ port: 0, env: { ...env, ...extraEnv }, discoveryPort: 0 });
  const result = { ...started };
  const health = await call(started.tls ? "https" : "http", started.port, "/health");
  result.health = health.json;
  await started.discovery.close();
  await stop(started);
  return result;
}
const s1 = await startStop({});
t.ok(s1.endpoint.startsWith("http://") && s1.secureEndpoint.startsWith("https://"), "start() advertises http and https endpoints");
t.equal(new URL(s1.endpoint).port, new URL(s1.secureEndpoint).port, "both endpoints share one port");
t.ok(replyFor(PROBE, s1.state.endpoint).startsWith("windock:here:v1:http://"), "the UDP v1 reply keeps the http endpoint");
t.equal(s1.health.tls.fingerprint, s1.tls.fingerprint, "/health reports the started host's fingerprint");
const hostJson = JSON.parse(await readFile(join(scratch, "host", "host.json"), "utf8"));
t.equal(new X509Certificate(s1.tls.cert).subject, `CN=WinDock ${hostJson.hostId}`, "the certificate is named after the host ID");
const s2 = await startStop({});
t.equal(s2.tls.fingerprint, s1.tls.fingerprint, "a restarted host keeps its fingerprint");
const s3 = await startStop({ WINDOCK_TLS: "0" });
t.ok(s3.tls === null && s3.secureEndpoint === null && s3.health.tls === null, "WINDOCK_TLS=0 starts plain HTTP only");
const s4 = await startStop({ WINDOCK_PLAIN_HTTP: "0" });
t.ok(s4.endpoint.startsWith("https://"), "with plain HTTP off the advertised endpoint is https");
await t.rejects(() => start({ port: 0, env: { ...env, WINDOCK_TLS: "0", WINDOCK_PLAIN_HTTP: "0" }, discoveryPort: 0 }),
  "start() refuses plain HTTP off without TLS");
if (savedConfig === undefined) delete process.env.WINDOCK_CONFIG;
else process.env.WINDOCK_CONFIG = savedConfig;

const base = readyBanner({ providerName: "Windows", endpoint: "http://192.168.1.20:8620", pin: "0427" });
const banner = readyBanner({
  providerName: "Windows", endpoint: "http://192.168.1.20:8620", pin: "0427",
  secureEndpoint: "https://192.168.1.20:8620", securityCode: "3F2A-9C01-B7E4",
});
t.equal(banner, `${base}  secure:   https://192.168.1.20:8620  code 3F2A-9C01-B7E4\n`, "the TLS banner appends one secure line to the unchanged banner");
t.equal((banner.match(/open:\s*(\S+)/) || [])[1], "http://192.168.1.20:8620", "the tray's open: pattern still finds the http URL");
t.equal((banner.match(/PIN:\s*(\d{4})/) || [])[1], "0427", "the tray's PIN pattern still matches");
t.equal(
  formatInfo({ hostName: "M", endpoint: "http://192.168.1.20:8620", pin: "0427", secureEndpoint: "https://192.168.1.20:8620", securityCode: "3F2A-9C01-B7E4" }),
  "WinDock is running on M\n  Address: http://192.168.1.20:8620\n  Secure:  https://192.168.1.20:8620\n  PIN:     0427\n  Code:    3F2A-9C01-B7E4\nEnter this address and PIN in the WinDock app on your phone.\n",
  "npm run info prints the secure address and security code",
);

await rm(scratch, { recursive: true, force: true });
t.done("tls verification passed");
