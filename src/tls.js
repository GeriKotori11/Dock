/**
 * Self-signed TLS identity for the host.
 *
 * There is no certificate authority: the host makes its own ECDSA P-256 key and
 * a self-signed X.509 v3 certificate, and phones pin the certificate's SHA-256
 * fingerprint the first time they pair (trust on first use). The short
 * security code derived from the fingerprint lets a person compare the phone
 * and the computer by eye. The certificate is built with a small DER encoder
 * below, so nothing depends on an `openssl` binary (Windows has none) or on an
 * npm package.
 *
 * Key and certificate live in the data directory as `tls-key.pem` and
 * `tls-cert.pem` (owner-only). They are reused across restarts so the pinned
 * fingerprint stays the same, and regenerated only when they are missing,
 * unreadable, mismatched or about to expire.
 */

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "./fsutil.js";

export const KEY_FILE = "tls-key.pem";
export const CERT_FILE = "tls-cert.pem";
export const CERT_YEARS = 20;
/** A certificate that expires within this window is replaced on load. */
export const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- minimal DER encoder ----

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...content) {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items) => tlv(0x30, ...items);
const set = (...items) => tlv(0x31, ...items);
const octetString = (bytes) => tlv(0x04, bytes);
const utf8String = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
const explicit = (n, inner) => tlv(0xa0 | n, inner);
const bitString = (bytes, unusedBits = 0) => tlv(0x03, Buffer.from([unusedBits]), bytes);
const BOOLEAN_TRUE = Buffer.from([0x01, 0x01, 0xff]);

/** A non-negative INTEGER from big-endian bytes, minimally encoded. */
function integer(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let body = bytes.subarray(start);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const base128 = [part & 0x7f];
    for (let n = Math.floor(part / 128); n > 0; n = Math.floor(n / 128)) base128.unshift(0x80 | (n & 0x7f));
    out.push(...base128);
  }
  return tlv(0x06, Buffer.from(out));
}

/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. */
function time(date) {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const digits = iso.slice(0, 19).replace(/[-T:]/g, "");
  const year = date.getUTCFullYear();
  if (year < 2050) return tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, "ascii"));
  return tlv(0x18, Buffer.from(`${digits}Z`, "ascii"));
}

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

function extension(id, critical, value) {
  return sequence(oid(id), ...(critical ? [BOOLEAN_TRUE] : []), octetString(value));
}

function toPem(label, der) {
  const lines = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/** Add whole calendar years in UTC (Feb 29 rolls to Mar 1, which is fine). */
function addYears(date, years) {
  const out = new Date(date.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

/**
 * Build a self-signed certificate for `privateKey`/`publicKey`.
 * @returns {Buffer} the certificate DER
 */
export function createSelfSignedCertificate({ privateKey, publicKey, commonName, now = Date.now() }) {
  const serial = randomBytes(16);
  serial[0] &= 0x7f; // positive
  if (serial[0] === 0) serial[0] = 0x01; // keep it 16 bytes and minimally encoded
  const at = new Date(Math.floor(Number(now) / 1000) * 1000);
  const notBefore = new Date(at.getTime() - DAY_MS);
  const notAfter = addYears(at, CERT_YEARS);
  const name = sequence(set(sequence(oid(OID.commonName), utf8String(commonName))));
  const signatureAlgorithm = sequence(oid(OID.ecdsaWithSha256)); // parameters absent (RFC 5758)
  const extensions = sequence(
    extension(OID.basicConstraints, true, sequence()), // cA FALSE (the DEFAULT, so omitted)
    extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)), // digitalSignature
    extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
  );
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    signatureAlgorithm,
    name, // issuer
    sequence(time(notBefore), time(notAfter)),
    name, // subject
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey); // DER ECDSA-Sig-Value
  return sequence(tbs, signatureAlgorithm, bitString(signature));
}

/** Lowercase hex SHA-256 of a certificate's DER, without separators. */
export function fingerprintOf(certDer) {
  return createHash("sha256").update(certDer).digest("hex");
}

/**
 * The human-comparable security code: the first 6 bytes of the fingerprint as
 * uppercase hex in three groups of four, e.g. `3F2A-9C01-B7E4`.
 */
export function securityCode(fingerprintHex) {
  if (typeof fingerprintHex !== "string" || !/^[0-9a-fA-F]{12,}$/.test(fingerprintHex)) {
    throw new TypeError("securityCode needs a hex fingerprint");
  }
  const head = fingerprintHex.slice(0, 12).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4, 8)}-${head.slice(8, 12)}`;
}

function identityFrom(keyPem, certPem, x509) {
  const fingerprint = fingerprintOf(x509.raw);
  return { key: keyPem, cert: certPem, fingerprint, code: securityCode(fingerprint) };
}

/** Parse and check stored PEMs; null when they cannot be reused at `now`. */
function reusable(keyPem, certPem, now) {
  try {
    const x509 = new X509Certificate(certPem);
    const key = createPrivateKey(keyPem);
    if (!x509.checkPrivateKey(key)) return null;
    const notAfter = x509.validToDate?.getTime() ?? Date.parse(x509.validTo);
    if (!Number.isFinite(notAfter) || notAfter - RENEW_BEFORE_MS <= now) return null;
    return identityFrom(keyPem, certPem, x509);
  } catch {
    return null;
  }
}

/** A fresh key and certificate (not persisted). */
export function generateTlsIdentity({ commonName, now = Date.now() }) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = createSelfSignedCertificate({ privateKey, publicKey, commonName, now });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const certPem = toPem("CERTIFICATE", der);
  return identityFrom(keyPem, certPem, new X509Certificate(der));
}

/**
 * Load the host's TLS identity from `dir`, creating and persisting a new one
 * when either file is missing, unparsable, expired or expiring within 30 days,
 * or when the key does not match the certificate. Never throws for a bad or
 * unwritable file: a new identity is still returned for this run.
 * @param {{dir:string, commonName:string, now?:number|(()=>number)}} opts
 * @returns {Promise<{key:string, cert:string, fingerprint:string, code:string}>}
 */
export async function loadOrCreateTlsIdentity({ dir, commonName, now = Date.now } = {}) {
  if (!dir) throw new TypeError("loadOrCreateTlsIdentity requires a dir");
  if (typeof commonName !== "string" || !commonName) throw new TypeError("loadOrCreateTlsIdentity requires a commonName");
  const at = typeof now === "function" ? now() : Number(now);
  const keyPath = join(dir, KEY_FILE);
  const certPath = join(dir, CERT_FILE);
  try {
    const [keyPem, certPem] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
    const existing = reusable(keyPem, certPem, at);
    if (existing) return existing;
  } catch {
    /* missing or unreadable: regenerate below */
  }
  const identity = generateTlsIdentity({ commonName, now: at });
  try {
    // Key first: a crash between the two writes leaves a mismatched pair,
    // which the next load detects and replaces.
    await writeFileAtomic(keyPath, identity.key);
    await writeFileAtomic(certPath, identity.cert);
  } catch {
    /* read-only data dir: the identity still works for this run */
  }
  return identity;
}

// ---- one port, two protocols ----

/** The first byte of every TLS connection: a handshake record (ContentType 22). */
export const TLS_HANDSHAKE_BYTE = 0x16;
/** A connection that sends nothing for this long is closed. */
export const FIRST_BYTE_TIMEOUT_MS = 10_000;

/**
 * A TCP listener that serves plain HTTP and HTTPS on the same port. It reads
 * the first byte of each connection: a TLS handshake goes to `secureServer`,
 * anything else to `server` (or is closed when `plainHttp` is false). The
 * peeked bytes are pushed back onto the socket before it is handed over, so
 * both servers see the complete stream. Sockets that send nothing within
 * `firstByteTimeoutMs`, or close or fail first, are dropped quietly.
 *
 * Neither inner server listens itself. Their `listening` and `close` events
 * follow this listener so Node's HTTP connection tracking (header and request
 * timeouts, idle-connection cleanup) works as it does for a listening server.
 */
export function createSharedPortListener({
  server,
  secureServer,
  plainHttp = true,
  firstByteTimeoutMs = FIRST_BYTE_TIMEOUT_MS,
}) {
  const pending = new Set();
  // Match http.Server's own socket options so plain HTTP behaves as before.
  const listener = createNetServer({ allowHalfOpen: true, noDelay: true }, (socket) => {
    pending.add(socket);
    const ignoreError = () => {};
    const timer = setTimeout(() => socket.destroy(), firstByteTimeoutMs);
    timer.unref?.();
    const onEnd = () => socket.destroy(); // half-closed before saying anything
    const settle = () => {
      clearTimeout(timer);
      pending.delete(socket);
      socket.off("error", ignoreError);
      socket.off("close", settle);
      socket.off("end", onEnd);
    };
    socket.on("error", ignoreError);
    socket.once("close", settle);
    socket.once("end", onEnd);
    socket.once("data", (chunk) => {
      socket.pause();
      socket.unshift(chunk);
      settle();
      if (chunk[0] === TLS_HANDSHAKE_BYTE) {
        // TLSSocket drains bytes already buffered on the raw socket itself.
        secureServer.emit("connection", socket);
      } else if (plainHttp) {
        server.emit("connection", socket);
        socket.resume(); // replays the unshifted bytes into the HTTP parser first
      } else {
        socket.destroy();
      }
    });
  });

  listener.on("listening", () => {
    server.emit("listening");
    secureServer.emit("listening");
  });
  const closeListener = listener.close;
  listener.close = function close(...args) {
    for (const socket of pending) socket.destroy();
    server.closeIdleConnections();
    secureServer.closeIdleConnections();
    return closeListener.apply(this, args);
  };
  listener.on("close", () => {
    // Neither inner server is bound, so close() only stops its connection
    // checks and emits its own `close` (which the app uses for cleanup).
    server.close();
    secureServer.close();
  });
  listener.closeAllConnections = () => {
    for (const socket of pending) socket.destroy();
    server.closeAllConnections();
    secureServer.closeAllConnections();
  };
  listener.closeIdleConnections = () => {
    server.closeIdleConnections();
    secureServer.closeIdleConnections();
  };
  Object.defineProperty(listener, "pendingCount", { get: () => pending.size });
  return listener;
}
