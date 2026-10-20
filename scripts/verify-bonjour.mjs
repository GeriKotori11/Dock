/**
 * Bonjour / mDNS advertising of `_windock._tcp`: dns-sd argv on macOS, the DNS
 * codec, and the JS responder's answers. Uses a fake spawn and a fake socket,
 * so nothing binds UDP 5353 and no real advertisement is made.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import {
  startBonjour,
  instanceName,
  hostLabelFor,
  txtEntries,
  buildTxt,
  osName,
  encodeName,
  decodeName,
  encodePacket,
  decodePacket,
  buildRecords,
  answersFor,
  responseFor,
  labelsOf,
  TYPE,
  DNS_SD_PATH,
  MDNS_ADDRESS,
  MDNS_PORT,
  MAX_PACKET_BYTES,
  HOST_TTL,
  OTHER_TTL,
} from "../src/bonjour.js";

const t = createChecker("bonjour");
const HOST_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const TXT = buildTxt({ hostId: HOST_ID, tls: true, address: "192.168.1.40", hostName: "Studio-Mac.local", platform: "darwin" });

// ---- names ----
t.equal(instanceName("Geris-MacBook-Pro.local"), "Geris-MacBook-Pro", ".local is stripped");
t.equal(instanceName("DESKTOP-1.LOCAL."), "DESKTOP-1", ".LOCAL. is stripped case-insensitively");
t.equal(instanceName("DESKTOP-1"), "DESKTOP-1", "a bare name is kept");
t.equal(instanceName(""), "WinDock", "an empty name falls back");
t.equal(instanceName(null), "WinDock", "a missing name falls back");
t.equal(instanceName("a\u0000b\u001fc\u007f"), "abc", "control characters are removed");
const longName = instanceName("é".repeat(40));
t.ok(Buffer.byteLength(longName) <= 63 && longName === "é".repeat(31), "names are cut to 63 bytes on a code point boundary");
t.equal(Buffer.byteLength(instanceName("x".repeat(100))), 63, "ASCII names are cut to exactly 63 bytes");
t.equal(hostLabelFor(HOST_ID), "windock-0f1e2d3c", "host label uses the first 8 of the host ID");
t.equal(hostLabelFor(null), "windock-host", "host label without an ID");

// ---- TXT ----
t.deepEqual(txtEntries(TXT), [`id=${HOST_ID}`, "api=1", "tls=1", "addr=192.168.1.40", "name=Studio-Mac.local", "os=macos"],
  "TXT entries are the decided keys in order");
t.deepEqual(txtEntries({ a: "1", b: null, c: undefined, d: "" }), ["a=1", "d="], "null values are left out, empty ones kept");
t.throws(() => txtEntries({ "a=b": "1" }), "a key containing = is refused");
t.throws(() => txtEntries({ "": "1" }), "an empty key is refused");
t.throws(() => txtEntries({ "ké": "1" }), "a non-ASCII key is refused");
t.throws(() => txtEntries({ toolongkey: "1" }), "a key over 9 characters is refused");
t.equal(txtEntries({ k: "x".repeat(253) })[0].length, 255, "a 255-byte entry is allowed");
t.throws(() => txtEntries({ k: "x".repeat(254) }), "a 256-byte entry is refused");
const txtLong = buildTxt({ hostId: HOST_ID, tls: false, address: null, hostName: "😀".repeat(100), platform: "win32" });
t.equal(Array.from(txtLong.name).length, 60, "name= is cut to 60 characters");
t.ok(Buffer.byteLength(`name=${txtLong.name}`) <= 255, "a long non-ASCII name still fits a TXT entry");
t.equal(txtLong.tls, "0", "tls=0 without TLS");
t.equal(txtLong.addr, null, "no addr without an address");
t.equal(txtLong.os, "windows", "os=windows");
t.equal(osName("linux"), "linux", "os=linux");
t.equal(buildTxt({ hostId: HOST_ID, tls: true, address: "not-an-ip", hostName: "x" }).addr, null, "a bad address is left out");

// ---- codec ----
t.deepEqual([...encodeName(["a", "bc"])], [1, 97, 2, 98, 99, 0], "names encode as length-prefixed labels");
t.throws(() => encodeName(["x".repeat(64)]), "a 64-byte label is refused");
t.throws(() => encodeName(["", "local"]), "an empty label is refused");
t.throws(() => encodeName(Array(5).fill("x".repeat(63))), "a name over 255 bytes is refused");

const records = buildRecords({ instance: "My Mac.home", hostLabel: "windock-0f1e2d3c", port: 18710, txt: txtEntries(TXT), address: "192.168.1.40" });
const fullPacket = {
  id: 7,
  flags: 0x8400,
  questions: [{ name: labelsOf("_windock._tcp.local"), type: TYPE.PTR, class: 1, qu: true }],
  answers: [records.servicePtr],
  authorities: [{ name: ["x", "local"], type: 99, class: 1, flush: false, ttl: 5, data: Buffer.from([1, 2, 3]) }],
  additionals: [records.srv, records.txt, records.a, { name: ["e", "local"], type: TYPE.TXT, class: 1, flush: false, ttl: 1, data: [] }],
};
const decoded = decodePacket(encodePacket(fullPacket));
t.equal(decoded.id, 7, "round trip keeps the ID");
t.equal(decoded.flags, 0x8400, "round trip keeps the flags");
t.deepEqual(decoded.questions, [{ name: ["_windock", "_tcp", "local"], type: TYPE.PTR, class: 1, qu: true }], "round trip keeps the question and its QU bit");
t.deepEqual(decoded.answers[0].data, ["My Mac.home", "_windock", "_tcp", "local"], "PTR data round-trips, dots inside a label included");
t.equal(decoded.answers[0].flush, false, "PTR is shared (no cache-flush bit)");
t.deepEqual(decoded.additionals[0].data, { priority: 0, weight: 0, port: 18710, target: ["windock-0f1e2d3c", "local"] }, "SRV round-trips");
t.ok(decoded.additionals[0].flush && decoded.additionals[1].flush && decoded.additionals[2].flush, "SRV, TXT and A carry the cache-flush bit");
t.deepEqual(decoded.additionals[1].data, txtEntries(TXT), "TXT round-trips");
t.equal(decoded.additionals[2].data, "192.168.1.40", "A round-trips");
t.deepEqual(decoded.additionals[3].data, [], "an empty TXT round-trips");
t.deepEqual([...decoded.authorities[0].data], [1, 2, 3], "unknown record types keep their raw bytes");
t.equal(decoded.additionals[0].ttl, HOST_TTL, "SRV TTL is 120");
t.equal(decoded.answers[0].ttl, OTHER_TTL, "PTR TTL is 4500");
const emptyTxt = encodePacket({ answers: [{ name: ["e"], type: TYPE.TXT, ttl: 1, data: [] }] });
t.equal(emptyTxt.readUInt16BE(emptyTxt.length - 3), 1, "an empty TXT is encoded as one zero-length string");

// Compression pointers.
const comp = Buffer.from([
  ...Array(12).fill(0),
  5, ...Buffer.from("local"), 0, // 12: local
  3, ...Buffer.from("abc"), 0xc0, 12, // 19: abc -> local
  0xc0, 19, // 25: -> abc.local
]);
t.deepEqual(decodeName(comp, 19), { labels: ["abc", "local"], next: 25 }, "a pointer is followed and next stops after it");
t.deepEqual(decodeName(comp, 25), { labels: ["abc", "local"], next: 27 }, "a chain of pointers is followed");
const self = Buffer.from([...Array(12).fill(0), 0xc0, 12]);
t.throws(() => decodeName(self, 12), "a pointer to itself is refused");
const forward = Buffer.from([...Array(12).fill(0), 0xc0, 14, 1, 97, 0]);
t.throws(() => decodeName(forward, 12), "a forward pointer is refused");
const loop = Buffer.from([...Array(12).fill(0), 1, 97, 0xc0, 16, 1, 98, 0xc0, 12]);
t.throws(() => decodeName(loop, 16), "a two-pointer loop is refused");
t.throws(() => decodeName(Buffer.from([...Array(12).fill(0), 5, 97]), 12), "a label past the end is refused");
t.throws(() => decodeName(Buffer.from([...Array(12).fill(0), 0x80]), 12), "reserved label types are refused");
t.throws(() => decodeName(Buffer.from([...Array(12).fill(0), 0xc0]), 12), "a truncated pointer is refused");
t.throws(() => decodePacket(Buffer.alloc(5)), "a packet shorter than the header is refused");

// ---- answers ----
const rinfo = { address: "192.168.1.77", port: MDNS_PORT };
const query = (questions, { id = 0, flags = 0 } = {}) => encodePacket({ id, flags, questions });
const q = (name, type, qu = false, cls = 1) => ({ name: typeof name === "string" ? labelsOf(name) : name, type, class: cls, qu });
const reply = (questions, r = rinfo, opts) => responseFor(query(questions, opts), r, records);
const decodeReply = (res) => decodePacket(res.packet);

const ptr = reply([q("_windock._tcp.local", TYPE.PTR)]);
t.ok(ptr && ptr.multicast && ptr.address === MDNS_ADDRESS && ptr.port === MDNS_PORT, "a QM PTR query is answered by multicast");
const ptrPacket = decodeReply(ptr);
t.equal(ptrPacket.flags, 0x8400, "replies are authoritative responses");
t.equal(ptrPacket.id, 0, "multicast replies use ID 0");
t.equal(ptrPacket.questions.length, 0, "multicast replies carry no questions");
t.deepEqual(ptrPacket.answers.map((r) => r.type), [TYPE.PTR], "the PTR is the answer");
t.deepEqual(ptrPacket.additionals.map((r) => r.type), [TYPE.SRV, TYPE.TXT, TYPE.A], "SRV, TXT and A ride along as additionals");
const enumReply = decodeReply(reply([q("_services._dns-sd._udp.local", TYPE.PTR)]));
t.deepEqual(enumReply.answers[0].data, ["_windock", "_tcp", "local"], "service enumeration lists _windock._tcp");
const fqdn = ["My Mac.home", "_windock", "_tcp", "local"];
const srvReply = decodeReply(reply([q(fqdn, TYPE.SRV)]));
t.deepEqual([srvReply.answers.map((r) => r.type), srvReply.additionals.map((r) => r.type)], [[TYPE.SRV], [TYPE.A]], "an SRV query gets SRV with A");
const txtReply = decodeReply(reply([q(fqdn, TYPE.TXT)]));
t.deepEqual([txtReply.answers.map((r) => r.type), txtReply.additionals.length], [[TYPE.TXT], 0], "a TXT query gets TXT only");
const anyReply = decodeReply(reply([q(fqdn, TYPE.ANY)]));
t.deepEqual(anyReply.answers.map((r) => r.type), [TYPE.SRV, TYPE.TXT], "an ANY query for the instance gets SRV and TXT");
const aReply = decodeReply(reply([q("windock-0f1e2d3c.local", TYPE.A)]));
t.equal(aReply.answers[0].data, "192.168.1.40", "an A query for our host label is answered");
t.ok(reply([q("WINDOCK-0F1E2D3C.LOCAL", TYPE.A)]) !== null, "names match case-insensitively");
const both = decodeReply(reply([q("_windock._tcp.local", TYPE.PTR), q(fqdn, TYPE.SRV)]));
t.deepEqual([both.answers.map((r) => r.type), both.additionals.map((r) => r.type)], [[TYPE.PTR, TYPE.SRV], [TYPE.TXT, TYPE.A]],
  "a record is never both an answer and an additional");

t.equal(reply([q("windock-0f1e2d3c.local", TYPE.AAAA)]), null, "AAAA for our host is not answered (IPv4 only)");
t.equal(reply([q("_airplay._tcp.local", TYPE.PTR)]), null, "other services are ignored");
t.equal(reply([q(["Other", "_windock", "_tcp", "local"], TYPE.SRV)]), null, "other instances are ignored");
t.equal(reply([q("Studio-Mac.local", TYPE.A)]), null, "the OS's own host name is left to the OS");
t.equal(reply([q("_windock._tcp.local", TYPE.SRV)]), null, "the wrong type for the service name is ignored");
t.equal(reply([q("_windock._tcp.local", TYPE.PTR, false, 3)]), null, "the CHAOS class is ignored");
t.equal(reply([]), null, "a packet without questions is ignored");
t.equal(reply([q("_windock._tcp.local", TYPE.PTR)], rinfo, { flags: 0x8400 }), null, "responses are never answered");
t.equal(reply([q("_windock._tcp.local", TYPE.PTR)], rinfo, { flags: 0x2800 }), null, "non-query opcodes are ignored");

const qu = reply([q("_windock._tcp.local", TYPE.PTR, true)]);
t.ok(qu && !qu.multicast && qu.address === rinfo.address && qu.port === MDNS_PORT, "a QU query is answered by unicast to the querier");
const legacyInfo = { address: "192.168.1.77", port: 50123 };
const legacy = reply([q("_windock._tcp.local", TYPE.PTR)], legacyInfo, { id: 0x4242 });
t.ok(legacy && !legacy.multicast && legacy.address === legacyInfo.address && legacy.port === 50123, "a query from another port is answered by unicast to that port");
const legacyPacket = decodeReply(legacy);
t.equal(legacyPacket.id, 0x4242, "a legacy reply echoes the query ID");
t.equal(legacyPacket.questions.length, 1, "a legacy reply echoes the question");
t.ok([...legacyPacket.answers, ...legacyPacket.additionals].every((r) => r.ttl <= 10 && !r.flush), "legacy replies use TTL ≤ 10 and no cache-flush bit");

const valid = query([q("_windock._tcp.local", TYPE.PTR)]);
t.equal(responseFor(Buffer.concat([valid, Buffer.alloc(MAX_PACKET_BYTES)]), rinfo, records), null, "packets over 9000 bytes are ignored");
t.equal(responseFor(valid.subarray(0, valid.length - 2), rinfo, records), null, "a truncated query is ignored");
t.equal(responseFor(Buffer.from("windock:discover:v1"), rinfo, records), null, "a non-DNS datagram is ignored");
t.equal(responseFor("text", rinfo, records), null, "a non-Buffer is ignored");
t.equal(responseFor(valid, null, records), null, "a datagram without sender info is ignored");
const withKnownAnswerJunk = Buffer.concat([valid.subarray(0, 6), Buffer.from([0, 1]), valid.subarray(8), Buffer.from([0xff])]);
t.ok(responseFor(withKnownAnswerJunk, rinfo, records) !== null, "an unparseable known-answer section does not stop the answer");
t.ok(ptr.packet.length < 512, "a full reply stays small");
t.deepEqual(answersFor(null, records).answers, [], "answersFor tolerates a missing query");

// ---- macOS: dns-sd ----
function fakeChildSpawner({ throwCode, errorCode, exitEarly } = {}) {
  const calls = [];
  const spawn = (cmd, argv, options) => {
    calls.push({ cmd, argv, options });
    if (throwCode) throw Object.assign(new Error("spawn failed"), { code: throwCode });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = [];
    child.kill = (signal) => { child.killed.push(signal); setImmediate(() => child.emit("exit", null, signal)); return true; };
    if (errorCode) setImmediate(() => child.emit("error", Object.assign(new Error("not found"), { code: errorCode })));
    if (exitEarly) setImmediate(() => { child.stderr.emit("data", Buffer.from("DNSService call failed -65540\n")); child.emit("exit", 1, null); });
    calls.child = child;
    return child;
  };
  return { spawn, calls };
}
const logs = [];
const log = (line) => logs.push(line);
const exitListeners = process.listenerCount("exit");

const mac = fakeChildSpawner();
const adv = startBonjour({ name: "Studio-Mac.local", port: 18710, txt: TXT, platform: "darwin", spawn: mac.spawn, log });
t.equal(adv.kind, "dns-sd", "macOS uses dns-sd");
t.equal(mac.calls[0].cmd, DNS_SD_PATH, "dns-sd is run by absolute path");
t.deepEqual(mac.calls[0].argv, ["-R", "Studio-Mac", "_windock._tcp", "local", "18710", ...txtEntries(TXT)], "dns-sd argv is exact");
t.equal(mac.calls[0].options.shell, false, "dns-sd runs without a shell");
t.deepEqual(mac.calls[0].options.stdio, ["ignore", "ignore", "pipe"], "only stderr is captured; nothing is inherited");
t.equal(process.listenerCount("exit"), exitListeners + 1, "dns-sd is killed when the host exits");
await adv.stop();
t.deepEqual(mac.calls.child.killed, ["SIGTERM"], "stop() kills dns-sd");
t.equal(process.listenerCount("exit"), exitListeners, "stop() removes the exit hook");
await adv.stop();
t.deepEqual(mac.calls.child.killed, ["SIGTERM"], "a second stop() is harmless");
t.equal(logs.length, 0, "a normal stop logs nothing");
t.equal(process.listenerCount("SIGTERM"), 0, "stop() removes the signal hooks");

// A termination signal kills dns-sd (Node skips "exit" on signals). Another
// SIGTERM listener stands in so the signal is not re-raised at this process.
const sigMac = fakeChildSpawner();
const sigAdv = startBonjour({ name: "s", port: 1, txt: {}, platform: "darwin", spawn: sigMac.spawn, log });
t.equal(process.listenerCount("SIGTERM"), 1, "dns-sd is killed on SIGTERM");
const standIn = () => {};
process.on("SIGTERM", standIn);
process.emit("SIGTERM", "SIGTERM");
process.off("SIGTERM", standIn);
t.deepEqual(sigMac.calls.child.killed, ["SIGTERM"], "SIGTERM to the host kills dns-sd");
t.ok(process.listenerCount("SIGTERM") === 0 && process.listenerCount("exit") === exitListeners, "the hooks are removed after the signal");
await sigAdv.stop();

const missing = fakeChildSpawner({ errorCode: "ENOENT" });
let missingAdv;
t.ok((() => { missingAdv = startBonjour({ name: "m", port: 1, txt: {}, platform: "darwin", spawn: missing.spawn, log }); return true; })(), "a missing dns-sd does not throw");
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
t.equal(logs.length, 1, "a missing dns-sd logs one line");
t.ok(/ENOENT/.test(logs[0] || ""), "the line names the error");
await missingAdv.stop();
t.equal(process.listenerCount("exit"), exitListeners, "a failed dns-sd leaves no exit hook");

logs.length = 0;
const thrown = startBonjour({ name: "m", port: 1, txt: {}, platform: "darwin", spawn: fakeChildSpawner({ throwCode: "EACCES" }).spawn, log });
t.equal(thrown.kind, "none", "a spawn that throws gives kind none");
t.equal(logs.length, 1, "and logs one line");

logs.length = 0;
const early = fakeChildSpawner({ exitEarly: true });
const earlyAdv = startBonjour({ name: "m", port: 1, txt: {}, platform: "darwin", spawn: early.spawn, log });
await new Promise((r) => setImmediate(r));
t.equal(logs.length, 1, "an early dns-sd exit logs one line");
t.ok(/-65540/.test(logs[0] || ""), "the line carries dns-sd's stderr");
await earlyAdv.stop();
t.deepEqual(early.calls.child.killed, [], "an exited dns-sd is not killed again");

// ---- Windows/Linux: the JS responder ----
function fakeSocket() {
  const s = new EventEmitter();
  s.sent = [];
  s.calls = [];
  s.bind = (port, cb) => { s.calls.push(["bind", port]); setImmediate(cb); };
  s.addMembership = (group, iface) => s.calls.push(["addMembership", group, iface]);
  s.setMulticastInterface = (iface) => s.calls.push(["setMulticastInterface", iface]);
  s.setMulticastTTL = (ttl) => s.calls.push(["setMulticastTTL", ttl]);
  s.setMulticastLoopback = () => {};
  s.send = (packet, port, address, cb) => { s.sent.push({ packet, port, address }); setImmediate(() => cb?.()); };
  s.close = (cb) => { s.closed = true; setImmediate(() => cb?.()); };
  return s;
}
let sock;
let timerFn = null;
let clock = 10_000;
logs.length = 0;
const js = startBonjour({
  name: "DESKTOP-1",
  port: 18711,
  txt: { ...TXT, os: "windows" },
  platform: "win32",
  socketFactory: () => (sock = fakeSocket()),
  setTimer: (fn, ms) => { timerFn = ms === 1000 ? fn : timerFn; return { unref() {} }; },
  now: () => clock,
  log,
});
t.equal(js.kind, "mdns", "Windows uses the JS responder");
await new Promise((r) => setImmediate(r));
t.deepEqual(sock.calls, [["bind", 5353], ["addMembership", MDNS_ADDRESS, "192.168.1.40"], ["setMulticastInterface", "192.168.1.40"], ["setMulticastTTL", 255]],
  "binds 5353, joins 224.0.0.251 on the LAN address, multicast TTL 255");
t.equal(sock.sent.length, 1, "an announcement goes out at start");
t.ok(typeof timerFn === "function", "a second announcement is scheduled 1 s later");
timerFn();
t.equal(sock.sent.length, 2, "the announcement is sent twice");
const announced = decodePacket(sock.sent[0].packet);
t.ok(sock.sent[0].address === MDNS_ADDRESS && sock.sent[0].port === MDNS_PORT, "announcements are multicast");
t.deepEqual(announced.answers.map((r) => r.type), [TYPE.PTR, TYPE.PTR, TYPE.SRV, TYPE.TXT, TYPE.A], "the announcement carries every record");
t.equal(announced.answers[2].data.port, 18711, "the SRV names the host's port");
t.deepEqual(announced.answers[2].data.target, ["windock-0f1e2d3c", "local"], "the SRV targets the WinDock host label");
t.ok(announced.answers.every((r) => r.ttl > 0), "announcement TTLs are positive");

sock.emit("message", valid, rinfo);
t.equal(sock.sent.length, 3, "a query is answered");
sock.emit("message", valid, rinfo);
t.equal(sock.sent.length, 3, "the same multicast answer is not repeated within a second");
clock += 1001;
sock.emit("message", valid, rinfo);
t.equal(sock.sent.length, 4, "it is answered again after a second");
sock.emit("message", query([q("_windock._tcp.local", TYPE.PTR, true)]), rinfo);
t.equal(sock.sent.length, 5, "QU answers are not throttled");
t.equal(sock.sent[4].address, rinfo.address, "QU answers go to the querier");
sock.emit("message", ptr.packet, rinfo);
sock.emit("message", Buffer.alloc(MAX_PACKET_BYTES + 1), rinfo);
sock.emit("message", Buffer.from([1, 2, 3]), rinfo);
t.equal(sock.sent.length, 5, "responses, oversized and malformed datagrams get no reply");

await js.stop();
const bye = decodePacket(sock.sent.at(-1).packet);
t.ok(sock.sent.at(-1).address === MDNS_ADDRESS, "the goodbye is multicast");
t.ok(bye.answers.length === 5 && bye.answers.every((r) => r.ttl === 0), "stop() sends a goodbye with TTL 0 for every record");
t.ok(sock.closed, "stop() closes the socket");
const sentAfterStop = sock.sent.length;
sock.emit("message", valid, rinfo);
t.equal(sock.sent.length, sentAfterStop, "nothing is sent after stop()");
t.equal(logs.length, 0, "a normal run logs nothing");

const broken = startBonjour({ name: "x", port: 18711, txt: TXT, platform: "linux", socketFactory: () => (sock = fakeSocket()), log });
sock.emit("error", Object.assign(new Error("in use"), { code: "EADDRINUSE" }));
t.equal(logs.length, 1, "a socket error logs one line and is not thrown");
await broken.stop();

logs.length = 0;
t.equal(startBonjour({ name: "x", port: 18711, txt: { ...TXT, addr: null }, platform: "linux", socketFactory: fakeSocket, log }).kind, "none",
  "no LAN address: no responder");
t.equal(startBonjour({ name: "x", port: 18711, txt: TXT, platform: "freebsd", log }).kind, "none", "other platforms: none");
t.equal(startBonjour({ name: "x", port: 0, txt: TXT, platform: "linux", socketFactory: fakeSocket, log }).kind, "none", "a bad port: none");
t.equal(startBonjour({ name: "x", port: 1, txt: { "bad=key": 1 }, platform: "darwin", spawn: mac.spawn, log }).kind, "none", "a bad TXT: none, never thrown");
t.equal(startBonjour({ log }).kind, "none", "no name or port: none, never thrown");

// ---- start() wiring ----
const { start } = await import("../server.js");
const scratch = await mkdtemp(join(tmpdir(), "windock-bonjour-"));
const savedConfig = process.env.WINDOCK_CONFIG;
process.env.WINDOCK_CONFIG = join(scratch, "config.json");
const env = { WINDOCK_CONFIG: process.env.WINDOCK_CONFIG };
async function shutdown(app) {
  await app.discovery.close();
  await app.hub.close();
  await app.inputHub.close();
  app.listener.closeAllConnections();
  await new Promise((r) => app.listener.close(r));
}
const seen = [];
let stopped = 0;
const advertise = (opts) => { seen.push(opts); return { kind: "fake", stop: async () => { stopped += 1; } }; };
const started = await start({ port: 0, env, discoveryPort: 0, advertise });
t.equal(seen.length, 1, "start() advertises once");
t.equal(seen[0].port, started.port, "the advertised port is the listening port");
t.equal(seen[0].name, hostname(), "the instance is named after the host name");
t.equal(seen[0].txt.id, started.identity.hostId, "TXT id is the host ID");
t.equal(seen[0].txt.tls, "1", "TXT tls=1 with TLS on");
t.equal(seen[0].txt.api, "1", "TXT api=1");
t.equal(started.bonjour.kind, "fake", "start() returns the advertiser");
await shutdown(started);
await new Promise((r) => setImmediate(r));
t.equal(stopped, 1, "closing the server stops advertising");
const off = await start({ port: 0, env: { ...env, WINDOCK_BONJOUR: "0" }, discoveryPort: 0, advertise });
t.ok(seen.length === 1 && off.bonjour.kind === "none", "WINDOCK_BONJOUR=0 turns advertising off");
await shutdown(off);
if (savedConfig === undefined) delete process.env.WINDOCK_CONFIG;
else process.env.WINDOCK_CONFIG = savedConfig;
await rm(scratch, { recursive: true, force: true });

t.done("bonjour verification passed");
