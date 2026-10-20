/** G6: PIN auth admits the right code, rejects wrong codes, and locks out brute force. */
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import {
  newPin,
  isValidPinShape,
  safeEqual,
  isLoopback,
  createLockout,
  createSessionStore,
  parseCookies,
  sessionCookie,
  tokenFromRequest,
  authorize,
  hashToken,
  MAX_FAILS,
  LOCK_MS,
  COOKIE_NAME,
  MAX_SESSIONS,
} from "../src/auth.js";
import { loadHostIdentity } from "../src/identity.js";
import { defaultDataDir, defaultConfigPath } from "../src/config.js";

const t = createChecker("auth");

// ---- PIN generation and shape ----
const pins = Array.from({ length: 400 }, () => newPin());
t.ok(pins.every((p) => /^\d{4}$/.test(p)), "every generated pin is exactly four digits");
t.ok(new Set(pins).size > 50, `generated pins vary (${new Set(pins).size} distinct of 400)`);
// Uniformity smoke test: a modulo-biased generator would starve some digits.
const digits = new Set(pins.join("").split(""));
t.equal(digits.size, 10, "all ten digits appear across generated pins");

for (const good of ["0000", "1234", "9999"]) t.ok(isValidPinShape(good), `${good} is a valid shape`);
for (const bad of ["", "12", "12345", "12a4", " 123", "1 23", null, 1234, "١٢٣٤"]) {
  t.ok(!isValidPinShape(bad), `invalid shape rejected: ${JSON.stringify(bad)}`);
}

// ---- constant-time comparison ----
t.ok(safeEqual("1234", "1234"), "identical pins compare equal");
t.ok(!safeEqual("1234", "1235"), "differing pins compare unequal");
t.ok(!safeEqual("1234", "123"), "different lengths compare unequal");
t.ok(!safeEqual("", "1234"), "empty input compares unequal");
t.ok(!safeEqual(null, "1234"), "null input compares unequal");
t.ok(!safeEqual(undefined, undefined) === false, "undefined pair does not throw");

// ---- loopback ----
for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.1.5"]) {
  t.ok(isLoopback(addr), `${addr} is loopback`);
}
for (const addr of ["192.168.1.40", "10.0.0.2", "", null, "::ffff:192.168.1.40", "8.8.8.8"]) {
  t.ok(!isLoopback(addr), `${addr} is not loopback`);
}

// ---- lockout ----
let clock = 1_000_000;
const lockout = createLockout({ now: () => clock });
const key = "192.168.1.55";
t.ok(!lockout.status(key).locked, "a fresh client is not locked");
for (let i = 1; i < MAX_FAILS; i += 1) {
  lockout.recordFailure(key);
  t.ok(!lockout.status(key).locked, `not locked after ${i} failure(s)`);
}
const final = lockout.recordFailure(key);
t.ok(final.locked, `locked after ${MAX_FAILS} failures`);
t.ok(lockout.status(key).locked, "status reports the lockout");
t.ok(lockout.status(key).retryInMs > 0, "lockout reports a positive retry delay");
t.ok(!lockout.status("192.168.1.99").locked, "lockout is per-client, not global");

clock += LOCK_MS + 1;
t.ok(!lockout.status(key).locked, "lockout expires after its window");

// A success must clear the counter so a legitimate user is not locked later.
const l2 = createLockout({ now: () => clock });
l2.recordFailure("a");
l2.recordFailure("a");
l2.recordSuccess("a");
for (let i = 1; i < MAX_FAILS; i += 1) l2.recordFailure("a");
t.ok(!l2.status("a").locked, "a successful pairing resets the failure count");

// ---- sessions ----
let sclock = 5_000_000;
const sessions = createSessionStore({ ttlMs: 1000, now: () => sclock });
const token = sessions.issue();
t.ok(typeof token === "string" && token.length >= 32, "issued token is long and opaque");
t.ok(sessions.verify(token), "issued token verifies");
t.ok(!sessions.verify("nope"), "unknown token does not verify");
t.ok(!sessions.verify(""), "empty token does not verify");
t.ok(!sessions.verify(null), "null token does not verify");
t.ok(sessions.issue() !== token, "each issued token is distinct");
sclock += 1001;
t.ok(!sessions.verify(token), "token stops verifying after its ttl");

const revocable = createSessionStore();
const rtok = revocable.issue();
t.ok(revocable.verify(rtok), "token verifies before revocation");
revocable.revokeAll();
t.ok(!revocable.verify(rtok), "regenerating the pin revokes every session");

// ---- cookies ----
const jar = parseCookies(`${COOKIE_NAME}=abc123; other=zzz`);
t.equal(jar[COOKIE_NAME], "abc123", "session cookie is parsed");
t.equal(jar.other, "zzz", "sibling cookies are parsed");
t.deepEqual(parseCookies(null), {}, "null cookie header yields an empty jar");
t.deepEqual(parseCookies("malformed"), {}, "malformed cookie header yields an empty jar");
// The real invariant is not the absence of a "__proto__" key — on a
// null-prototype jar that key is inert — but that nothing reaches
// Object.prototype and that the jar cannot inherit attacker-controlled values.
const hostileJar = parseCookies("__proto__=polluted; constructor=bad");
t.equal(Object.getPrototypeOf(hostileJar), null, "cookie jar has a null prototype");
t.equal({}.polluted, undefined, "Object.prototype is unpolluted after parsing");
t.equal({}.bad, undefined, "constructor key does not pollute Object.prototype");
t.equal(hostileJar.toString, undefined, "jar inherits nothing from Object.prototype");
// Positive control: the jar still stores ordinary cookies correctly.
t.equal(parseCookies("a=1").a, "1", "positive control: a normal cookie is still parsed");

const cookie = sessionCookie("tok");
t.ok(cookie.includes("HttpOnly"), "session cookie is HttpOnly");
t.ok(cookie.includes("SameSite=Lax"), "session cookie is SameSite=Lax");
t.ok(cookie.includes("Path=/"), "session cookie is path-scoped to the root");
t.ok(!cookie.includes("Secure"), "plain http cookie omits Secure");
t.ok(sessionCookie("tok", { secure: true }).includes("Secure"), "https cookie sets Secure");
t.equal(tokenFromRequest({ headers: { cookie: `${COOKIE_NAME}=xyz` } }), "xyz", "token is read from the request");
t.equal(tokenFromRequest({ headers: {} }), "", "absent cookie yields an empty token");

// ---- the authorize decision ----
const asess = createSessionStore();
const alock = createLockout();
const live = asess.issue();
const reqWith = (tok) => ({ headers: { cookie: tok ? `${COOKIE_NAME}=${tok}` : "" }, socket: {} });

t.ok(authorize({ req: reqWith(null), sessions: asess, lockout: alock, remote: "127.0.0.1" }).ok,
  "loopback is authorized without a session");
t.ok(authorize({ req: reqWith(live), sessions: asess, lockout: alock, remote: "192.168.1.5" }).ok,
  "a valid session is authorized from the LAN");

const denied = authorize({ req: reqWith("bogus"), sessions: asess, lockout: alock, remote: "192.168.1.5" });
t.ok(!denied.ok, "an invalid session is refused");
t.equal(denied.code, 401, "an invalid session yields 401");

const blocked = createLockout();
for (let i = 0; i < MAX_FAILS; i += 1) blocked.recordFailure("192.168.1.7");
const locked = authorize({ req: reqWith(live), sessions: asess, lockout: blocked, remote: "192.168.1.7" });
t.ok(!locked.ok, "a locked-out client is refused even with a valid session");
t.equal(locked.code, 429, "a locked-out client yields 429");

// ---- persistent sessions ----
const temp = await mkdtemp(join(tmpdir(), "windock-auth-"));
const posix = process.platform !== "win32";
try {
  const spath = join(temp, "nested", "data", "sessions.json");
  let pclock = 10_000_000;
  const store1 = createSessionStore({ ttlMs: 10_000, now: () => pclock, path: spath });
  t.equal(store1.size, 0, "a missing session file starts an empty store");
  const ptok = store1.issue();
  await store1.flush();
  const raw = await readFile(spath, "utf8");
  t.ok(!raw.includes(ptok), "the session file never contains the raw token");
  const file = JSON.parse(raw);
  t.equal(file.version, 1, "the session file is versioned");
  t.equal(file.sessions.length, 1, "the issued session is persisted");
  t.equal(file.sessions[0].hash, hashToken(ptok), "the file stores the token's SHA-256 hash");
  t.ok(/^[0-9a-f]{64}$/.test(file.sessions[0].hash), "the stored hash is 64 hex characters");
  t.equal(file.sessions[0].expiresAt, file.sessions[0].issuedAt + 10_000, "the stored expiry follows the ttl");
  if (posix) {
    t.equal((await stat(spath)).mode & 0o777, 0o600, "the session file is owner-only (0600)");
  }
  t.deepEqual((await readdir(join(temp, "nested", "data"))).filter((f) => f.endsWith(".tmp")), [],
    "no temp files are left behind after a write");

  // "Restart": a second store on the same path must accept the token.
  const store2 = createSessionStore({ ttlMs: 10_000, now: () => pclock, path: spath });
  t.ok(store2.verify(ptok), "a token survives a host restart");
  t.ok(!store2.verify(file.sessions[0].hash), "the stored hash itself is not a valid token");
  t.ok(!store2.verify("nope"), "an unknown token still fails after a restart");

  // Expired entries are dropped on load.
  pclock += 10_001;
  const store3 = createSessionStore({ ttlMs: 10_000, now: () => pclock, path: spath });
  t.equal(store3.size, 0, "expired sessions are dropped on load");
  t.ok(!store3.verify(ptok), "an expired token does not verify after a restart");
  await store3.flush();
  t.equal(JSON.parse(await readFile(spath, "utf8")).sessions.length, 0,
    "dropping expired entries on load rewrites the file");

  // Malformed entries are dropped; valid siblings survive.
  const goodTok = "good-token-value";
  await writeFile(spath, JSON.stringify({ version: 1, sessions: [
    { hash: hashToken(goodTok), issuedAt: pclock, expiresAt: pclock + 5000 },
    { hash: "not-a-hash", issuedAt: pclock, expiresAt: pclock + 5000 },
    { hash: hashToken("x"), issuedAt: "soon", expiresAt: pclock + 5000 },
    null,
    { hash: hashToken("y"), issuedAt: pclock - 9000, expiresAt: pclock - 1 },
  ] }));
  const mixed = createSessionStore({ ttlMs: 10_000, now: () => pclock, path: spath });
  t.equal(mixed.size, 1, "only the well-formed live entry is loaded");
  t.ok(mixed.verify(goodTok), "the valid entry beside malformed ones still verifies");
  await mixed.flush();

  // Corrupt and wrongly shaped files start empty and never throw.
  for (const [label, body] of [
    ["truncated JSON", '{"version":1,"sessions":[{"ha'],
    ["an array", "[]"],
    ["a wrong version", JSON.stringify({ version: 2, sessions: [] })],
    ["a non-array sessions field", JSON.stringify({ version: 1, sessions: {} })],
    ["an empty file", ""],
  ]) {
    await writeFile(spath, body);
    let store;
    try {
      store = createSessionStore({ ttlMs: 10_000, now: () => pclock, path: spath });
    } catch {
      store = null;
    }
    t.ok(store && store.size === 0, `a session file with ${label} yields an empty store`);
  }
  const recovered = createSessionStore({ ttlMs: 10_000, now: () => pclock, path: spath });
  const rtok2 = recovered.issue();
  await recovered.flush();
  t.ok(createSessionStore({ now: () => pclock, path: spath }).verify(rtok2),
    "pairing after a corrupt file replaces it with a valid one");

  // revokeAll persists.
  recovered.revokeAll();
  await recovered.flush();
  t.equal(JSON.parse(await readFile(spath, "utf8")).sessions.length, 0, "revokeAll empties the session file");
  t.ok(!createSessionStore({ now: () => pclock, path: spath }).verify(rtok2),
    "a revoked token stays revoked after a restart");

  // Concurrent issues are all persisted.
  const cpath = join(temp, "concurrent.json");
  const conc = createSessionStore({ now: () => pclock, path: cpath });
  const many = Array.from({ length: 20 }, () => conc.issue());
  await conc.flush();
  const reloaded = createSessionStore({ now: () => pclock, path: cpath });
  t.equal(reloaded.size, 20, "twenty back-to-back issues are all persisted");
  t.ok(many.every((tok) => reloaded.verify(tok)), "every concurrently issued token survives a restart");
  // Issues interleaved with in-flight writes must not lose entries either.
  const ipath = join(temp, "interleaved.json");
  const inter = createSessionStore({ now: () => pclock, path: ipath });
  const interTokens = [];
  for (let i = 0; i < 15; i += 1) {
    interTokens.push(inter.issue());
    await new Promise((r) => setImmediate(r));
  }
  await inter.flush();
  const interFile = JSON.parse(await readFile(ipath, "utf8"));
  t.equal(interFile.sessions.length, 15, "issues interleaved with in-flight writes are all persisted");
  const interReload = createSessionStore({ now: () => pclock, path: ipath });
  t.ok(interTokens.every((tok) => interReload.verify(tok)), "every interleaved token survives a restart");
  t.deepEqual((await readdir(temp)).filter((f) => f.endsWith(".tmp")), [],
    "serialized writes leave no temp files behind");

  // The persistent store is capped, dropping the oldest.
  const capPath = join(temp, "cap.json");
  let capClock = 1;
  const capped = createSessionStore({ now: () => capClock, path: capPath });
  const capTokens = [];
  for (let i = 0; i < MAX_SESSIONS + 5; i += 1) {
    capClock += 1;
    capTokens.push(capped.issue());
  }
  await capped.flush();
  t.equal(capped.size, MAX_SESSIONS, `the persistent store holds at most ${MAX_SESSIONS} sessions`);
  t.ok(!capped.verify(capTokens[0]), "the oldest session is dropped at the cap");
  t.ok(capped.verify(capTokens.at(-1)), "the newest session is kept at the cap");
  const capFile = JSON.parse(await readFile(capPath, "utf8"));
  t.equal(capFile.sessions.length, MAX_SESSIONS, "the session file is capped too");
  // A hand-inflated file is capped on load, keeping the newest entries.
  const big = Array.from({ length: MAX_SESSIONS + 10 }, (_, i) => ({
    hash: hashToken(`tok-${i}`), issuedAt: capClock + i, expiresAt: capClock + 1_000_000,
  }));
  await writeFile(capPath, JSON.stringify({ version: 1, sessions: big }));
  const capLoad = createSessionStore({ now: () => capClock, path: capPath });
  t.equal(capLoad.size, MAX_SESSIONS, "an oversized file is capped on load");
  t.ok(capLoad.verify(`tok-${MAX_SESSIONS + 9}`) && !capLoad.verify("tok-0"),
    "capping on load keeps the newest sessions");
  await capLoad.flush();

  // Without a path nothing touches disk.
  const memOnly = createSessionStore();
  memOnly.issue();
  t.equal(memOnly.path, null, "a store without a path is memory-only");

  // ---- host identity ----
  const hpath = join(temp, "id", "host.json");
  const id1 = await loadHostIdentity({ path: hpath });
  t.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id1.hostId),
    "the host id is a random (v4) UUID");
  const id2 = await loadHostIdentity({ path: hpath });
  t.equal(id2.hostId, id1.hostId, "the host id is stable across loads");
  if (posix) t.equal((await stat(hpath)).mode & 0o777, 0o600, "the host identity file is owner-only (0600)");
  await writeFile(hpath, "{not json");
  const id3 = await loadHostIdentity({ path: hpath });
  t.ok(id3.hostId !== id1.hostId && /^[0-9a-f-]{36}$/.test(id3.hostId), "a corrupt identity file is regenerated");
  t.equal(JSON.parse(await readFile(hpath, "utf8")).hostId, id3.hostId, "the regenerated identity is persisted");
  t.equal((await loadHostIdentity({ path: hpath })).hostId, id3.hostId, "the regenerated identity is then stable");
  await writeFile(hpath, JSON.stringify({ version: 1, hostId: "../../etc" }));
  t.ok((await loadHostIdentity({ path: hpath })).hostId !== "../../etc", "a malformed host id is replaced");
} finally {
  await rm(temp, { recursive: true, force: true });
}

// ---- data directory ----
t.equal(defaultDataDir({ os: "win32", env: { APPDATA: "C:\\Users\\Ann\\AppData\\Roaming" }, home: "C:\\Users\\Ann" }),
  "C:\\Users\\Ann\\AppData\\Roaming\\windock", "Windows data dir is %APPDATA%\\windock");
t.equal(defaultConfigPath({ os: "win32", env: { APPDATA: "C:\\Users\\Ann\\AppData\\Roaming" }, home: "C:\\Users\\Ann" }),
  "C:\\Users\\Ann\\AppData\\Roaming\\windock\\config.json", "Windows config path is unchanged");
t.equal(defaultDataDir({ os: "win32", env: {}, home: "C:\\Users\\Ann" }),
  "C:\\Users\\Ann\\.config\\windock", "Windows without APPDATA falls back to ~/.config/windock");
t.equal(defaultDataDir({ os: "darwin", env: {}, home: "/Users/ann" }),
  "/Users/ann/Library/Application Support/WinDock", "macOS data dir is ~/Library/Application Support/WinDock");
t.equal(defaultConfigPath({ os: "darwin", env: {}, home: "/Users/ann" }),
  "/Users/ann/Library/Application Support/WinDock/config.json", "macOS config lives in the data dir");
t.equal(defaultDataDir({ os: "linux", env: {}, home: "/home/ann" }),
  "/home/ann/.config/windock", "Linux data dir is ~/.config/windock");
t.equal(defaultConfigPath({ os: "linux", env: {}, home: "/home/ann" }),
  "/home/ann/.config/windock/config.json", "Linux config path is unchanged");
for (const os of ["win32", "darwin", "linux"]) {
  const custom = os === "win32" ? "D:\\dock\\my.json" : "/srv/dock/my.json";
  t.equal(defaultConfigPath({ os, env: { WINDOCK_CONFIG: custom, APPDATA: "X" }, home: "/h" }), custom,
    `${os}: WINDOCK_CONFIG overrides the config path`);
  t.equal(defaultDataDir({ os, env: { WINDOCK_CONFIG: custom }, home: "/h" }),
    os === "win32" ? "D:\\dock" : "/srv/dock", `${os}: WINDOCK_CONFIG's directory becomes the data dir`);
}

t.done("auth verification passed");
