/**
 * Bonjour / mDNS DNS-SD advertising of `_windock._tcp`.
 *
 * iPhones cannot send the UDP broadcast probe in src/discovery.js without a
 * special Apple entitlement, so the host also advertises itself the standard
 * way. On macOS the system's mDNSResponder does the work through
 * `/usr/bin/dns-sd -R`; on Windows and Linux a small dependency-free responder
 * answers queries on UDP 5353 itself.
 *
 * Like UDP discovery, nothing here is secret: the TXT record is a hint (host
 * ID, API version, address). Phones always confirm with `/health` and the
 * pinned certificate before trusting a host. Advertising must never take the
 * host down, so every failure is logged once and ignored.
 */

import { createSocket } from "node:dgram";
import { spawn as spawnChild } from "node:child_process";
import { isIPv4 } from "node:net";

export const SERVICE_TYPE = "_windock._tcp";
export const DNS_SD_PATH = "/usr/bin/dns-sd";
export const MDNS_ADDRESS = "224.0.0.251";
export const MDNS_PORT = 5353;
export const MAX_PACKET_BYTES = 9000;
export const MAX_LABEL_BYTES = 63;
export const MAX_NAME_BYTES = 255;
export const MAX_TXT_ENTRY_BYTES = 255;
/** RFC 6762 §10: records naming a host get 120 s, the others 75 minutes. */
export const HOST_TTL = 120;
export const OTHER_TTL = 4500;
/** RFC 6762 §6.7: replies to legacy (non-5353) queriers carry TTL ≤ 10. */
export const LEGACY_TTL = 10;
export const ANNOUNCE_INTERVAL_MS = 1000;

export const TYPE = Object.freeze({ A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 });
const CLASS_IN = 1;
const CLASS_ANY = 255;
const FLAG_RESPONSE = 0x8000;
const FLAG_AUTHORITATIVE = 0x0400;
const OPCODE_MASK = 0x7800;
const TOP_BIT = 0x8000;

// ---------------------------------------------------------------- names ----

/** Split a constant dotted name into labels (only for names without dots in labels). */
export function labelsOf(name) {
  return String(name).split(".").filter(Boolean);
}

const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** DNS names compare case-insensitively (ASCII only, RFC 6762 §16). */
export function sameName(a, b) {
  return a.length === b.length && a.every((label, i) => asciiLower(label) === asciiLower(b[i]));
}

/** Truncate to at most `max` UTF-8 bytes without splitting a code point. */
function truncateBytes(text, max) {
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > max) break;
    out += ch;
    bytes += size;
  }
  return out;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The service instance name: the computer's host name without `.local`,
 * control characters removed, at most 63 UTF-8 bytes. Never empty.
 */
export function instanceName(hostName) {
  const cleaned = String(hostName ?? "")
    .replace(CONTROL_CHARS, "")
    .trim()
    .replace(/\.local\.?$/i, "")
    .trim();
  return truncateBytes(cleaned, MAX_LABEL_BYTES).trim() || "WinDock";
}

/** The A-record host label for the JS responder, distinct from the OS's own name. */
export function hostLabelFor(hostId) {
  const prefix = String(hostId ?? "").replace(/[^0-9a-z]/gi, "").slice(0, 8).toLowerCase();
  return prefix ? `windock-${prefix}` : "windock-host";
}

// ------------------------------------------------------------------ TXT ----

const TXT_KEY = /^[\x21-\x3c\x3e-\x7e]{1,9}$/; // printable ASCII except "=", RFC 6763 §6.4

/**
 * TXT entries (`key=value` strings) from an object, in insertion order.
 * null/undefined values are left out. Throws on a bad key or an entry over
 * 255 bytes, so a bad record is never advertised.
 */
export function txtEntries(txt = {}) {
  const entries = [];
  for (const [key, value] of Object.entries(txt || {})) {
    if (value === null || value === undefined) continue;
    if (!TXT_KEY.test(key)) throw new TypeError(`bad TXT key ${JSON.stringify(key)}`);
    const entry = `${key}=${String(value)}`;
    if (Buffer.byteLength(entry, "utf8") > MAX_TXT_ENTRY_BYTES) throw new RangeError(`TXT entry ${key} is over 255 bytes`);
    entries.push(entry);
  }
  return entries;
}

export function osName(platform = process.platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

/** The TXT record the host advertises. Every value is a hint the phone verifies. */
export function buildTxt({ hostId, tls, address, hostName, platform = process.platform }) {
  const name = Array.from(String(hostName ?? "").replace(CONTROL_CHARS, "").trim()).slice(0, 60).join("");
  return {
    id: hostId || null,
    api: "1",
    tls: tls ? "1" : "0",
    addr: address && isIPv4(address) ? address : null,
    name: name || null,
    os: osName(platform),
  };
}

// ----------------------------------------------------------- DNS packets ----

export function encodeName(labels) {
  const parts = [];
  let total = 1;
  for (const label of labels) {
    const bytes = Buffer.from(String(label), "utf8");
    if (bytes.length === 0 || bytes.length > MAX_LABEL_BYTES) throw new RangeError("DNS label must be 1-63 bytes");
    total += bytes.length + 1;
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  if (total > MAX_NAME_BYTES) throw new RangeError("DNS name is over 255 bytes");
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * Decode a (possibly compressed) name at `offset`.
 * Compression pointers must point strictly backwards from the segment being
 * read, which makes loops impossible; the jump count is capped as well.
 * @returns {{labels: string[], next: number}} next = offset after the name
 */
export function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  let lowest = offset;
  let jumps = 0;
  let total = 1;
  for (;;) {
    if (pos >= buf.length) throw new RangeError("name runs past the packet");
    const len = buf[pos];
    if (len === 0) {
      if (next < 0) next = pos + 1;
      return { labels, next };
    }
    const kind = len & 0xc0;
    if (kind === 0xc0) {
      if (pos + 1 >= buf.length) throw new RangeError("truncated compression pointer");
      const target = ((len & 0x3f) << 8) | buf[pos + 1];
      if (target >= lowest) throw new RangeError("compression pointer does not point backwards");
      if (++jumps > 64) throw new RangeError("too many compression pointers");
      if (next < 0) next = pos + 2;
      lowest = target;
      pos = target;
      continue;
    }
    if (kind !== 0) throw new RangeError("unsupported label type");
    if (pos + 1 + len > buf.length) throw new RangeError("label runs past the packet");
    total += len + 1;
    if (total > MAX_NAME_BYTES) throw new RangeError("DNS name is over 255 bytes");
    labels.push(buf.toString("utf8", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
}

function ipv4Bytes(address) {
  if (!isIPv4(address)) throw new TypeError("A record needs an IPv4 address");
  return Buffer.from(address.split(".").map(Number));
}

function encodeRdata(record) {
  const { type, data } = record;
  if (type === TYPE.A) return ipv4Bytes(data);
  if (type === TYPE.PTR) return encodeName(data);
  if (type === TYPE.SRV) {
    const head = Buffer.alloc(6);
    head.writeUInt16BE(data.priority ?? 0, 0);
    head.writeUInt16BE(data.weight ?? 0, 2);
    head.writeUInt16BE(data.port, 4);
    return Buffer.concat([head, encodeName(data.target)]);
  }
  if (type === TYPE.TXT) {
    const strings = data.length ? data : [""]; // RFC 6763 §6.1: never zero-length rdata
    return Buffer.concat(strings.map((s) => {
      const bytes = Buffer.from(String(s), "utf8");
      if (bytes.length > MAX_TXT_ENTRY_BYTES) throw new RangeError("TXT string is over 255 bytes");
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    }));
  }
  return Buffer.from(data ?? []);
}

function decodeRdata(buf, start, length, type) {
  const end = start + length;
  if (type === TYPE.A) {
    if (length !== 4) throw new RangeError("bad A record length");
    return Array.from(buf.subarray(start, end)).join(".");
  }
  if (type === TYPE.PTR) {
    const { labels, next } = decodeName(buf, start);
    if (next > end) throw new RangeError("PTR name runs past its record");
    return labels;
  }
  if (type === TYPE.SRV) {
    if (length < 7) throw new RangeError("bad SRV record length");
    const { labels, next } = decodeName(buf, start + 6);
    if (next > end) throw new RangeError("SRV target runs past its record");
    return { priority: buf.readUInt16BE(start), weight: buf.readUInt16BE(start + 2), port: buf.readUInt16BE(start + 4), target: labels };
  }
  if (type === TYPE.TXT) {
    const strings = [];
    let pos = start;
    while (pos < end) {
      const len = buf[pos];
      if (pos + 1 + len > end) throw new RangeError("TXT string runs past its record");
      strings.push(buf.toString("utf8", pos + 1, pos + 1 + len));
      pos += 1 + len;
    }
    return strings.length === 1 && strings[0] === "" ? [] : strings;
  }
  return Buffer.from(buf.subarray(start, end));
}

/**
 * Encode a DNS message. Records: { name: labels, type, class?, flush?, ttl, data }.
 * Questions: { name: labels, type, class?, qu? }. No compression on encode.
 */
export function encodePacket({ id = 0, flags = 0, questions = [], answers = [], authorities = [], additionals = [] }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authorities.length, 8);
  header.writeUInt16BE(additionals.length, 10);
  const parts = [header];
  for (const q of questions) {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(((q.class ?? CLASS_IN) & 0x7fff) | (q.qu ? TOP_BIT : 0), 2);
    parts.push(encodeName(q.name), tail);
  }
  for (const r of [...answers, ...authorities, ...additionals]) {
    const rdata = encodeRdata(r);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(r.type, 0);
    fixed.writeUInt16BE(((r.class ?? CLASS_IN) & 0x7fff) | (r.flush ? TOP_BIT : 0), 2);
    fixed.writeUInt32BE(r.ttl >>> 0, 4);
    fixed.writeUInt16BE(rdata.length, 8);
    parts.push(encodeName(r.name), fixed, rdata);
  }
  return Buffer.concat(parts);
}

/**
 * Decode a DNS message. Throws RangeError/TypeError on malformed input.
 * With `questionsOnly`, the record sections are not parsed (a query's
 * known-answer section cannot then make it fail).
 */
export function decodePacket(buf, { questionsOnly = false } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new RangeError("packet shorter than a DNS header");
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((at) => buf.readUInt16BE(at));
  let pos = 12;
  const questions = [];
  for (let i = 0; i < counts[0]; i += 1) {
    const { labels, next } = decodeName(buf, pos);
    if (next + 4 > buf.length) throw new RangeError("question runs past the packet");
    const qclass = buf.readUInt16BE(next + 2);
    questions.push({ name: labels, type: buf.readUInt16BE(next), class: qclass & 0x7fff, qu: Boolean(qclass & TOP_BIT) });
    pos = next + 4;
  }
  const sections = [[], [], []];
  if (!questionsOnly) {
    for (let s = 0; s < 3; s += 1) {
      for (let i = 0; i < counts[s + 1]; i += 1) {
        const { labels, next } = decodeName(buf, pos);
        if (next + 10 > buf.length) throw new RangeError("record runs past the packet");
        const type = buf.readUInt16BE(next);
        const rclass = buf.readUInt16BE(next + 2);
        const ttl = buf.readUInt32BE(next + 4);
        const length = buf.readUInt16BE(next + 8);
        const start = next + 10;
        if (start + length > buf.length) throw new RangeError("record data runs past the packet");
        sections[s].push({ name: labels, type, class: rclass & 0x7fff, flush: Boolean(rclass & TOP_BIT), ttl, data: decodeRdata(buf, start, length, type) });
        pos = start + length;
      }
    }
  }
  return { id, flags, questions, answers: sections[0], authorities: sections[1], additionals: sections[2] };
}

// -------------------------------------------------------------- answers ----

/**
 * The records this host owns. `ttlScale` 0 makes the goodbye set.
 * @returns {{servicePtr, enumPtr, srv, txt, a, all: object[]}}
 */
export function buildRecords({ instance, hostLabel, port, txt = [], address, ttlScale = 1 }) {
  const service = labelsOf(`${SERVICE_TYPE}.local`);
  const fqdn = [instance, ...service];
  const host = [hostLabel, "local"];
  const ttl = (n) => n * ttlScale;
  const servicePtr = { name: service, type: TYPE.PTR, ttl: ttl(OTHER_TTL), data: fqdn };
  const enumPtr = { name: labelsOf("_services._dns-sd._udp.local"), type: TYPE.PTR, ttl: ttl(OTHER_TTL), data: service };
  const srv = { name: fqdn, type: TYPE.SRV, flush: true, ttl: ttl(HOST_TTL), data: { priority: 0, weight: 0, port, target: host } };
  const txtRecord = { name: fqdn, type: TYPE.TXT, flush: true, ttl: ttl(OTHER_TTL), data: txt };
  const a = address ? { name: host, type: TYPE.A, flush: true, ttl: ttl(HOST_TTL), data: address } : null;
  return { servicePtr, enumPtr, srv, txt: txtRecord, a, all: [servicePtr, enumPtr, srv, txtRecord, a].filter(Boolean) };
}

const matches = (qtype, type) => qtype === type || qtype === TYPE.ANY;

/**
 * Which of our records answer a decoded query. Pure.
 * @returns {{answers: object[], additionals: object[], qu: boolean}} empty answers = stay silent
 */
export function answersFor(query, records) {
  const answers = [];
  const additionals = [];
  let qu = false;
  const add = (list, r) => { if (r && !answers.includes(r) && !list.includes(r)) list.push(r); };
  if (!query || (query.flags & FLAG_RESPONSE) || (query.flags & OPCODE_MASK)) return { answers, additionals, qu };
  for (const q of query.questions || []) {
    if (q.class !== CLASS_IN && q.class !== CLASS_ANY) continue;
    const before = answers.length;
    if (sameName(q.name, records.servicePtr.name) && matches(q.type, TYPE.PTR)) {
      add(answers, records.servicePtr);
    }
    if (sameName(q.name, records.enumPtr.name) && matches(q.type, TYPE.PTR)) {
      add(answers, records.enumPtr);
    }
    if (sameName(q.name, records.srv.name)) {
      if (matches(q.type, TYPE.SRV)) add(answers, records.srv);
      if (matches(q.type, TYPE.TXT)) add(answers, records.txt);
    }
    if (records.a && sameName(q.name, records.a.name) && matches(q.type, TYPE.A)) {
      add(answers, records.a);
    }
    if (answers.length > before && q.qu) qu = true;
  }
  // RFC 6763 §12: PTR answers carry SRV, TXT and A; SRV answers carry A.
  if (answers.includes(records.servicePtr)) {
    add(additionals, records.srv);
    add(additionals, records.txt);
  }
  if (answers.includes(records.srv) || additionals.includes(records.srv)) add(additionals, records.a);
  for (const r of answers) {
    const i = additionals.indexOf(r);
    if (i >= 0) additionals.splice(i, 1);
  }
  return { answers, additionals, qu };
}

/**
 * The reply to one datagram, or null to stay silent. Pure.
 * Oversized, malformed, response and foreign-name packets get no reply, so the
 * responder cannot be used as an amplifier.
 * @returns {null | {packet: Buffer, address: string, port: number, multicast: boolean, answers: object[]}}
 */
export function responseFor(message, rinfo, records) {
  if (!Buffer.isBuffer(message) || message.length > MAX_PACKET_BYTES) return null;
  if (!rinfo || typeof rinfo.address !== "string" || !Number.isInteger(rinfo.port)) return null;
  let query;
  try {
    query = decodePacket(message, { questionsOnly: true });
  } catch {
    return null;
  }
  const { answers, additionals, qu } = answersFor(query, records);
  if (answers.length === 0) return null;
  const legacy = rinfo.port !== MDNS_PORT;
  if (legacy) {
    // RFC 6762 §6.7: echo the ID and questions, short TTLs, no cache-flush bit.
    const strip = (r) => ({ ...r, flush: false, ttl: Math.min(r.ttl, LEGACY_TTL) });
    const packet = encodePacket({
      id: query.id,
      flags: FLAG_RESPONSE | FLAG_AUTHORITATIVE,
      questions: query.questions.map((q) => ({ ...q, qu: false })),
      answers: answers.map(strip),
      additionals: additionals.map(strip),
    });
    return { packet, address: rinfo.address, port: rinfo.port, multicast: false, answers };
  }
  const packet = encodePacket({ flags: FLAG_RESPONSE | FLAG_AUTHORITATIVE, answers, additionals });
  if (qu) return { packet, address: rinfo.address, port: MDNS_PORT, multicast: false, answers };
  return { packet, address: MDNS_ADDRESS, port: MDNS_PORT, multicast: true, answers };
}

/** An unsolicited announcement (or, with ttlScale 0, the goodbye). */
export function announcementPacket(records) {
  return encodePacket({ flags: FLAG_RESPONSE | FLAG_AUTHORITATIVE, answers: records.all });
}

// ------------------------------------------------------------ advertisers ----

function defaultLog(line) {
  process.stderr.write(`WinDock bonjour: ${line}\n`);
}

const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"]; // dns-sd only runs on macOS

const NONE = Object.freeze({ kind: "none", stop: async () => {} });

/** macOS: let mDNSResponder advertise through a long-running `dns-sd -R`. */
function startDnsSd({ name, port, entries, spawn, log }) {
  const argv = ["-R", name, SERVICE_TYPE, "local", String(port), ...entries];
  let reported = false;
  const report = (line) => { if (!reported) { reported = true; log(line); } };
  let stderr = "";
  let exited = false;
  let stopping = false;
  let child;
  try {
    child = spawn(DNS_SD_PATH, argv, { stdio: ["ignore", "ignore", "pipe"], shell: false });
  } catch (err) {
    report(`could not run ${DNS_SD_PATH} (${err.code || err.message}); Bonjour advertising is off`);
    return NONE;
  }
  const kill = () => { if (!exited) { try { child.kill("SIGTERM"); } catch { /* already gone */ } } };
  // dns-sd is a separate process: it must not outlive the host. "exit" covers
  // a normal exit; Node skips "exit" when a signal ends the process, so the
  // usual termination signals kill dns-sd too and are then re-raised (unless
  // something else in the process handles them).
  const onProcessExit = () => kill();
  const onSignal = (signal) => {
    stopping = true;
    kill();
    unhook();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const unhook = () => {
    process.off("exit", onProcessExit);
    for (const signal of EXIT_SIGNALS) process.off(signal, onSignal);
  };
  process.once("exit", onProcessExit);
  for (const signal of EXIT_SIGNALS) process.on(signal, onSignal);
  child.stderr?.on?.("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-512); });
  child.stderr?.on?.("error", () => {});
  child.on("error", (err) => {
    exited = true;
    unhook();
    report(`could not run ${DNS_SD_PATH} (${err.code || err.message}); Bonjour advertising is off`);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    unhook();
    if (!stopping) {
      const detail = stderr.trim().split("\n").pop() || "";
      report(`dns-sd exited (${signal || `code ${code}`})${detail ? `: ${detail}` : ""}; Bonjour advertising is off`);
    }
  });
  // Advertising must never keep the process alive on its own.
  child.unref?.();
  child.stderr?.unref?.();
  return {
    kind: "dns-sd",
    argv,
    child,
    stop() {
      stopping = true;
      unhook();
      if (exited) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        kill();
      });
    },
  };
}

/** Windows and Linux: a minimal responder on UDP 5353. */
function startResponder({ name, port, entries, address, hostLabel, socketFactory, log, setTimer = setTimeout, now = Date.now }) {
  if (!address || !isIPv4(address)) {
    log("no LAN IPv4 address; Bonjour advertising is off");
    return NONE;
  }
  const records = buildRecords({ instance: name, hostLabel, port, txt: entries, address });
  const goodbye = announcementPacket(buildRecords({ instance: name, hostLabel, port, txt: entries, address, ttlScale: 0 }));
  const announcement = announcementPacket(records);
  const sock = socketFactory();
  let closed = false;
  let bound = false;
  const timers = [];
  const lastMulticast = new Map();
  const send = (packet, toPort, toAddress) => {
    if (closed) return;
    try { sock.send(packet, toPort, toAddress, () => {}); } catch { /* not fatal */ }
  };
  sock.on("error", (err) => {
    log(`mDNS responder stopped (${err.code || err.message}); Bonjour advertising is off`);
    if (!closed) { closed = true; for (const t of timers) clearTimeout(t); try { sock.close(); } catch { /* closed */ } }
  });
  sock.on("message", (msg, rinfo) => {
    const reply = responseFor(msg, rinfo, records);
    if (!reply) return;
    if (reply.multicast) {
      // RFC 6762 §6: the same record is multicast at most once a second.
      const t = now();
      const fresh = reply.answers.some((r) => !(t - (lastMulticast.get(r) ?? -Infinity) < 1000));
      if (!fresh) return;
      for (const r of reply.answers) lastMulticast.set(r, t);
    }
    send(reply.packet, reply.port, reply.address);
  });
  try {
    sock.bind(MDNS_PORT, () => {
      if (closed) return;
      bound = true;
      try {
        sock.addMembership(MDNS_ADDRESS, address);
        sock.setMulticastInterface?.(address);
        sock.setMulticastTTL(255);
        sock.setMulticastLoopback?.(true);
      } catch (err) {
        log(`could not join the mDNS group (${err.code || err.message}); Bonjour advertising is off`);
        closed = true;
        try { sock.close(); } catch { /* closed */ }
        return;
      }
      send(announcement, MDNS_PORT, MDNS_ADDRESS);
      const again = setTimer(() => send(announcement, MDNS_PORT, MDNS_ADDRESS), ANNOUNCE_INTERVAL_MS);
      again?.unref?.();
      timers.push(again);
    });
  } catch (err) {
    log(`could not open UDP ${MDNS_PORT} (${err.code || err.message}); Bonjour advertising is off`);
    closed = true;
    return NONE;
  }
  sock.unref?.();
  return {
    kind: "mdns",
    records,
    stop() {
      for (const t of timers) clearTimeout(t);
      if (closed) return Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => {
          if (closed) return resolve();
          closed = true;
          try { sock.close(() => resolve()); } catch { resolve(); }
        };
        if (!bound) return finish();
        try { sock.send(goodbye, MDNS_PORT, MDNS_ADDRESS, finish); } catch { finish(); }
      });
    },
  };
}

/**
 * Advertise `_windock._tcp` on `port`. Never throws.
 * @param {object} opts
 * @param {string} opts.name instance name (see instanceName)
 * @param {number} opts.port TCP port of the host
 * @param {object} opts.txt TXT object (see buildTxt)
 * @returns {{stop(): Promise<void>, kind: "dns-sd"|"mdns"|"none"}}
 */
export function startBonjour({
  name,
  port,
  txt = {},
  platform = process.platform,
  spawn = spawnChild,
  socketFactory = () => createSocket({ type: "udp4", reuseAddr: true }),
  address = txt?.addr ?? null,
  hostLabel = hostLabelFor(txt?.id),
  log = defaultLog,
  setTimer,
  now,
} = {}) {
  try {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new RangeError("bad port");
    const instance = instanceName(name);
    const entries = txtEntries(txt);
    if (platform === "darwin") return startDnsSd({ name: instance, port, entries, spawn, log });
    if (platform === "win32" || platform === "linux") {
      return startResponder({ name: instance, port, entries, address, hostLabel, socketFactory, log, setTimer, now });
    }
    return NONE;
  } catch (err) {
    try { log(`not advertising (${err.message})`); } catch { /* logging must not throw either */ }
    return NONE;
  }
}

/**
 * Keep the advertisement in step with the host's LAN address. The TXT `addr`
 * (and, for the JS responder, the A record) name the address, so a change
 * restarts the advertisement: dns-sd is stopped and run again with the new
 * TXT; the JS responder sends its goodbye for the old records, then announces
 * the new ones. With no address nothing is advertised (no phone could reach
 * the host); advertising resumes when an address returns. Changes are applied
 * one at a time, in order. Never throws.
 * @param {object} opts
 * @param {Function} [opts.advertise] startBonjour, or a stand-in for tests
 * @param {string} opts.name instance name
 * @param {number} opts.port TCP port
 * @param {(address: string|null) => object} opts.txtFor the TXT object for an address
 * @param {string|null} opts.address the address at start
 * @param {(kind: string) => void} [opts.onStart] hears the kind of each advertisement started
 * @returns {{kind: string, address: string|null, setAddress(a): Promise<void>, stop(): Promise<void>, settled(): Promise<void>}}
 */
export function followBonjour({ advertise = startBonjour, name, port, txtFor, address = null, onStart = () => {}, ...rest } = {}) {
  let current = NONE;
  let wanted = address || null;
  let stopped = false;
  const launch = (addr) => {
    if (stopped || !addr) { current = NONE; return; }
    try {
      current = advertise({ name, port, txt: txtFor(addr), ...rest }) || NONE;
    } catch {
      current = NONE;
    }
    try { onStart(current.kind); } catch { /* reporting must not throw */ }
  };
  launch(wanted);
  let chain = Promise.resolve();
  const enqueue = (step) => {
    chain = chain.then(step).catch(() => {});
    return chain;
  };
  return {
    get kind() { return current.kind; },
    get address() { return wanted; },
    get current() { return current; },
    setAddress(next) {
      const addr = next || null;
      if (stopped || addr === wanted) return chain;
      wanted = addr;
      return enqueue(async () => {
        const old = current;
        current = NONE;
        await old.stop();
        if (wanted === addr) launch(addr);
      });
    },
    stop() {
      stopped = true;
      return enqueue(async () => {
        const old = current;
        current = NONE;
        await old.stop();
      });
    },
    settled() { return chain; },
  };
}
