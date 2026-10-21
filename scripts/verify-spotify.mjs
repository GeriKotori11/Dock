/**
 * Spotify Phase B oracle (docs/design/DOCK-CONTROLS.md 8.8 and 12, host
 * side): PKCE, the single-use state, the loopback-only callback, token
 * exchange and refresh, the secret stores (no token in any argv), every phone
 * route with its error mapping, input validation, the image host allowlist,
 * Spotify tiles and the capability map. Spotify itself is a fake behind an
 * injected fetch; nothing here touches the network, a browser or a keychain.
 */
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createChecker } from "./lib/assert.mjs";
import { createApp } from "../server.js";
import { createConfigStore, normalizeTile, normalizeTiles, normalizeConfig } from "../src/config.js";
import { featuresOf, spotifyAccountFeature } from "../src/platform/contract.js";
import {
  SPOTIFY_SCOPES,
  SPOTIFY_IMAGE_HOSTS,
  codeChallenge,
  newVerifier,
  authorizeUrl,
  parseSpotifyUri,
  redirectUriFor,
  searchParams,
  pageParams,
  validatePlay,
  validateQueue,
  validateTransfer,
  validateLike,
  validClientId,
  spotifyImageUrl,
  spotifyImageKey,
  pickImage,
} from "../src/spotify/contract.js";
import {
  createKeychainStore,
  createDpapiStore,
  createFileStore,
  createMemoryTokenStore,
  createTokenStore,
  KEYCHAIN_SERVICE,
  KEYCHAIN_NOT_FOUND,
  SECURITY,
} from "../src/spotify/token-store.js";
import { openCommand, createBrowserOpener } from "../src/spotify/open-browser.js";
import { callbackProblem, callbackPage, CALLBACK_HEADERS } from "../src/spotify/routes.js";

const t = createChecker("spotify");
const dir = await mkdtemp(join(tmpdir(), "windock-spotify-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT = "0123456789abcdef0123456789abcdef";
const ID = (c) => c.repeat(22).slice(0, 22);
const PL1 = "37i9dQZF1DXcBWIGoYBM5M";
const PL2 = "1A2b3C4d5E6f7G8h9I0jKl";
const ALB = "4aawyAB9vmqN3uQ7FjRGTy";
const TRK = "7a3LWj5xSFhFRYmztS8wgK";
const ART = "2takcwOaAZWiXQijPHIx7B";

/** PNG bytes with the given IHDR size (enough for imageInfo). */
function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

// =========================================================================
// 1. pure contract
// =========================================================================

// RFC 7636 appendix B test vector.
t.equal(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "S256 challenge matches the RFC 7636 vector");
const verifier = newVerifier((n) => Buffer.alloc(n, 7));
t.ok(verifier.length >= 43 && verifier.length <= 128 && /^[A-Za-z0-9_-]+$/.test(verifier), "verifier is 43..128 unreserved characters");
t.equal(codeChallenge(verifier), createHash("sha256").update(verifier).digest("base64url"), "challenge = base64url(sha256(verifier))");
const au = new URL(authorizeUrl({ clientId: CLIENT, redirectUri: redirectUriFor(8620), state: "s1", challenge: "c1" }));
t.equal(au.origin + au.pathname, "https://accounts.spotify.com/authorize", "authorize endpoint");
t.deepEqual(Object.fromEntries(au.searchParams), {
  client_id: CLIENT, response_type: "code", redirect_uri: "http://127.0.0.1:8620/api/spotify/callback",
  code_challenge_method: "S256", code_challenge: "c1", state: "s1", scope: SPOTIFY_SCOPES.join(" "),
}, "authorize parameters");
t.deepEqual([...SPOTIFY_SCOPES].sort(), ["playlist-read-collaborative", "playlist-read-private", "user-library-modify", "user-library-read", "user-modify-playback-state", "user-read-currently-playing", "user-read-playback-state", "user-read-private"], "scopes per section 12");
t.equal(redirectUriFor(18950), "http://127.0.0.1:18950/api/spotify/callback", "redirect URI uses the loopback IP literal");
t.equal(redirectUriFor(null), null, "no port, no redirect URI");
t.ok(validClientId(CLIENT) && !validClientId(CLIENT.toUpperCase()) && !validClientId(CLIENT.slice(1)) && !validClientId(`${CLIENT}0`), "client ID: 32 lowercase hex");

t.deepEqual(parseSpotifyUri(`spotify:playlist:${PL1}`, ["playlist"]), { type: "playlist", id: PL1, uri: `spotify:playlist:${PL1}` }, "playlist URI parses");
for (const bad of [`spotify:playlist:${PL1}x`, `spotify:playlist:${PL1.slice(1)}`, `spotify:track:${TRK}`, `spotify:playlist:${PL1.slice(0, 21)}!`, `https://open.spotify.com/playlist/${PL1}`, 42, null]) {
  t.equal(parseSpotifyUri(bad, ["playlist"]), null, `bad URI refused: ${String(bad).slice(0, 40)}`);
}
const sp = (o) => new URLSearchParams(o);
t.deepEqual(searchParams(sp({ q: " houdini " })), { ok: true, q: "houdini", types: ["track", "artist", "album", "playlist"], offset: 0, limit: 10 }, "search defaults: all four sections, limit 10 (the 2026 maximum)");
t.deepEqual(searchParams(sp({ q: "x", types: "songs,albums" })).types, ["track", "album"], "search type aliases");
t.equal(searchParams(sp({ q: "" })).ok, false, "search needs q");
t.equal(searchParams(sp({ q: "x".repeat(101) })).ok, false, "q at most 100 characters");
t.equal(searchParams(sp({ q: "x".repeat(100) })).ok, true, "q of 100 characters is fine");
t.equal(searchParams(sp({ q: "x", types: "track,show" })).ok, false, "unknown search type refused");
t.equal(searchParams(sp({ q: "x", limit: "11" })).ok, false, "search limit above 10 refused");
t.equal(searchParams(sp({ q: "x", offset: "1001" })).ok, false, "search offset above 1000 refused");
t.deepEqual(pageParams(sp({})), { ok: true, offset: 0, limit: 50 }, "library page defaults");
for (const bad of [{ limit: "0" }, { limit: "51" }, { offset: "-1" }, { offset: "1.5" }, { limit: "abc" }, { offset: "100001" }]) {
  t.equal(pageParams(sp(bad)).ok, false, `bad page refused: ${JSON.stringify(bad)}`);
}
t.deepEqual(validatePlay({ contextUri: `spotify:playlist:${PL1}`, uri: `spotify:track:${TRK}`, deviceId: "abc123" }), { ok: true, uri: `spotify:track:${TRK}`, contextUri: `spotify:playlist:${PL1}`, deviceId: "abc123" }, "play: context + start item + device");
t.deepEqual(validatePlay({}), { ok: true, deviceId: undefined }, "play with nothing resumes");
for (const bad of [{ uri: `spotify:album:${ALB}` }, { contextUri: `spotify:track:${TRK}` }, { contextUri: `spotify:artist:${ART}`, uri: `spotify:track:${TRK}` }, { deviceId: "a b" }, { deviceId: "x".repeat(129) }, { uri: "spotify:track:../../me" }]) {
  t.equal(validatePlay(bad).ok, false, `bad play refused: ${JSON.stringify(bad).slice(0, 60)}`);
}
t.equal(validateQueue({ uri: `spotify:playlist:${PL1}` }).ok, false, "queue takes tracks/episodes only");
t.equal(validateQueue({ uri: `spotify:track:${TRK}` }).ok, true, "queue a track");
t.equal(validateTransfer({}).ok, false, "transfer needs a deviceId");
t.equal(validateTransfer({ deviceId: "74ASZWbe4lXaubB36ztrGX", play: "yes" }).ok, false, "transfer play must be boolean");
t.equal(validateLike({ trackId: TRK, liked: "true" }).ok, false, "like needs a boolean");
t.equal(validateLike({ trackId: `spotify:track:${TRK}`, liked: true }).ok, false, "like takes a bare track ID");

for (const host of SPOTIFY_IMAGE_HOSTS) t.ok(spotifyImageUrl(`https://${host}/image/ab67`), `image host allowed: ${host}`);
for (const bad of ["http://i.scdn.co/image/x", "https://evil.example/i.scdn.co", "https://i.scdn.co.evil.example/x", "https://user:pw@i.scdn.co/x", "https://i.scdn.co:444/x", "https://scdn.co/x", "https://image-cdn-zz.spotifycdn.com/x", "file:///etc/passwd", 42]) {
  t.equal(spotifyImageUrl(bad), null, `image URL refused: ${String(bad)}`);
}
t.equal(pickImage([{ url: "https://i.scdn.co/640", width: 640, height: 640 }, { url: "https://i.scdn.co/300", width: 300, height: 300 }, { url: "https://i.scdn.co/64", width: 64, height: 64 }]), "https://i.scdn.co/300", "the 300 px variant is picked");
t.equal(pickImage([{ url: "https://mosaic.scdn.co/640/x", width: 640, height: 640 }]), "https://mosaic.scdn.co/640/x", "only a larger one: that one");
t.equal(pickImage([{ url: "https://image-cdn-fa.spotifycdn.com/x", width: null, height: null }]), "https://image-cdn-fa.spotifycdn.com/x", "unsized images are usable");
t.equal(pickImage([{ url: "https://evil.example/a.jpg", width: 300, height: 300 }]), null, "an off-list image host is never picked");

// callback guard and pages
const fakeReq = (headers, method = "GET") => ({ method, headers, socket: {} });
t.equal(callbackProblem(fakeReq({ host: "127.0.0.1:8620", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" }), "127.0.0.1"), null, "a top-level navigation back from Spotify is allowed");
t.equal(callbackProblem(fakeReq({ host: "127.0.0.1:8620" }), "192.168.1.20")?.error, "local only", "a LAN client is refused");
t.equal(callbackProblem(fakeReq({ host: "localhost:8620" }), "127.0.0.1")?.error, "local only", "Host must be the 127.0.0.1 literal");
t.equal(callbackProblem(fakeReq({ host: "evil.example:8620" }), "127.0.0.1")?.error, "local only", "a rebound DNS name is refused");
t.equal(callbackProblem(fakeReq({ host: "127.0.0.1:8620", "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" }), "127.0.0.1")?.error, "cross-site request", "an <img> aimed at the callback is refused");
t.equal(callbackProblem(fakeReq({ host: "127.0.0.1:8620", "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" }), "127.0.0.1")?.error, "cross-site request", "a frame is refused");
t.equal(callbackProblem(fakeReq({ host: "127.0.0.1:8620", origin: "https://evil.example" }), "127.0.0.1")?.error, "cross-site request", "a foreign Origin is refused");
t.equal(callbackProblem(fakeReq({ host: "127.0.0.1:8620" }, "POST"), "127.0.0.1")?.status, 405, "only GET");
t.ok(callbackPage("connected").includes("Connected. You can close this tab."), "success page copy (sp.browser.done)");
t.ok(!callbackPage("<script>").includes("<script>"), "an unknown outcome falls back to constant text");
t.ok(/default-src 'none'/.test(CALLBACK_HEADERS["content-security-policy"]) && CALLBACK_HEADERS["referrer-policy"] === "no-referrer", "callback pages: strict CSP, no referrer");

// =========================================================================
// 2. tiles, config, capability map
// =========================================================================

const tileUri = `spotify:playlist:${PL1}`;
t.deepEqual(normalizeTile({ kind: "spotify", uri: tileUri, label: "Chill", image: "a".repeat(32) }), { kind: "spotify", uri: tileUri, label: "Chill", image: "a".repeat(32) }, "a Spotify tile normalizes");
t.deepEqual(normalizeTile({ kind: "spotify", uri: `spotify:album:${ALB}`, image: "<x>" }), { kind: "spotify", uri: `spotify:album:${ALB}`, label: "Album", image: "" }, "album tile, bad image key dropped");
for (const bad of [`spotify:track:${TRK}`, `spotify:artist:${ART}`, `spotify:playlist:${PL1}0`, "javascript:alert(1)", undefined]) {
  t.equal(normalizeTile({ kind: "spotify", uri: bad, label: "x" }), null, `Spotify tile refused: ${bad}`);
}
const deduped = normalizeTiles([{ kind: "spotify", uri: tileUri, label: "a" }, { kind: "spotify", uri: tileUri, label: "b" }, { kind: "app", id: "x", target: "/x" }]);
t.deepEqual(deduped.map((x) => x.label), ["a", "x"], "Spotify tiles de-duplicate on spotify:<uri>");
t.deepEqual(normalizeConfig({ tiles: [], spotify: { clientId: CLIENT, extra: 1 } }), { version: 1, tiles: [], spotify: { clientId: CLIENT } }, "the config keeps a valid client ID");
t.deepEqual(normalizeConfig({ tiles: [], spotify: { clientId: "nope" } }), { version: 1, tiles: [] }, "an invalid client ID is dropped");
{
  const path = join(dir, "roundtrip.json");
  const store = createConfigStore({ path });
  await store.save({ tiles: [{ kind: "spotify", uri: tileUri, label: "Chill", image: "" }], spotify: { clientId: CLIENT } });
  await store.save({ tiles: [{ kind: "spotify", uri: tileUri, label: "Chill 2", image: "" }] });
  const fresh = createConfigStore({ path });
  const loaded = await fresh.load();
  t.deepEqual(loaded, { version: 1, tiles: [{ kind: "spotify", uri: tileUri, label: "Chill 2", image: "" }], spotify: { clientId: CLIENT } }, "tiles and client ID survive a tiles-only save and a reload");
  await fresh.save({ tiles: [], spotify: null });
  t.equal((await createConfigStore({ path }).load()).spotify, undefined, "spotify: null clears the client ID");
}

t.deepEqual(spotifyAccountFeature(undefined), { available: false }, "no client ID: account not available");
t.deepEqual(spotifyAccountFeature({ available: true, connected: true, premium: "yes", name: "Geri", error: null }), { available: true, connected: true, premium: null, name: "Geri", error: null }, "account feature normalizes");
const linuxLike = featuresOf({}, {}, { spotifyAccount: { available: true, connected: false } });
t.deepEqual(linuxLike.spotify, { installed: false, local: { nowPlaying: false, transport: false, artwork: false, seek: false, shuffle: false, repeat: false }, account: { available: true, connected: false, premium: null, name: null, error: null } }, "a host without a Spotify provider still offers the account");
t.equal(featuresOf({}).spotify, undefined, "unconfigured legacy host: no spotify key");

// =========================================================================
// 3. secret stores: nothing secret in argv
// =========================================================================

const SECRET = { accessToken: "AT-secret-123", refreshToken: "RT-secret-456", expiresAt: 1, clientId: CLIENT };
{
  const calls = [];
  let saved = null;
  const run = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input ?? "" });
    if (args[0] === "-i") {
      const m = /-w (\S+)\n$/.exec(opts.input);
      saved = m ? m[1] : null;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") return saved ? { code: 0, stdout: `${saved}\n`, stderr: "" } : { code: KEYCHAIN_NOT_FOUND, stdout: "", stderr: "" };
    if (args[0] === "delete-generic-password") { const had = saved; saved = null; return { code: had ? 0 : KEYCHAIN_NOT_FOUND, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: "" };
  };
  const kc = createKeychainStore({ account: "host-1", run });
  t.equal(await kc.read(), null, "keychain: nothing stored yet");
  await kc.write(SECRET);
  t.deepEqual(await kc.read(), SECRET, "keychain: round trip");
  await kc.remove();
  await kc.remove();
  t.equal(await kc.read(), null, "keychain: removed (twice is fine)");
  t.ok(calls.every((c) => c.file === SECURITY), "keychain: always /usr/bin/security");
  const argvText = calls.map((c) => c.args.join(" ")).join("\n");
  t.ok(!argvText.includes("AT-secret") && !argvText.includes("RT-secret") && !argvText.includes(Buffer.from(JSON.stringify(SECRET)).toString("base64")), "keychain: no token (plain or encoded) in any argv");
  const writeCall = calls.find((c) => c.args[0] === "-i");
  t.deepEqual(writeCall.args, ["-i"], "keychain write: argv is just -i");
  t.ok(writeCall.input.startsWith(`add-generic-password -U -a host-1 -s ${KEYCHAIN_SERVICE} `), "keychain write: the command travels on stdin");
  t.deepEqual(calls.find((c) => c.args[0] === "find-generic-password").args, ["find-generic-password", "-a", "host-1", "-s", KEYCHAIN_SERVICE, "-w"], "keychain read argv: names only");
  t.throws(() => createKeychainStore({ account: "a b", run }), "keychain names must be simple (stdin command line)");
  await t.rejects(() => createKeychainStore({ account: "h", run: async () => ({ code: 1, stdout: "", stderr: "" }) }).write(SECRET), "keychain: a failed write rejects");
}
{
  const calls = [];
  let blob = null;
  const run = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input ?? "" });
    if (args[0] === "protect-write") { blob = opts.input; return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "protect-read") return { code: 0, stdout: blob, stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const dp = createDpapiStore({ dataDir: dir, helperPath: "C:\\WinDock\\WinDockHelper.exe", run });
  t.equal(await dp.read(), null, "dpapi: no blob file, nothing stored");
  await dp.write(SECRET);
  t.deepEqual(calls[0].args, ["protect-write", join(dir, "spotify-tokens.dpapi")], "dpapi write argv: verb and path");
  t.equal(calls[0].input, JSON.stringify(SECRET), "dpapi: the secret goes on stdin");
  t.ok(!calls.some((c) => c.args.join(" ").includes("secret")), "dpapi: no token in argv");
}
{
  const fs = createFileStore({ dataDir: dir });
  await fs.write(SECRET);
  t.deepEqual(await fs.read(), SECRET, "file store round trip");
  if (process.platform !== "win32") t.equal((await stat(fs.path)).mode & 0o777, 0o600, "file store is 0600");
  await fs.remove();
  t.equal(await fs.read(), null, "file store removed");
  t.equal(createTokenStore({ os: "darwin", account: "h", dataDir: dir, run: async () => ({}) }).kind, "keychain", "macOS uses the Keychain");
  t.equal(createTokenStore({ os: "win32", dataDir: dir, run: async () => ({}) }).kind, "dpapi", "Windows uses DPAPI");
  t.equal(createTokenStore({ os: "linux", dataDir: dir }).kind, "file", "Linux uses the 0600 file");
}

// browser opener
{
  const url = authorizeUrl({ clientId: CLIENT, redirectUri: redirectUriFor(8620), state: "s", challenge: "c" });
  t.deepEqual(openCommand(url, { os: "darwin" }), ["/usr/bin/open", [url]], "macOS opens with /usr/bin/open <url>");
  t.deepEqual(openCommand(url, { os: "win32", env: { SystemRoot: "C:\\Windows" } }), ["C:\\Windows\\System32\\rundll32.exe", ["url.dll,FileProtocolHandler", url]], "Windows opens with rundll32 url.dll,FileProtocolHandler");
  t.deepEqual(openCommand(url, { os: "linux" }), ["xdg-open", [url]], "Linux opens with xdg-open");
  t.throws(() => openCommand("https://evil.example/?x", { os: "darwin" }), "only the Spotify authorize URL is ever opened");
  t.throws(() => openCommand("file:///Applications/Calculator.app", { os: "darwin" }), "never a file URL");
  const ran = [];
  await createBrowserOpener({ os: "darwin", run: async (f, a) => ran.push([f, a]) })(url);
  t.deepEqual(ran, [["/usr/bin/open", [url]]], "the opener runs the argv form");
}

// =========================================================================
// 4. the host: fake Spotify behind an injected fetch
// =========================================================================

function fakeSpotify() {
  const f = {
    calls: [],
    authorize: null, // last authorize URL params
    tokenMode: "ok",
    refreshMode: "ok",
    refreshDelayMs: 0,
    refreshCount: 0,
    issued: 0,
    validTokens: new Set(),
    reject401: 0, // answer this many API calls with 401 regardless
    routes: {},
    imageFetches: [],
  };
  const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  f.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    f.calls.push({ url: url.href, method, headers, body: init.body, redirect: init.redirect });
    if (url.href === "https://accounts.spotify.com/api/token") {
      if (headers["content-type"] !== "application/x-www-form-urlencoded") return json(400, { error: "invalid_request" });
      const form = new URLSearchParams(init.body);
      if (form.get("grant_type") === "authorization_code") {
        if (f.tokenMode === "invalid_client") return json(400, { error: "invalid_client", error_description: "Invalid client" });
        if (f.tokenMode === "redirect") return json(400, { error: "invalid_grant", error_description: "Invalid redirect URI" });
        const a = f.authorize;
        if (!a || form.get("code") !== "goodcode" || form.get("client_id") !== a.client_id || form.get("redirect_uri") !== a.redirect_uri) return json(400, { error: "invalid_grant" });
        if (codeChallenge(form.get("code_verifier")) !== a.code_challenge) return json(400, { error: "invalid_grant", error_description: "code_verifier was incorrect" });
        f.issued += 1;
        f.validTokens.add(`AT${f.issued}`);
        return json(200, { access_token: `AT${f.issued}`, token_type: "Bearer", expires_in: 3600, refresh_token: "RT-first", scope: SPOTIFY_SCOPES.join(" ") });
      }
      if (form.get("grant_type") === "refresh_token") {
        f.refreshCount += 1;
        if (f.refreshDelayMs) await sleep(f.refreshDelayMs);
        if (f.refreshMode === "invalid_grant") return json(400, { error: "invalid_grant", error_description: "Refresh token revoked" });
        if (form.get("client_id") !== CLIENT || !form.get("refresh_token")?.startsWith("RT")) return json(400, { error: "invalid_request" });
        f.issued += 1;
        f.validTokens.add(`AT${f.issued}`);
        return json(200, { access_token: `AT${f.issued}`, token_type: "Bearer", expires_in: 3600, scope: "x" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.origin === "https://api.spotify.com") {
      const token = String(headers.authorization || "").replace(/^Bearer /, "");
      if (f.reject401 > 0) { f.reject401 -= 1; return json(401, { error: { status: 401, message: "The access token expired" } }); }
      if (!f.validTokens.has(token)) return json(401, { error: { status: 401, message: "Invalid access token" } });
      const key = `${method} ${url.pathname.replace(/^\/v1/, "")}`;
      const handler = f.routes[key];
      if (!handler) return json(404, { error: { status: 404, message: "Service not found" } });
      const out = typeof handler === "function" ? handler(url, init) : handler;
      if (out instanceof Response) return out;
      if (out === 204) return new Response(null, { status: 204 });
      return json(200, out);
    }
    if (SPOTIFY_IMAGE_HOSTS.includes(url.hostname) || url.hostname === "evil.example") {
      f.imageFetches.push(url.href);
      const size = Number(url.pathname.split("/").pop()) || 300;
      return new Response(png(size, size), { status: 200, headers: { "content-type": "image/png" } });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  };
  f.json = json;
  return f;
}

function fakeProvider() {
  const calls = { fit: [] };
  return {
    id: "fake",
    displayName: "Fake",
    calls,
    features: { spotify: { local: { nowPlaying: true, transport: true, artwork: true, seek: true, shuffle: true, repeat: true } } },
    async listInstalledApps() { return []; },
    async listRunningApps() { return []; },
    async launchApp() {},
    async focusApp() {},
    async closeApp() {},
    async control() {},
    async nowPlaying() { return null; },
    async systemStats() { return {}; },
    async fitImage(bytes, px) { calls.fit.push(px); return { mime: "image/png", bytes: png(px, px) }; },
  };
}

let fileNo = 0;
async function serve({ trustLoopback = true, spotify = fakeSpotify(), tokenStore = createMemoryTokenStore() } = {}) {
  const clock = { t: Date.now() };
  const opened = [];
  const logs = [];
  const provider = fakeProvider();
  const configPath = join(dir, `config-${++fileNo}.json`);
  const app = await createApp({
    provider,
    configStore: createConfigStore({ path: configPath }),
    pin: "432100",
    trustLoopback,
    log: (line) => logs.push(line),
    spotifyTokenStore: tokenStore,
    spotifyOpenUrl: async (url) => {
      opened.push(url);
      spotify.authorize = Object.fromEntries(new URL(url).searchParams);
    },
    spotifyFetch: spotify.fetch,
    spotifyNow: () => clock.t,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  const bodies = [];
  /** Raw HTTP so Host and Sec-Fetch-* headers are exactly what the test says. */
  function raw(method, path, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const req = request({
        host: "127.0.0.1", port, method, path,
        headers: { host: `127.0.0.1:${port}`, ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          bodies.push(text);
          let json = null;
          try { json = JSON.parse(text); } catch { /* html or binary */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text, buf });
        });
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
  const get = (path, headers) => raw("GET", path, { headers });
  const post = (path, body = {}, headers) => raw("POST", path, { body, headers });
  async function stop() {
    await app.hub.close();
    await new Promise((r) => app.server.close(r));
  }
  return { app, port, raw, get, post, stop, opened, logs, clock, bodies, provider, configPath, spotify, tokenStore };
}

/** Run a full login: connect, then the browser's callback. */
async function login(h) {
  const r = await h.post("/api/host/spotify/connect");
  const state = new URL(h.opened.at(-1)).searchParams.get("state");
  const cb = await h.get(`/api/spotify/callback?code=goodcode&state=${encodeURIComponent(state)}`, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" });
  return { connect: r, cb, state };
}

const h = await serve();
const { spotify: fake } = h;
fake.routes["GET /me"] = { display_name: "Geri", id: "geri", account_id: "acc" }; // no `product` (Dev Mode, 2026)

// ---- host page routes ----
let r = await h.get("/api/host/spotify");
t.equal(r.status, 200, "GET /api/host/spotify answers locally");
t.deepEqual(r.json, { configured: false, clientId: null, connected: false, account: null, error: null, redirectUri: `http://127.0.0.1:${h.port}/api/spotify/callback` }, "unconfigured setup state with the exact redirect URI");
t.equal(r.headers["x-frame-options"], "DENY", "host security headers on /api/host/spotify");
t.deepEqual((await h.get("/api/state")).json.features.spotify.account, { available: false }, "unconfigured: account not available");
r = await h.raw("PUT", "/api/host/spotify", { body: { clientId: "XYZ" } });
t.equal(r.status, 400, "PUT with a bad client ID is a 400");
r = await h.raw("PUT", "/api/host/spotify", { body: { clientId: CLIENT.toUpperCase() } });
t.equal(r.status, 400, "upper-case hex is refused");
r = await h.raw("PUT", "/api/host/spotify", { body: `{"clientId":"${CLIENT}"}`, headers: { "content-type": "text/plain" } });
t.equal(r.status, 415, "PUT needs a JSON content type");
r = await h.raw("PUT", "/api/host/spotify", { body: { clientId: CLIENT }, headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } });
t.equal(r.status, 403, "a cross-site PUT is refused");
r = await h.post("/api/host/spotify/connect");
t.equal(r.status, 501, "connect before a client ID: not configured");
t.equal(h.opened.length, 0, "nothing opened");

// SSE: the host page follows the account through the status snapshot.
const events = [];
const sse = await fetch(`http://127.0.0.1:${h.port}/api/host/events`);
const reader = sse.body.getReader();
(async () => {
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    buf += Buffer.from(value).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
})();
const until = async (check, label, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) { t.ok(false, `timed out: ${label}`); return; }
    await sleep(5);
  }
};
await until(() => events.length >= 1, "first SSE status");
t.deepEqual(events[0].features, { spotify: { account: { available: false } } }, "the status snapshot carries features.spotify.account");

r = await h.raw("PUT", "/api/host/spotify", { body: { clientId: CLIENT } });
t.equal(r.status, 200, "PUT a valid client ID");
t.deepEqual([r.json.configured, r.json.clientId, r.json.connected], [true, CLIENT, false], "configured, not connected");
t.deepEqual(JSON.parse(await readFile(h.configPath, "utf8")).spotify, { clientId: CLIENT }, "the client ID is persisted in the host config");
await until(() => events.some((e) => e.features?.spotify?.account?.available === true), "SSE after configuring");
t.deepEqual((await h.get("/api/state")).json.features.spotify.account, { available: true, connected: false, premium: null, name: null, error: null }, "configured: available, not connected");
t.equal((await h.get("/api/tiles")).json.spotify, undefined, "GET /api/tiles never carries host settings");

// ---- login ----
r = await h.post("/api/host/spotify/connect");
t.equal(r.status, 200, "host-page connect answers");
t.equal(h.opened.length, 1, "the authorize URL is opened once");
const first = new URL(h.opened[0]);
t.equal(`${first.origin}${first.pathname}`, "https://accounts.spotify.com/authorize", "opened the Spotify authorize endpoint");
t.equal(first.searchParams.get("redirect_uri"), `http://127.0.0.1:${h.port}/api/spotify/callback`, "redirect URI uses the actual port");
t.equal(first.searchParams.get("code_challenge_method"), "S256", "S256");
t.ok(/^[A-Za-z0-9_-]{43}$/.test(first.searchParams.get("code_challenge")), "challenge is 43 base64url characters");
t.ok((first.searchParams.get("state") || "").length >= 32, "state is long and random");
t.ok(!h.opened[0].includes("verifier"), "the verifier never leaves the host");
const firstState = first.searchParams.get("state");

const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" };
r = await h.get(`/api/spotify/callback?code=goodcode&state=${firstState}`, { ...nav, host: `localhost:${h.port}` });
t.equal(r.status, 403, "callback via localhost is refused");
r = await h.get(`/api/spotify/callback?code=goodcode&state=${firstState}`, { "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors", "sec-fetch-site": "cross-site" });
t.equal(r.status, 403, "callback as an <img> is refused");
r = await h.get(`/api/spotify/callback?code=goodcode&state=${firstState}`, { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
t.equal(r.status, 403, "callback as a fetch is refused");
r = await h.get("/api/spotify/callback?code=goodcode&state=wrong", nav);
t.equal(r.status, 400, "unknown state is refused");
t.ok(r.text.includes("expired"), "unknown state page");
t.equal(fake.calls.filter((c) => c.url.includes("/api/token")).length, 0, "no token exchange for refused callbacks");
r = await h.get(`/api/spotify/callback?code=goodcode&state=${firstState}`, nav);
t.equal(r.status, 200, "the browser's callback succeeds");
t.ok(r.text.includes("Connected. You can close this tab."), "success page");
t.ok(/default-src 'none'/.test(r.headers["content-security-policy"]) && r.headers["referrer-policy"] === "no-referrer" && r.headers["x-frame-options"] === "DENY", "success page has a strict CSP");
const exchange = fake.calls.find((c) => c.url.includes("/api/token"));
t.equal(exchange.redirect, "error", "token exchange refuses redirects");
t.equal(new URLSearchParams(exchange.body).get("grant_type"), "authorization_code", "authorization_code grant");
r = await h.get(`/api/spotify/callback?code=goodcode&state=${firstState}`, nav);
t.equal(r.status, 400, "a state is single use");
t.deepEqual(h.tokenStore.peek()?.accessToken, "AT1", "tokens are in the secret store");
r = await h.get("/api/host/spotify");
t.deepEqual([r.json.connected, r.json.account, r.json.error], [true, { name: "Geri", premium: null, product: null }, null], "connected; no product field, so Premium is unknown");
await until(() => events.some((e) => e.features?.spotify?.account?.connected === true), "SSE after connecting");
t.deepEqual((await h.get("/api/state")).json.features.spotify.account, { available: true, connected: true, premium: null, name: "Geri", error: null }, "dock capability map: connected");

// state expiry
await h.post("/api/host/spotify/connect");
const lateState = new URL(h.opened.at(-1)).searchParams.get("state");
h.clock.t += 10 * 60_000 + 1;
r = await h.get(`/api/spotify/callback?code=goodcode&state=${lateState}`, nav);
t.equal(r.status, 400, "a state expires after 10 minutes");

// error codes and "a new login clears the error"
await h.post("/api/host/spotify/connect");
let st = new URL(h.opened.at(-1)).searchParams.get("state");
r = await h.get(`/api/spotify/callback?error=access_denied&state=${st}`, nav);
t.equal(r.status, 502, "access denied page");
t.equal((await h.get("/api/host/spotify")).json.error, "access_denied", "error: access_denied");
await until(() => events.at(-1)?.features?.spotify?.account?.error === "access_denied", "SSE carries the error");
r = await h.post("/api/host/spotify/connect");
t.equal(r.json.error, null, "a new host-page login clears the previous error");
t.equal((await h.get("/api/host/spotify")).json.error, null, "error stays cleared while waiting");
await until(() => events.at(-1)?.features?.spotify?.account?.error === null, "SSE after the error clears");
st = new URL(h.opened.at(-1)).searchParams.get("state");
await h.get(`/api/spotify/callback?error=access_denied&state=${st}`, nav);
t.equal((await h.get("/api/host/spotify")).json.error, "access_denied", "the same error again is visible again");
const phoneConnect = await h.post("/api/spotify/connect");
t.equal(phoneConnect.status, 200, "phone connect answers");
t.equal((await h.get("/api/host/spotify")).json.error, null, "a phone login also clears the error");
fake.tokenMode = "invalid_client";
st = new URL(h.opened.at(-1)).searchParams.get("state");
await h.get(`/api/spotify/callback?code=goodcode&state=${st}`, nav);
t.equal((await h.get("/api/host/spotify")).json.error, "invalid_client", "error: invalid_client");
fake.tokenMode = "redirect";
await h.post("/api/host/spotify/connect");
st = new URL(h.opened.at(-1)).searchParams.get("state");
await h.get(`/api/spotify/callback?code=goodcode&state=${st}`, nav);
t.equal((await h.get("/api/host/spotify")).json.error, "redirect_mismatch", "error: redirect_mismatch");
fake.tokenMode = "ok";
t.equal(h.tokenStore.peek()?.accessToken, "AT1", "failed logins keep the working sign-in");
r = await h.raw("POST", "/api/spotify/connect", { body: "{}", headers: { "content-type": "text/plain" } });
t.equal(r.status, 415, "phone connect needs JSON");
await h.post("/api/host/spotify/connect"); // clear the error before the API section
t.equal((await h.get("/api/host/spotify")).json.error, null, "clean state");

// ---- phone routes ----
fake.routes["GET /me/playlists"] = (url) => ({
  href: "x", limit: Number(url.searchParams.get("limit")), offset: Number(url.searchParams.get("offset")), total: 2, next: null, previous: null,
  items: [
    { id: PL1, name: "Chill", uri: `spotify:playlist:${PL1}`, collaborative: false, owner: { id: "geri", display_name: "Geri" }, items: { href: "x", total: 42 }, images: [{ url: "https://mosaic.scdn.co/640/abc", width: 640, height: 640 }, { url: "https://mosaic.scdn.co/300/abc", width: 300, height: 300 }] },
    { id: PL2, name: "Evil", uri: `spotify:playlist:${PL2}`, owner: { id: "x", display_name: null }, tracks: { total: 3 }, images: [{ url: "https://evil.example/300", width: 300, height: 300 }] },
    null,
  ],
});
r = await h.get("/api/spotify/playlists?limit=20");
t.equal(r.status, 200, "playlists answer");
t.deepEqual(r.json.items[0], { id: PL1, uri: `spotify:playlist:${PL1}`, name: "Chill", owner: { id: "geri", name: "Geri" }, tracks: 42, collaborative: false, image: spotifyImageKey(`spotify:playlist:${PL1}`) }, "a playlist row: name, id, uri, image key, track count (items.total), owner");
t.equal(r.json.items[1].tracks, 3, "older tracks.total still read");
t.equal(r.json.items[1].image, null, "an off-list image host gives no image");
t.deepEqual([r.json.total, r.json.offset, r.json.limit, r.json.next, r.json.items.length], [2, 0, 20, false, 2], "paging fields; null rows dropped");
const playlistCalls = () => fake.calls.filter((c) => c.url.includes("/me/playlists")).length;
const before = playlistCalls();
await h.get("/api/spotify/playlists?limit=20");
t.equal(playlistCalls(), before, "playlists are cached for 60 s per page");
await h.get("/api/spotify/playlists?limit=10");
t.equal(playlistCalls(), before + 1, "another page is fetched");
h.clock.t += 61_000;
await h.get("/api/spotify/playlists?limit=20");
t.equal(playlistCalls(), before + 2, "the cache expires after 60 s");
t.equal((await h.get("/api/spotify/playlists?limit=500")).status, 400, "limit over 50 refused");

// images
r = await h.get(`/api/spotify/image?key=${spotifyImageKey(`spotify:playlist:${PL1}`)}`);
t.equal(r.status, 200, "playlist image served");
t.equal(r.headers["content-type"], "image/png", "image mime");
t.deepEqual(fake.imageFetches, ["https://mosaic.scdn.co/300/abc"], "the 300 px variant is fetched by the host");
t.equal(fake.calls.find((c) => c.url.startsWith("https://mosaic")).redirect, "error", "image fetches refuse redirects");
await h.get(`/api/spotify/image?key=${spotifyImageKey(`spotify:playlist:${PL1}`)}`);
t.equal(fake.imageFetches.length, 1, "images are cached by key");
t.equal((await h.get(`/api/spotify/image?key=${spotifyImageKey(`spotify:playlist:${PL2}`)}`)).status, 404, "an entity without an allowed image has none");
t.ok(!fake.imageFetches.some((u) => u.includes("evil")), "off-list hosts are never fetched");
t.equal((await h.get("/api/spotify/image?key=nothex")).status, 400, "bad image key");
t.equal((await h.get(`/api/spotify/image?key=${"f".repeat(32)}`)).status, 404, "unknown image key");

// liked + like
fake.routes["GET /me/tracks"] = { href: "x", limit: 50, offset: 0, total: 1, next: "https://api.spotify.com/v1/me/tracks?offset=50", items: [
  { added_at: "2026-01-01T00:00:00Z", track: { type: "track", id: TRK, uri: `spotify:track:${TRK}`, name: "Houdini", duration_ms: 185000, explicit: false, artists: [{ id: ART, uri: `spotify:artist:${ART}`, name: "Dua Lipa" }], album: { id: ALB, name: "Radical Optimism", images: [{ url: "https://i.scdn.co/image/640", width: 640, height: 640 }] } } },
] };
r = await h.get("/api/spotify/liked");
t.deepEqual(r.json.items[0], { type: "track", id: TRK, uri: `spotify:track:${TRK}`, name: "Houdini", artists: [{ id: ART, uri: `spotify:artist:${ART}`, name: "Dua Lipa" }], album: { id: ALB, uri: `spotify:album:${ALB}`, name: "Radical Optimism" }, durationMs: 185000, explicit: false, playable: true, image: spotifyImageKey(`spotify:album:${ALB}`) }, "a liked song row");
t.deepEqual([r.json.total, r.json.next], [1, true], "liked paging");
r = await h.get(`/api/spotify/image?key=${spotifyImageKey(`spotify:album:${ALB}`)}`);
t.equal(r.status, 200, "album art served");
t.deepEqual(h.provider.calls.fit, [300], "a 640 px image is resized to 300 through the provider's artwork pipeline");
let libraryCall = null;
fake.routes["PUT /me/library"] = (url) => { libraryCall = ["PUT", url.searchParams.get("uris")]; return new Response(null, { status: 200 }); };
fake.routes["DELETE /me/library"] = (url) => { libraryCall = ["DELETE", url.searchParams.get("uris")]; return new Response(null, { status: 200 }); };
fake.routes["GET /me/library/contains"] = [true];
r = await h.post("/api/spotify/like", { trackId: TRK, liked: true });
t.deepEqual([r.status, r.json, libraryCall], [200, { trackId: TRK, liked: true }, ["PUT", `spotify:track:${TRK}`]], "like → PUT /me/library?uris=spotify:track:<id>");
await h.post("/api/spotify/like", { trackId: TRK, liked: false });
t.deepEqual(libraryCall, ["DELETE", `spotify:track:${TRK}`], "unlike → DELETE /me/library");
t.deepEqual((await h.get(`/api/spotify/like?trackId=${TRK}`)).json, { trackId: TRK, liked: true }, "check → /me/library/contains");
t.equal((await h.post("/api/spotify/like", { trackId: "bad", liked: true })).status, 400, "like validates the track ID");

// search
fake.routes["GET /search"] = (url) => ({
  tracks: { items: [], total: 0, next: null, _q: url.searchParams.get("q") },
  artists: { items: [{ id: ART, name: "Dua Lipa", images: [] }], total: 1, next: null },
  albums: { items: [{ id: ALB, name: "Radical Optimism", total_tracks: 11, release_date: "2024-05-03", artists: [], images: [] }], total: 1, next: null },
  playlists: { items: [null, { id: PL1, name: "Chill", owner: { id: "s", display_name: "S" }, items: { total: 5 }, images: [] }], total: 2, next: null },
});
r = await h.get(`/api/spotify/search?q=${encodeURIComponent("dua lipa")}&types=songs,artists,albums,playlists&limit=10`);
t.equal(r.status, 200, "search answers");
const searchCall = new URL(fake.calls.filter((c) => c.url.includes("/search")).at(-1).url);
t.deepEqual([searchCall.searchParams.get("q"), searchCall.searchParams.get("type"), searchCall.searchParams.get("limit")], ["dua lipa", "track,artist,album,playlist", "10"], "search goes to Spotify with types and limit ≤ 10");
t.deepEqual([r.json.artists.items[0].name, r.json.albums.items[0].tracks, r.json.playlists.items.length], ["Dua Lipa", 11, 1], "search sections mapped; null playlist rows dropped");
t.equal((await h.get(`/api/spotify/search?q=${"x".repeat(101)}`)).status, 400, "search q too long");
t.equal((await h.get("/api/spotify/search?q=x&types=shows")).status, 400, "search type validated");

// devices, play, queue, transfer
fake.routes["GET /me/player/devices"] = { devices: [{ id: "74ASZWbe4lXaubB36ztrGX", is_active: true, name: "Studio Mac", type: "Computer", volume_percent: 50, supports_volume: true }, { id: null, name: "Restricted", type: "Speaker", is_restricted: true }] };
r = await h.get("/api/spotify/devices");
t.deepEqual(r.json.devices[0], { id: "74ASZWbe4lXaubB36ztrGX", name: "Studio Mac", type: "Computer", active: true, restricted: false, privateSession: false, volume: 50, supportsVolume: true }, "a device row");
t.equal(r.json.devices[1].id, null, "a device without an id stays listed with id null");
let lastPlay = null;
fake.routes["PUT /me/player/play"] = (url, init) => { lastPlay = { device: url.searchParams.get("device_id"), body: init.body ? JSON.parse(init.body) : null }; return 204; };
r = await h.post("/api/spotify/play", { contextUri: `spotify:playlist:${PL1}`, deviceId: "74ASZWbe4lXaubB36ztrGX" });
t.deepEqual([r.status, lastPlay], [200, { device: "74ASZWbe4lXaubB36ztrGX", body: { context_uri: `spotify:playlist:${PL1}` } }], "play a playlist on a device");
t.equal((await h.get("/api/state")).json.features.spotify.account.premium, true, "a played command proves Premium");
await h.post("/api/spotify/play", { uri: `spotify:track:${TRK}`, contextUri: `spotify:album:${ALB}` });
t.deepEqual(lastPlay.body, { context_uri: `spotify:album:${ALB}`, offset: { uri: `spotify:track:${TRK}` } }, "play a track within its album");
await h.post("/api/spotify/play", { uri: `spotify:track:${TRK}` });
t.deepEqual(lastPlay.body, { uris: [`spotify:track:${TRK}`] }, "play one track");
await h.post("/api/spotify/play", {});
t.equal(lastPlay.body, null, "resume sends no body");
const resumeCall = fake.calls.filter((c) => c.url.includes("/me/player/play")).at(-1);
t.equal(resumeCall.body, "", "a bodiless PUT still sends an (empty) body for Content-Length");
t.equal((await h.post("/api/spotify/play", { contextUri: "spotify:playlist:bad" })).status, 400, "play validates URIs");
let queued = null;
fake.routes["POST /me/player/queue"] = (url) => { queued = url.searchParams.get("uri"); return 204; };
r = await h.post("/api/spotify/queue", { uri: `spotify:track:${TRK}` });
t.deepEqual([r.status, queued], [200, `spotify:track:${TRK}`], "queue → POST /me/player/queue?uri=");
let transferred = null;
fake.routes["PUT /me/player"] = (url, init) => { transferred = JSON.parse(init.body); return 204; };
r = await h.post("/api/spotify/transfer", { deviceId: "74ASZWbe4lXaubB36ztrGX", play: true });
t.deepEqual([r.status, transferred], [200, { device_ids: ["74ASZWbe4lXaubB36ztrGX"], play: true }], "transfer → PUT /me/player { device_ids: [one] }");
t.equal((await h.post("/api/spotify/transfer", { deviceId: "../x" })).status, 400, "transfer validates the device ID");
fake.routes["GET /me/player/queue"] = { currently_playing: { type: "track", id: TRK, name: "Houdini", artists: [], album: null }, queue: [{ type: "episode", id: ID("e"), name: "Ep", show: { name: "Show" }, images: [] }] };
r = await h.get("/api/spotify/queue");
t.deepEqual([r.json.currentlyPlaying.name, r.json.queue[0].type, r.json.queue[0].show], ["Houdini", "episode", "Show"], "Up next from GET /me/player/queue");
fake.routes["GET /me/player"] = { device: { id: "74ASZWbe4lXaubB36ztrGX", name: "Studio Mac", type: "Computer", is_active: true }, is_playing: true, progress_ms: 1000, shuffle_state: false, repeat_state: "context", item: { type: "track", id: TRK, name: "Houdini", artists: [], album: null }, context: { type: "playlist", uri: `spotify:playlist:${PL1}` } };
r = await h.get("/api/spotify/status");
t.deepEqual([r.json.configured, r.json.connected, r.json.premium, r.json.name, r.json.playback?.device?.name, r.json.playback?.repeat], [true, true, true, "Geri", "Studio Mac", "context"], "status: account plus playback");
t.equal(r.json.available, undefined, "status has no `available` (it is `configured`)");

// error mapping
fake.routes["PUT /me/player/play"] = () => fake.json(403, { error: { status: 403, message: "Player command failed: Premium required", reason: "PREMIUM_REQUIRED" } });
r = await h.post("/api/spotify/play", {});
t.deepEqual([r.status, r.json], [403, { error: "premium required" }], "403 PREMIUM_REQUIRED → 403 premium required");
t.equal((await h.get("/api/state")).json.features.spotify.account.premium, false, "Premium learned as false");
fake.routes["PUT /me/player/play"] = () => fake.json(404, { error: { status: 404, message: "Player command failed: No active device found", reason: "NO_ACTIVE_DEVICE" } });
r = await h.post("/api/spotify/play", {});
t.deepEqual([r.status, r.json], [409, { error: "no active device" }], "404 NO_ACTIVE_DEVICE → 409 no active device");
fake.routes["GET /me/player/devices"] = () => fake.json(403, { error: { status: 403, message: "Check settings on developer.spotify.com/dashboard, the user may not be registered." } });
r = await h.get("/api/spotify/devices");
t.deepEqual([r.status, r.json], [403, { error: "spotify user not allowed" }], "a user missing from User Management gets a clear error");
const rateCalls = () => fake.calls.filter((c) => c.url.includes("/me/player/devices")).length;
fake.routes["GET /me/player/devices"] = () => fake.json(429, { error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } }, { "retry-after": "7" });
r = await h.get("/api/spotify/devices");
t.deepEqual([r.status, r.json.error, r.headers["retry-after"]], [429, "rate limited", "7"], "429 → 429 with Retry-After");
const afterLimit = rateCalls();
fake.routes["GET /me/player/devices"] = { devices: [] };
r = await h.get("/api/spotify/devices");
t.equal(r.status, 429, "inside the backoff the host answers 429 itself");
t.equal(rateCalls(), afterLimit, "and does not call Spotify");
h.clock.t += 7_001;
r = await h.get("/api/spotify/devices");
t.equal(r.status, 200, "after Retry-After calls go through again");

// 401: refresh once, then retry
const refreshBefore = fake.refreshCount;
fake.reject401 = 1;
r = await h.get("/api/spotify/devices");
t.equal(r.status, 200, "a 401 is retried after one refresh");
t.equal(fake.refreshCount, refreshBefore + 1, "exactly one refresh");
t.equal(h.tokenStore.peek().refreshToken, "RT-first", "a refresh without a new refresh_token keeps the old one");
t.ok(/^AT\d+$/.test(h.tokenStore.peek().accessToken) && h.tokenStore.peek().accessToken !== "AT1", "the refreshed access token is stored");

// refresh ahead of expiry, single-flight
h.clock.t += 3600_000 - 60_000; // inside the refresh-ahead window
fake.refreshDelayMs = 40;
const refreshMid = fake.refreshCount;
const parallel = await Promise.all([h.get("/api/spotify/devices"), h.get("/api/spotify/queue"), h.get(`/api/spotify/like?trackId=${TRK}`)]);
t.deepEqual(parallel.map((p) => p.status), [200, 200, 200], "concurrent calls near expiry all succeed");
t.equal(fake.refreshCount, refreshMid + 1, "and share one refresh (single-flight)");
fake.refreshDelayMs = 0;

// 401 twice → disconnected
fake.reject401 = 2;
r = await h.get("/api/spotify/devices");
t.deepEqual([r.status, r.json], [409, { error: "spotify disconnected" }], "401 after a refresh → spotify disconnected");
t.equal(h.tokenStore.peek(), null, "tokens removed from the secret store");
t.deepEqual((await h.get("/api/state")).json.features.spotify.account, { available: true, connected: false, premium: null, name: null, error: "disconnected" }, "capability map: disconnected");
t.equal((await h.get("/api/host/spotify")).json.error, "disconnected", "host page error: disconnected");
t.equal((await h.get("/api/spotify/devices")).status, 409, "routes answer not connected");

// invalid_grant on refresh → disconnected
await login(h);
t.equal((await h.get("/api/host/spotify")).json.connected, true, "logged in again");
fake.refreshMode = "invalid_grant";
h.clock.t += 3600_000;
r = await h.get("/api/spotify/devices");
t.deepEqual([r.status, r.json], [409, { error: "spotify disconnected" }], "invalid_grant on refresh → spotify disconnected");
t.equal((await h.get("/api/host/spotify")).json.error, "disconnected", "error: disconnected");
fake.refreshMode = "ok";

// tiles
await login(h);
r = await h.raw("PUT", "/api/tiles", { body: { tiles: [{ kind: "spotify", uri: `spotify:playlist:${PL1}`, label: "Chill", image: "" }, { kind: "spotify", uri: "spotify:track:bad", label: "x" }] } });
t.deepEqual(r.json, { version: 1, tiles: [{ kind: "spotify", uri: `spotify:playlist:${PL1}`, label: "Chill", image: "" }] }, "PUT /api/tiles keeps valid Spotify tiles only, no host settings echoed");
t.deepEqual(JSON.parse(await readFile(h.configPath, "utf8")).spotify, { clientId: CLIENT }, "saving tiles keeps the client ID");
const stateTile = (await h.get("/api/state")).json.tiles[0];
t.deepEqual(stateTile, { kind: "spotify", uri: `spotify:playlist:${PL1}`, label: "Chill", image: spotifyImageKey(`spotify:playlist:${PL1}`), available: true }, "a Spotify tile in the snapshot: host image key, available while connected");
fake.routes["GET /playlists/37i9dQZF1DXcBWIGoYBM5M/images"] = [{ url: "https://image-cdn-ak.spotifycdn.com/image/300", width: 300, height: 300 }];
h.clock.t += 7 * 3600_000; // cached URLs are stale now
const tileImage = await h.get(`/api/spotify/image?key=${stateTile.image}`);
t.equal(tileImage.status, 200, "a tile image resolves through its URI (GET /playlists/{id}/images)");
t.equal(fake.imageFetches.at(-1), "https://image-cdn-ak.spotifycdn.com/image/300", "the re-resolved URL is the one fetched");

// disconnect from the host page keeps the client ID
r = await h.raw("DELETE", "/api/host/spotify");
t.equal(r.status, 415, "host DELETE follows the /api/host JSON rule");
r = await h.raw("DELETE", "/api/host/spotify", { headers: { "content-type": "application/json" } });
t.deepEqual([r.status, r.json.connected, r.json.clientId, r.json.error], [200, false, CLIENT, null], "DELETE /api/host/spotify disconnects, keeps the client ID");
t.equal(h.tokenStore.peek(), null, "tokens deleted");
t.equal((await h.get("/api/state")).json.tiles[0].available, false, "Spotify tiles are unavailable while disconnected");
await login(h);
r = await h.raw("DELETE", "/api/spotify/account");
t.deepEqual([r.status, r.json], [200, { ok: true, connected: false }], "phone DELETE /api/spotify/account disconnects");
await login(h);
await h.raw("PUT", "/api/host/spotify", { body: { clientId: "f".repeat(32) } });
t.deepEqual([(await h.get("/api/host/spotify")).json.connected, h.tokenStore.peek()], [false, null], "a new client ID drops the old client's tokens");

// nothing secret reached a response or a log line
const allText = h.bodies.join("\n") + h.logs.join("\n");
t.ok(!/AT\d+|RT-first|goodcode/.test(allText), "no token or code in any response body or log line");
t.ok(!h.logs.some((l) => l.includes(firstState)), "no state in the log");

reader.cancel().catch(() => {});
await h.stop();

// ---- local-only and session rules ----
const lan = await serve({ trustLoopback: false });
r = await lan.get("/api/host/spotify");
t.equal(r.status, 403, "host Spotify routes are local only");
r = await lan.get("/api/spotify/status");
t.equal(r.status, 401, "phone Spotify routes need a paired session");
r = await lan.post("/api/spotify/connect");
t.equal(r.status, 401, "phone connect needs a paired session");
r = await lan.get("/api/spotify/callback?code=x&state=y", nav);
t.equal(r.status, 400, "the callback itself needs no session (loopback + state are the guard)");
r = await lan.get("/api/spotify/status".replace("status", "nope"));
t.equal(r.status, 401, "unknown Spotify routes are behind the session too");
await lan.stop();

const off = await serve();
r = await off.get("/api/spotify/status");
t.deepEqual(r.json, { configured: false, connected: false, premium: null, name: null, error: null, playback: null }, "status while unconfigured");
t.equal((await off.get("/api/spotify/playlists")).status, 501, "routes answer not configured");
t.equal((await off.get("/api/spotify/nope")).status, 404, "unknown Spotify route");
t.equal(off.tokenStore.writes, 0, "an unconfigured host never writes the secret store");
await off.stop();

await rm(dir, { recursive: true, force: true });
t.done("spotify verification passed");
