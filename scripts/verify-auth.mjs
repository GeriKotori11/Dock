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
  isLoopbackHost,
  isTrustedLoopback,
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
  PIN_LENGTH,
  PAIRING_WINDOW_MS,
  GLOBAL_FAIL_BUDGET,
  LAST_SEEN_INTERVAL_MS,
  createPairing,
  sanitizeDeviceName,
} from "../src/auth.js";
import { loadHostIdentity } from "../src/identity.js";
import { defaultDataDir, defaultConfigPath } from "../src/config.js";

const t = createChecker("auth");

// ---- PIN generation and shape ----
const pins = Array.from({ length: 400 }, () => newPin());
t.equal(PIN_LENGTH, 6, "pairing codes are six digits");
t.ok(pins.every((p) => /^\d{6}$/.test(p)), "every generated pin is exactly six digits");
t.ok(new Set(pins).size > 50, `generated pins vary (${new Set(pins).size} distinct of 400)`);
// Uniformity smoke test: a modulo-biased generator would starve some digits.
const digits = new Set(pins.join("").split(""));
t.equal(digits.size, 10, "all ten digits appear across generated pins");

for (const good of ["000000", "123456", "999999"]) t.ok(isValidPinShape(good), `${good} is a valid shape`);
for (const bad of ["", "12", "1234", "12345", "1234567", "12a456", " 12345", "123 45", null, 123456, "١٢٣٤٥٦"]) {
  t.ok(!isValidPinShape(bad), `invalid shape rejected: ${JSON.stringify(bad)}`);
}

// ---- constant-time comparison ----
t.ok(safeEqual("1234", "1234"), "identical pins compare equal");
t.ok(!safeEqual("1234", "1235"), "differing pins compare unequal");
t.ok(!safeEqual("1234", "123"), "different lengths compare unequal");
t.ok(!safeEqual("", "1234"), "empty input compares unequal");
t.ok(!safeEqual(null, "1234"), "null input compares unequal");
t.ok(!safeEqual(undefined, undefined) === false, "undefined pair does not throw");

// ---- pairing window, single-use codes and the global failure budget ----
{
  let pclock = 50_000_000;
  const codes = ["111111", "222222", "333333", "444444"];
  const pairing = createPairing({ pin: "000001", nextPin: () => codes.shift(), now: () => pclock });
  t.equal(PAIRING_WINDOW_MS, 10 * 60 * 1000, "the pairing window is ten minutes");
  t.equal(GLOBAL_FAIL_BUDGET, 10, "the global failure budget is ten");
  t.ok(pairing.isOpen(), "pairing is open when the host starts");
  t.equal(pairing.remainingMs(), PAIRING_WINDOW_MS, "the first window is a full ten minutes");
  t.ok(pairing.matches("000001") && !pairing.matches("000002"), "the current code matches; another does not");
  pclock += PAIRING_WINDOW_MS - 1;
  t.ok(pairing.isOpen(), "pairing is still open just before the window ends");
  pclock += 1;
  t.ok(!pairing.isOpen(), "pairing closes when the window ends");
  t.equal(pairing.remainingMs(), 0, "a closed window has no time left");
  t.equal(pairing.reopen(), PAIRING_WINDOW_MS, "reopen grants a full window");
  t.ok(pairing.isOpen(), "reopen opens pairing again");
  pclock += 5 * 60 * 1000;
  pairing.reopen();
  t.equal(pairing.remainingMs(), PAIRING_WINDOW_MS, "reopening an open window extends it to a full ten minutes");
  t.equal(pairing.pin, "000001", "the code does not change on reopen");
  pairing.recordSuccess();
  t.equal(pairing.pin, "111111", "a successful pairing rotates the code");
  t.ok(!pairing.matches("000001"), "a used code no longer matches");
  t.ok(pairing.isOpen(), "a successful pairing leaves the window open");
  for (let i = 1; i < GLOBAL_FAIL_BUDGET; i += 1) {
    t.ok(!pairing.recordFailure().exhausted, `failure ${i} of ${GLOBAL_FAIL_BUDGET} does not spend the budget`);
  }
  t.equal(pairing.failures, GLOBAL_FAIL_BUDGET - 1, "failures are counted across the window");
  t.equal(pairing.pin, "111111", "the code survives failures below the budget");
  t.ok(pairing.recordFailure().exhausted, `failure ${GLOBAL_FAIL_BUDGET} spends the budget`);
  t.equal(pairing.pin, "222222", "spending the budget rotates the code");
  t.ok(!pairing.isOpen(), "spending the budget closes the window");
  pclock += PAIRING_WINDOW_MS * 3;
  t.ok(!pairing.isOpen(), "a spent budget keeps pairing closed; time alone does not reopen it");
  pairing.reopen();
  t.ok(pairing.isOpen() && pairing.failures === 0, "a local reopen opens pairing and resets the budget");
  t.ok(!pairing.recordFailure().exhausted, "after a reopen one failure does not spend the budget");
  const defaults = createPairing();
  t.ok(/^\d{6}$/.test(defaults.pin), "a default pairing starts with a random six-digit code");
  const before = defaults.pin;
  let rotatedDiffers = false;
  for (let i = 0; i < 5 && !rotatedDiffers; i += 1) {
    defaults.recordSuccess();
    rotatedDiffers = defaults.pin !== before && /^\d{6}$/.test(defaults.pin);
  }
  t.ok(rotatedDiffers, "default rotation makes a new random six-digit code");
}

// ---- device names ----
t.equal(sanitizeDeviceName("iPhone"), "iPhone", "a plain device name is kept");
t.equal(sanitizeDeviceName("  Ann's\u0000 Pixel\n\t "), "Ann's Pixel", "control characters are stripped and the name trimmed");
t.equal(sanitizeDeviceName("evil\u202Eman\u2028x"), "evilmanx", "bidi overrides and line separators are stripped");
t.equal(sanitizeDeviceName("x".repeat(100)), "x".repeat(60), "names are capped at 60 characters");
t.equal([...sanitizeDeviceName("😀".repeat(70))].length, 60, "the cap counts characters, not UTF-16 units");
for (const bad of [undefined, null, "", "   ", "\u0001\u0002", 42, { name: "x" }, ["iPhone"]]) {
  t.equal(sanitizeDeviceName(bad), "Phone", `device name ${JSON.stringify(bad)} defaults to Phone`);
}

// ---- loopback ----
for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.1.5"]) {
  t.ok(isLoopback(addr), `${addr} is loopback`);
}
for (const addr of ["192.168.1.40", "10.0.0.2", "", null, "::ffff:192.168.1.40", "8.8.8.8"]) {
  t.ok(!isLoopback(addr), `${addr} is not loopback`);
}

// ---- loopback Host header (DNS-rebinding defence) ----
for (const host of [
  "127.0.0.1:8620", "127.0.0.1", "localhost:8620", "localhost", "LOCALHOST:1", "[::1]:8620", "[::1]",
  "127.1.2.3:65535", "127.255.255.255",
]) {
  t.ok(isLoopbackHost(host), `Host ${host} is a loopback literal`);
}
for (const host of [
  "evil.example:8620", "evil.example", "127.evil.com", "127.evil.com:8620", "localhost.evil.com",
  "localhost.evil.com:8620", "127.0.0.1.evil.com", "evil.localhost", "127.0.0.256", "127.0.0", "127.0.0.1.1",
  "128.0.0.1", "192.168.1.40:8620", "::1", "[::2]:8620", "[::1].evil.com", "[::1", "localhost:", "localhost:abc",
  "localhost:99999", "127.0.0.1:8620:1", "localhost:8620@evil.example", " localhost", "localhost ", "", null,
  undefined, 127, ["localhost"],
]) {
  t.ok(!isLoopbackHost(host), `Host ${JSON.stringify(host)} is not a loopback literal`);
}
const hostReq = (host, address = "127.0.0.1") => ({ headers: host === undefined ? {} : { host }, socket: { remoteAddress: address } });
t.ok(isTrustedLoopback(hostReq("127.0.0.1:8620")), "loopback socket + loopback Host is trusted");
t.ok(!isTrustedLoopback(hostReq("evil.example:8620")), "loopback socket + rebinding Host is not trusted");
t.ok(!isTrustedLoopback(hostReq(undefined)), "loopback socket without a Host header is not trusted");
t.ok(!isTrustedLoopback(hostReq("127.0.0.1:8620", "192.168.1.5")), "a LAN socket claiming a loopback Host is not trusted");

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

// ---- paired devices ----
{
  let dclock = 7_000_000;
  const store = createSessionStore({ now: () => dclock });
  const a = store.issue({ name: "iPhone" });
  dclock += 10;
  const b = store.issue({ name: "Android\u0007 phone" });
  dclock += 10;
  const c = store.issue();
  const list = store.list();
  t.deepEqual(list.map((d) => d.name), ["Phone", "Android phone", "iPhone"], "devices are listed newest first with sanitized names");
  t.ok(list.every((d) => /^[0-9a-f]{16}$/.test(d.id)), "every device has a 16-hex public id");
  t.equal(new Set(list.map((d) => d.id)).size, 3, "device ids are distinct");
  t.deepEqual(Object.keys(list[0]).sort(), ["id", "issuedAt", "label", "lastSeenAt", "name"], "a device exposes only id, name, label, issuedAt and lastSeenAt");
  t.ok(list.every((d) => d.label === null), "a freshly paired device has no host-side label");
  t.ok(list.every((d) => d.id !== hashToken(a).slice(0, 16) && d.id !== hashToken(b).slice(0, 16) && d.id !== hashToken(c).slice(0, 16)),
    "device ids are not derived from token hashes");
  t.ok(!JSON.stringify(list).includes(hashToken(a)), "the device list never carries a session hash");
  t.equal(list[2].lastSeenAt, list[2].issuedAt, "a new device was last seen when it paired");
  const same = createSessionStore({ now: () => dclock });
  same.issue({ name: "first" });
  same.issue({ name: "second" });
  t.deepEqual(same.list().map((d) => d.name), ["second", "first"], "devices paired in the same millisecond list in reverse issue order");

  // lastSeenAt is refreshed by verify at most once an hour.
  const iphone = () => store.list().find((d) => d.name === "iPhone");
  const pairedAt = iphone().issuedAt;
  dclock += LAST_SEEN_INTERVAL_MS - 100;
  t.ok(store.verify(a), "the device's token verifies");
  t.equal(iphone().lastSeenAt, pairedAt, "lastSeenAt is not rewritten within the hour");
  dclock += 100;
  store.verify(a);
  t.equal(iphone().lastSeenAt, dclock, "lastSeenAt moves once an hour has passed");
  const seen = dclock;
  dclock += 60_000;
  store.verify(a);
  t.equal(iphone().lastSeenAt, seen, "a second verify within the hour leaves lastSeenAt alone");

  // Revocation.
  const target = store.list().find((d) => d.name === "Android phone");
  t.equal(store.revoke(target.id), hashToken(b), "revoke returns the revoked session's hash");
  t.ok(!store.verify(b), "a revoked device's token stops verifying");
  t.ok(store.verify(a) && store.verify(c), "other devices stay paired");
  t.equal(store.revoke(target.id), null, "revoking an unknown id returns null");
  t.equal(store.revoke("0000000000000000"), null, "a made-up id revokes nothing");
  t.equal(store.list().length, 2, "the revoked device leaves the list");
  const all = store.revokeAll();
  t.equal(all.length, 2, "revokeAll returns every revoked hash");
  t.ok(!store.verify(a) && !store.verify(c), "revokeAll unpairs every device");
  t.deepEqual(store.list(), [], "no devices remain after revokeAll");
}

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
{
  const s = createSessionStore();
  const tok = s.issue();
  const grant = authorize({ req: { headers: { cookie: `${COOKIE_NAME}=${tok}`, host: "192.168.1.20:8620" }, socket: {} },
    sessions: s, lockout: createLockout(), remote: "192.168.1.5" });
  t.equal(grant.hash, hashToken(tok), "a session grant names its session hash");
  const local = authorize({ req: { headers: { host: "127.0.0.1:8620" }, socket: {} }, sessions: s, lockout: createLockout(), remote: "127.0.0.1" });
  t.equal(local.hash, undefined, "a loopback grant has no session hash");
}
const asess = createSessionStore();
const alock = createLockout();
const live = asess.issue();
const reqWith = (tok, host = "192.168.1.20:8620") =>
  ({ headers: { cookie: tok ? `${COOKIE_NAME}=${tok}` : "", host }, socket: {} });

for (const host of ["127.0.0.1:8620", "localhost:8620", "[::1]:8620"]) {
  const via = authorize({ req: reqWith(null, host), sessions: asess, lockout: alock, remote: "127.0.0.1" });
  t.ok(via.ok && via.via === "loopback", `loopback with Host ${host} is authorized without a session`);
}
t.ok(authorize({ req: reqWith(null, "[::1]:8620"), sessions: asess, lockout: alock, remote: "::1" }).ok,
  "an IPv6 loopback socket with Host [::1] is authorized");
const rebound = authorize({ req: reqWith(null, "evil.example:8620"), sessions: asess, lockout: alock, remote: "127.0.0.1" });
t.ok(!rebound.ok, "loopback with a rebinding Host and no session is refused");
t.equal(rebound.code, 401, "loopback with a rebinding Host yields 401");
const reboundSession = authorize({ req: reqWith(live, "evil.example:8620"), sessions: asess, lockout: alock, remote: "127.0.0.1" });
t.ok(reboundSession.ok && reboundSession.via === "session", "loopback with a rebinding Host still honours a valid session");
t.ok(!authorize({ req: reqWith(null, "127.0.0.1:8620"), sessions: asess, lockout: alock, remote: "127.0.0.1", trustLoopback: false }).ok,
  "trustLoopback: false refuses even a loopback Host");
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

  // Files written before device management migrate without losing sessions.
  const legacyPath = join(temp, "legacy.json");
  const legacyTokens = ["legacy-one", "legacy-two", "legacy-three"];
  await writeFile(legacyPath, JSON.stringify({ version: 1, sessions: legacyTokens.map((tok, i) => ({
    hash: hashToken(tok), issuedAt: pclock - 3000 + i, expiresAt: pclock + 50_000,
  })) }));
  const legacy = createSessionStore({ now: () => pclock, path: legacyPath });
  t.equal(legacy.size, 3, "every pre-upgrade session is loaded");
  t.ok(legacyTokens.every((tok) => legacy.verify(tok)), "every pre-upgrade token still verifies");
  const migrated = legacy.list();
  t.ok(migrated.every((d) => /^[0-9a-f]{16}$/.test(d.id)), "pre-upgrade sessions are given ids");
  t.ok(migrated.every((d) => d.name === "Phone"), "pre-upgrade sessions are named Phone");
  t.ok(migrated.every((d) => d.lastSeenAt === d.issuedAt), "pre-upgrade sessions were last seen when issued");
  await legacy.flush();
  const migratedFile = JSON.parse(await readFile(legacyPath, "utf8"));
  t.equal(migratedFile.version, 1, "the migrated file keeps version 1 (older hosts can still read it)");
  t.equal(migratedFile.sessions.length, 3, "the migrated file keeps every session");
  t.ok(migratedFile.sessions.every((e) => /^[0-9a-f]{16}$/.test(e.id) && e.name === "Phone" && e.lastSeenAt === e.issuedAt),
    "the migration is written back");
  const reloadedLegacy = createSessionStore({ now: () => pclock, path: legacyPath });
  t.deepEqual(reloadedLegacy.list().map((d) => d.id), migrated.map((d) => d.id), "migrated ids are stable across restarts");
  t.ok(legacyTokens.every((tok) => reloadedLegacy.verify(tok)), "migrated tokens survive another restart");

  // Device fields persist; a revoke persists; lastSeenAt persists when it moves.
  const devPath = join(temp, "devices.json");
  let dpclock = pclock;
  const devStore = createSessionStore({ now: () => dpclock, path: devPath });
  const devA = devStore.issue({ name: "iPad" });
  const devB = devStore.issue({ name: "Browser" });
  await devStore.flush();
  const devFile = JSON.parse(await readFile(devPath, "utf8"));
  t.deepEqual(devFile.sessions.map((e) => e.name), ["iPad", "Browser"], "device names are persisted");
  t.ok(!JSON.stringify(devFile).includes(devA), "the device file never contains a raw token");
  dpclock += LAST_SEEN_INTERVAL_MS;
  devStore.verify(devA);
  await devStore.flush();
  t.equal(JSON.parse(await readFile(devPath, "utf8")).sessions[0].lastSeenAt, dpclock, "a moved lastSeenAt is persisted");
  const writesBefore = (await stat(devPath)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 20; i += 1) devStore.verify(devA);
  await devStore.flush();
  t.equal((await stat(devPath)).mtimeMs, writesBefore, "verifies within the hour do not rewrite the session file");
  const ipad = devStore.list().find((d) => d.name === "iPad");
  devStore.revoke(ipad.id);
  await devStore.flush();
  const afterRevoke = createSessionStore({ now: () => dpclock, path: devPath });
  t.ok(!afterRevoke.verify(devA) && afterRevoke.verify(devB), "a revoked device stays revoked after a restart; others stay paired");
  t.deepEqual(afterRevoke.list().map((d) => d.name), ["Browser"], "the restarted store lists only the remaining device");

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
