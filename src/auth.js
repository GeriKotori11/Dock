/**
 * Pairing and session auth.
 *
 * A 4-digit PIN is shown on the host; a device posts it once and receives an
 * opaque session token. PIN comparison is constant-time, failures are counted
 * per client, and a client is locked out after a threshold. Loopback is trusted
 * so the tray app on the host itself does not have to pair with the machine the
 * user is already sitting at, but only when the Host header also names a
 * loopback literal: a DNS-rebinding page reaches the host from 127.0.0.1 too,
 * yet its browser always sends the attacker's hostname as Host.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fsutil.js";

export const PIN_LENGTH = 4;
export const MAX_FAILS = 5;
export const LOCK_MS = 60_000;
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
export const MAX_SESSIONS = 64;
export const COOKIE_NAME = "windock_session";

/** Cryptographically uniform PIN; avoids the modulo bias of randomBytes % 10. */
export function newPin(length = PIN_LENGTH) {
  let pin = "";
  for (let i = 0; i < length; i += 1) pin += String(randomInt(0, 10));
  return pin;
}

export function isValidPinShape(value, length = PIN_LENGTH) {
  return typeof value === "string" && new RegExp(`^\\d{${length}}$`).test(value);
}

/** Constant-time compare that never leaks length through early return. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not distinguish length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function isLoopback(address) {
  if (typeof address !== "string" || !address) return false;
  const addr = address.startsWith("::ffff:") ? address.slice(7) : address;
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("127.");
}

const IPV4_OCTET = /^\d{1,3}$/;

/**
 * True only when a Host header names a loopback literal: `localhost`, a
 * 127.0.0.0/8 dotted quad or `[::1]`, each with an optional numeric port.
 * Any other name (including `127.evil.com` or `localhost.evil.com`) could be
 * an attacker's DNS name rebound to 127.0.0.1, so it is never trusted.
 */
export function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader || hostHeader.length > 300) return false;
  const value = hostHeader.toLowerCase();
  let name;
  let rest;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return false;
    name = value.slice(0, close + 1);
    rest = value.slice(close + 1);
  } else {
    const colon = value.indexOf(":");
    name = colon < 0 ? value : value.slice(0, colon);
    rest = colon < 0 ? "" : value.slice(colon);
  }
  if (rest !== "") {
    const port = rest.slice(1);
    if (rest[0] !== ":" || !/^\d{1,5}$/.test(port) || Number(port) > 65535) return false;
  }
  if (name === "localhost" || name === "[::1]") return true;
  const octets = name.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((o) => IPV4_OCTET.test(o) && Number(o) <= 255);
}

/**
 * Loopback trust for one request: the socket must come from loopback AND the
 * Host header must be a loopback literal (see isLoopbackHost).
 */
export function isTrustedLoopback(req, remote = req?.socket?.remoteAddress) {
  return isLoopback(remote) && isLoopbackHost(req?.headers?.host);
}

/** Per-client failure tracking with a time-boxed lockout. */
export function createLockout({ maxFails = MAX_FAILS, lockMs = LOCK_MS, now = Date.now } = {}) {
  const entries = new Map();

  function prune(at) {
    for (const [key, entry] of entries) {
      if (entry.until && entry.until <= at) entries.delete(key);
      else if (!entry.until && at - entry.last > lockMs) entries.delete(key);
    }
  }

  return {
    /** @returns {{locked:boolean, retryInMs:number}} */
    status(key) {
      const at = now();
      const entry = entries.get(key);
      if (!entry || !entry.until) return { locked: false, retryInMs: 0 };
      if (entry.until <= at) {
        entries.delete(key);
        return { locked: false, retryInMs: 0 };
      }
      return { locked: true, retryInMs: entry.until - at };
    },
    recordFailure(key) {
      const at = now();
      prune(at);
      const entry = entries.get(key) || { fails: 0, last: at, until: 0 };
      entry.fails += 1;
      entry.last = at;
      if (entry.fails >= maxFails) entry.until = at + lockMs;
      entries.set(key, entry);
      return { locked: Boolean(entry.until), fails: entry.fails };
    },
    recordSuccess(key) {
      entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}

/** Hex SHA-256 of a session token; the only form a token is ever stored in. */
export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Read a persisted session file synchronously. Anything missing, corrupt or
 * wrongly shaped yields no sessions; expired and malformed entries are dropped.
 * Returns the surviving entries oldest-first and whether anything was dropped.
 */
function readSessionFile(path, at, max) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { entries: [], dropped: false };
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
    // Not rewritten here: an unknown shape (e.g. a newer version) is left
    // alone until the next pairing replaces it.
    return { entries: [], dropped: false };
  }
  const seen = new Set();
  const entries = [];
  for (const raw of parsed.sessions) {
    if (!raw || typeof raw !== "object") continue;
    const { hash, issuedAt, expiresAt } = raw;
    if (typeof hash !== "string" || !HASH_RE.test(hash) || seen.has(hash)) continue;
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= at) continue;
    seen.add(hash);
    entries.push({ hash, issuedAt, expiresAt });
  }
  entries.sort((a, b) => a.issuedAt - b.issuedAt);
  const kept = entries.slice(-max);
  return { entries: kept, dropped: kept.length !== parsed.sessions.length };
}

/**
 * Opaque session tokens with an expiry.
 *
 * Only SHA-256 hashes of tokens are kept. With `path`, sessions are loaded
 * synchronously at construction (so they are ready before the host listens)
 * and every change is persisted with a serialized atomic write; `flush()`
 * resolves once all pending writes have finished. A persistent store keeps at
 * most `maxSessions`, dropping the oldest. Without `path` nothing touches disk.
 */
export function createSessionStore({
  ttlMs = SESSION_TTL_MS,
  now = Date.now,
  path = null,
  maxSessions = MAX_SESSIONS,
} = {}) {
  /** hash -> { issuedAt, expiresAt }, in issue order. */
  const sessions = new Map();
  let chain = Promise.resolve();
  let queued = false;

  function persist() {
    if (!path || queued) return;
    queued = true;
    chain = chain
      .then(() => {
        // The snapshot is taken when the write starts, so any change made
        // after this point queues another write and nothing is lost.
        queued = false;
        const snapshot = { version: 1, sessions: [] };
        for (const [hash, s] of sessions) {
          snapshot.sessions.push({ hash, issuedAt: s.issuedAt, expiresAt: s.expiresAt });
        }
        return writeFileAtomic(path, `${JSON.stringify(snapshot)}\n`);
      })
      .catch(() => {
        /* best effort: the in-memory store stays authoritative for this run */
      });
  }

  function prune(at) {
    let removed = false;
    for (const [hash, s] of sessions) {
      if (s.expiresAt <= at) {
        sessions.delete(hash);
        removed = true;
      }
    }
    return removed;
  }

  if (path) {
    const { entries, dropped } = readSessionFile(path, now(), maxSessions);
    for (const e of entries) sessions.set(e.hash, { issuedAt: e.issuedAt, expiresAt: e.expiresAt });
    if (dropped) persist();
  }

  return {
    path,
    issue() {
      const at = now();
      prune(at);
      const token = randomBytes(32).toString("base64url");
      sessions.set(hashToken(token), { issuedAt: at, expiresAt: at + ttlMs });
      if (path) {
        while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
      }
      persist();
      return token;
    },
    verify(token) {
      if (typeof token !== "string" || !token) return false;
      const hash = hashToken(token);
      const entry = sessions.get(hash);
      if (entry === undefined) return false;
      if (entry.expiresAt <= now()) {
        sessions.delete(hash);
        persist();
        return false;
      }
      return true;
    },
    revokeAll() {
      sessions.clear();
      persist();
    },
    /** Resolves when every write queued so far has completed. */
    async flush() {
      while (true) {
        const current = chain;
        await current;
        if (current === chain) return;
      }
    },
    get size() {
      if (prune(now())) persist();
      return sessions.size;
    },
  };
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function tokenFromRequest(req) {
  return parseCookies(req?.headers?.cookie)[COOKIE_NAME] || "";
}

export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * The authorization decision for one request.
 * `remote` is the rate-limit bucket, normally the remote address. A loopback
 * request whose Host is not a loopback literal falls through to session auth.
 */
export function authorize({ req, sessions, lockout, remote, trustLoopback = true }) {
  if (trustLoopback && isTrustedLoopback(req, remote)) return { ok: true, via: "loopback" };
  const status = lockout.status(remote);
  if (status.locked) {
    return { ok: false, via: "locked", retryInMs: status.retryInMs, code: 429 };
  }
  if (sessions.verify(tokenFromRequest(req))) return { ok: true, via: "session" };
  return { ok: false, via: "unauthorized", code: 401 };
}
