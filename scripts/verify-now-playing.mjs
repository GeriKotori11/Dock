import { createNowPlayingPoller, createMediaPoller, normalizeMedia, fromNowPlaying, mediaPosition, formatTime, spokenTime, safeArtwork } from "../public/now-playing.js";
import { createChecker } from "./lib/assert.mjs";

const t = createChecker("now-playing");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Media polling did not update");
    await sleep(5);
  }
}
let active = false, calls = 0, fail = false;
let media = { title: "First", artist: "Artist", playing: true };
const updates = [];
const poller = createNowPlayingPoller({
  intervalMs: 15,
  isActive: () => active,
  load: async () => { calls++; if (fail) throw new Error("temporary failure"); return media; },
  onChange: value => updates.push(value),
});
try {
  await sleep(50);
  t.equal(calls, 0, "inactive clients do not poll");
  active = true;
  await until(() => updates.length > 0);
  t.deepEqual(updates.at(-1), media, "active client fetches without manual refresh");
  media = { title: "Second", artist: "Other artist", playing: true };
  await until(() => updates.at(-1)?.title === "Second");
  t.deepEqual(updates.at(-1), media, "track and artist update automatically");
  media = { ...media, playing: false };
  await until(() => updates.at(-1)?.playing === false);
  t.equal(updates.at(-1).playing, false, "external pause updates automatically");
  media = null;
  await until(() => updates.at(-1) === null);
  t.equal(updates.at(-1), null, "ended session clears media");
  const previousUpdates = updates.length;
  fail = true;
  const previousCalls = calls;
  await until(() => calls > previousCalls + 1);
  t.equal(updates.length, previousUpdates, "failed requests preserve the last display");
  fail = false; media = { title: "Recovered", playing: true };
  await until(() => updates.at(-1)?.title === "Recovered");
  t.equal(updates.at(-1).title, "Recovered", "polling recovers after an error");
  active = false;
  const inactiveCalls = calls;
  await sleep(50);
  t.equal(calls, inactiveCalls, "polling pauses when hidden, disconnected or unpaired");
  media = { title: "Manual", playing: true };
  await poller.refresh();
  t.equal(updates.at(-1).title, "Manual", "explicit boot/resume refresh still works while inactive");
} finally { poller.stop(); }

let finish, slowCalls = 0;
const slow = createNowPlayingPoller({
  intervalMs: 10, isActive: () => true,
  load: () => { slowCalls++; return new Promise(resolve => { finish = resolve; }); },
  onChange: () => {},
});
try {
  const first = slow.refresh();
  t.equal(slow.refresh(), first, "manual and timer refresh share the pending request");
  await sleep(60);
  t.equal(slowCalls, 1, "a slow request does not accumulate more requests");
  finish(media); await first;
} finally { slow.stop(); }

let timedOut = false, recovered = false, timeoutUpdates = 0;
const timeout = createNowPlayingPoller({
  intervalMs: 15, timeoutMs: 30, isActive: () => true,
  load: signal => recovered ? Promise.resolve(media) : new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { timedOut = true; recovered = true; reject(new Error("aborted")); }, { once: true });
  }),
  onChange: () => timeoutUpdates++,
});
try {
  await until(() => timeoutUpdates > 0);
  t.ok(timedOut, "unresponsive HTTP fetch is aborted");
  t.ok(timeoutUpdates > 0, "a timeout does not permanently block polling");
} finally { timeout.stop(); }
const stoppedCount = timeoutUpdates;
await sleep(50);
t.equal(timeoutUpdates, stoppedCount, "stopped poller never renders again");

// ---- the media model (DOCK-CONTROLS 7.3, 8.3) ----
t.equal(createMediaPoller, createNowPlayingPoller, "the media poller is the same single-flight poller");
const rich = normalizeMedia({ source: { id: "spotify", name: "Spotify", appId: "com.spotify.client", sessionId: "s" }, title: " Houdini ", artist: "Dua Lipa", album: "Radical Optimism", playing: true, positionMs: 72000, durationMs: 185000, updatedAt: 1, artwork: "/api/media/artwork?key=9f2c", controls: { previous: true, next: false, playPause: true, seek: true, shuffle: true, repeat: true }, shuffle: true, repeat: "all", sessions: [{ sessionId: "s", name: "Spotify", current: true }, { name: "no id" }], permission: { player: "spotify", status: "granted" } });
t.equal(rich.active, true, "a source means a session");
t.equal(rich.title, "Houdini", "titles are trimmed");
t.deepEqual(rich.controls, { previous: true, next: false, playPause: true, seek: true, shuffle: true, repeat: true }, "per-source controls are read");
t.equal(rich.sessions.length, 1, "sessions without an id are dropped");
t.equal(rich.repeat, "all", "repeat is read");
t.equal(normalizeMedia({ source: { name: "X" }, repeat: "sometimes" }).repeat, "off", "an unknown repeat reads as off");
t.equal(normalizeMedia({ source: null, title: "Ghost" }).active, false, "source null means nothing playing");
t.equal(normalizeMedia(null).active, false, "a missing body means nothing playing");
t.equal(normalizeMedia({ source: { name: "X" }, controls: { seek: true } }).controls.seek, false, "seek needs a duration");
t.equal(normalizeMedia({ source: { name: "X" }, durationMs: 1000, positionMs: 5000 }).positionMs, 1000, "position is clamped to the duration");
t.equal(safeArtwork("/api/media/artwork?key=abc-1"), "/api/media/artwork?key=abc-1", "the host's artwork route is accepted");
for (const bad of ["https://i.scdn.co/image/x", "//evil/api/media/artwork?key=1", "/api/media/artwork?key=1\" onerror=\"x", "javascript:alert(1)", "/api/apps/icon?id=x", 42]) {
  t.equal(safeArtwork(bad), null, `artwork outside the host route is refused: ${String(bad).slice(0, 30)}`);
}
const legacy = fromNowPlaying({ title: "Song", artist: "Artist", playing: true }, { previous: false, playPause: true, next: true });
t.ok(legacy.active && legacy.legacy && legacy.source === null && legacy.artwork === null, "an older host's now playing maps to a session with no source or artwork");
t.deepEqual(legacy.controls, { previous: false, next: true, playPause: true, seek: false, shuffle: false, repeat: false }, "legacy transport follows the host's verbs");
t.equal(fromNowPlaying(null).active, false, "no legacy now playing means no session");
t.equal(mediaPosition(rich, 10_000, 12_500), 74_500, "position is interpolated while playing");
t.equal(mediaPosition({ ...rich, playing: false }, 10_000, 12_500), 72_000, "paused position stands still");
t.equal(mediaPosition(rich, 10_000, 10_000 + 999_999), 185_000, "interpolation stops at the end");
t.equal(mediaPosition(normalizeMedia({ source: { name: "X" } }), 0, 1), null, "no timeline, no position");
t.equal(formatTime(72_000), "1:12", "1:12");
t.equal(formatTime(3_723_000), "1:02:03", "hours");
t.equal(spokenTime(72_000), "1 minute 12 seconds", "spoken position");
t.equal(spokenTime(185_000), "3 minutes 5 seconds", "spoken duration");
t.equal(spokenTime(61_000), "1 minute 1 second", "singular units");
// Flicker regression (pause -> play -> pause): a poll that started before a
// command must never overwrite the optimistic state or the command's reply.
{
  let clock = 0;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const loads = [], applied = [];
  const p = createMediaPoller({
    intervalMs: 1e9, isActive: () => false, now: () => clock,
    load: () => new Promise((resolve) => loads.push(resolve)),
    onChange: (value) => applied.push(value),
  });
  const stale = p.refresh(); // started while the player was still playing
  let reply;
  const command = p.command(() => new Promise((resolve) => { reply = resolve; }));
  await flush(); loads[0]({ playing: true });
  await stale;
  t.equal(applied.length, 0, "a poll that started before the command is discarded while the command runs");
  const during = p.refresh(); // started during the command, host may still be stale
  reply({ playing: false });
  t.deepEqual(await command, { playing: false }, "command() hands back the reply");
  t.deepEqual(applied, [{ playing: false }], "the command's reply is applied as the shared state");
  await flush(); loads[1]({ playing: true });
  await during;
  t.deepEqual(applied, [{ playing: false }], "a poll that started before the reply arrived is discarded");
  const fresh = p.refresh();
  await flush(); loads[2]({ playing: false, title: "next poll" });
  await fresh;
  t.equal(applied.at(-1).title, "next poll", "a poll that started after the reply is applied");
  // A command without a reply (older hosts): polls after it settle are accepted.
  await p.command(() => Promise.resolve(null));
  const after = p.refresh();
  await flush(); loads[3]({ playing: true, title: "legacy" });
  await after;
  t.equal(applied.at(-1).title, "legacy", "after a reply-less command, the next poll is accepted");
  // A command that hangs: after ~2 s polls are accepted again.
  p.command(() => new Promise(() => {}));
  const early = p.refresh();
  await flush(); loads[4]({ title: "too early" });
  await early;
  t.ok(applied.at(-1).title !== "too early", "while a command is pending, polls are held");
  clock += 2100;
  const late = p.refresh();
  await flush(); loads[5]({ title: "after timeout" });
  await late;
  t.equal(applied.at(-1).title, "after timeout", "after the 2 s hold a poll is accepted even if the command never answered");
  // A failed command still releases the hold.
  const q = createMediaPoller({ intervalMs: 1e9, isActive: () => false, now: () => clock, load: async () => ({ title: "after failure" }), onChange: (v) => applied.push(v) });
  await q.command(() => Promise.reject(new Error("boom"))).catch(() => {});
  await q.refresh();
  t.equal(applied.at(-1).title, "after failure", "a failed command does not block later polls");
  p.stop(); q.stop();
}
t.done("now-playing verification passed");
