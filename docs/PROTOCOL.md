# Phone ↔ host protocol

The contract between a phone (the shared web UI, or the Android/iOS shells that
load it) and the WinDock host, as of `api: 1`. Implementation notes live in
[DEVELOPMENT.md](DEVELOPMENT.md#pairing-and-network-access).

## Transport

| Item | Value |
| --- | --- |
| Port | One TCP port (default `8620`, `PORT` overrides) serves **both** plain HTTP and HTTPS. The host routes each connection by its first byte: `0x16` (TLS handshake) goes to HTTPS, anything else to HTTP. |
| Certificate | Self-signed ECDSA P-256, X.509 v3, valid 20 years, kept in the host's data directory and reused across restarts. No certificate authority. |
| Trust | Phones pin the certificate's SHA-256 fingerprint the first time they pair (trust on first use) and compare it with the certificate the TLS handshake actually presents, never with `/health`. |
| Security code | First 6 bytes of the fingerprint as hex, `XXXX-XXXX-XXXX`. Shown by the host (`npm run info`, the startup banner, the Windows tray) so a person can compare it with the phone. |
| Switches | `WINDOCK_TLS=0` disables HTTPS. `WINDOCK_PLAIN_HTTP=0` disables plain HTTP (only valid with TLS on); the advertised endpoint is then the https one. |

## Discovery (UDP, v1)

| Item | Value |
| --- | --- |
| Port | UDP `41234` |
| Probe | `windock:discover:v1` (UTF-8, at most 64 bytes; anything else is ignored) |
| Reply | `windock:here:v1:<endpoint>`, sent back to the probe's source |
| Endpoint | The **http** URL (`http://<lan-ip>:<port>`) unless plain HTTP is off. Phones that predate TLS parse it. |

## Discovery (Bonjour / mDNS DNS-SD)

iPhones cannot send the UDP probe above without a special Apple entitlement,
so the host also advertises itself over Bonjour. Both run side by side: UDP v1
is unchanged and Android keeps using it.

| Item | Value |
| --- | --- |
| Service type | `_windock._tcp` in `local.`, on the host's TCP port (the same port as `/health`) |
| Instance name | The computer's host name without `.local`, control characters removed, at most 63 UTF-8 bytes |
| macOS | Registered with the system's mDNSResponder by a long-running `/usr/bin/dns-sd -R`, which handles name conflicts |
| Windows, Linux | A built-in responder on UDP 5353 (group `224.0.0.251`). The SRV target is `windock-<first 8 hex of hostId>.local`, with its own A record, so it never clashes with the OS's own name. Announces twice at start and sends a goodbye (TTL 0) on shutdown |
| Switch | `WINDOCK_BONJOUR=0` turns advertising off |

TXT record (each entry `key=value`, ASCII keys, at most 255 bytes):

| Key | Value |
| --- | --- |
| `id` | `hostId` (as in `/health`) |
| `api` | `1` |
| `tls` | `1` when HTTPS is served, else `0` |
| `addr` | The LAN IPv4 address the host advertises (the one in the startup banner); left out when unknown |
| `name` | The computer name, at most 60 characters |
| `os` | `macos`, `windows` or `linux` |

The TXT record is a **hint only**: anyone on the LAN can advertise any record.
A phone resolves the service, then always calls `GET /health` and checks the
TLS certificate against its pinned fingerprint before trusting the host.

Discovery never carries the PIN or anything secret.

## `GET /health`

Public, no auth, at most 4096 bytes (the phone probes' limit). Never includes the
PIN, tokens or paths.

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | `true` | Host is up |
| `app` | `"windock"` | Identifies a WinDock host |
| `platform` | string | Provider id (`windows`, `macos`, `linux`) |
| `hostId` | string \| null | Stable random UUID of this host |
| `hostName` | string | Computer name (≤ 255 chars) |
| `api` | `1` | API version (see Versioning) |
| `tls` | `{ fingerprint, code }` \| null | Hint only (unauthenticated over plain HTTP) |
| `pairingOpen` | boolean | Whether `POST /api/auth` would currently accept a PIN |
| `hostUi` | `true` \| missing | The host serves the control page (`/host`), so phones can say "choose Pair a new phone in WinDock on the computer". Missing on older hosts: keep the `npm run info` wording |

## Pairing

`POST /api/auth` with JSON `{ "pin": "123456", "deviceName": "iPhone" }`.

- **PIN:** exactly 6 ASCII digits, uniformly random.
- **Window:** pairing is open for 10 minutes after the host starts and for 10
  minutes after every local `GET /api/pairing` (`npm run info`, macOS installer,
  Windows tray *Show connection info*) or `POST /api/host/pairing/open` (the
  control page). Each reopen grants a full 10 minutes. A host with no LAN
  address keeps pairing closed and reopens it when an address appears.
- **Stop pairing** (`POST /api/host/pairing/close`) closes the window and
  rotates the PIN, so a photographed code no longer works. Running out of time
  keeps the PIN: a phone holding a scanned code can finish once pairing
  reopens.
- **Single use:** a new PIN is generated after every successful pairing.
- **Budget:** wrong PINs from all clients share a budget of 10 per window. The
  tenth rotates the PIN and closes the window until the next local reopen,
  which also resets the count.
- **Per-client lockout:** 5 failed attempts (wrong or malformed) from one
  address lock it out for 60 seconds.
- **`deviceName`** (optional): control/format characters removed, trimmed, at
  most 60 characters; missing or empty → `"Phone"`. The web UI sends
  `"Android phone"`, `"iPhone"`, `"iPad"` or `"Browser"` from the user agent.
- A request with an `Origin` header must be same-origin (scheme included).

Checks run in this order:

| Status | Body | When |
| --- | --- | --- |
| 403 | `{ "error": "bad origin" }` | Cross-origin request |
| 429 | `{ "error": "locked", "retryInMs": n }` | This client is locked out |
| 400 | `{ "error": "invalid JSON body" }` / 413 `body too large` | Body not a JSON object / over 64 KiB |
| 403 | `{ "error": "pairing closed" }` | Window closed. PIN not checked, no failure counted |
| 400 | `{ "error": "invalid pin" }` | Not 6 digits (per-client failure) |
| 401 | `{ "error": "wrong pin", "locked": bool }` | Wrong PIN (per-client and global failure) |
| 200 | `{ "ok": true }` + `Set-Cookie` | Paired; the PIN is now spent |

Native clients (the iOS and Android shells) pair with the same request and no
`Origin` header. The session is only in the `Set-Cookie` response header,
`windock_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000`
(plus `; Secure` over HTTPS): the shell reads the first `name=value` pair and
stores it in its WebView's cookie store for that origin before loading the
dock. The body never carries the token.

## Session

| Item | Value |
| --- | --- |
| Cookie | `windock_session=<opaque token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000` (180 days), plus `Secure` when issued over HTTPS |
| Scope | One session store for both schemes: a cookie from http works over https and vice versa |
| Storage | The host keeps only the token's SHA-256 hash, plus a public device `id`, `name`, `issuedAt`, `lastSeenAt` |
| Failure | Any `/api/*` route answers 401 `{ "error": "unauthorized" }` without a valid session (the phone shows the PIN screen again); 429 `locked` while the client is locked out |

### `DELETE /api/session` (forget this computer)

A phone removes itself from the computer's device list. Authenticated only by
the session cookie: loopback trust does not apply, because there is no session
to forget without one. Same-origin rule as other state-changing requests
(native clients send no `Origin`).

| Status | Body | When |
| --- | --- | --- |
| 403 | `{ "error": "bad origin" }` | Cross-origin request |
| 429 | `{ "error": "locked", "retryInMs": n }` | This client is locked out |
| 400 | `{ "error": "no session" }` | No `windock_session` cookie (also from loopback) |
| 401 | `{ "error": "unauthorized" }` + clearing `Set-Cookie` | Cookie unknown, expired or already revoked |
| 200 | `{ "ok": true }` + clearing `Set-Cookie` | That session (only) is revoked |

Revoking works exactly like `DELETE /api/devices/<id>`: the cookie then gets
401 and the session's open WebSockets close with `1008` `session revoked`.
Other sessions are untouched. The clearing cookie is
`windock_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` (plus `Secure`
over HTTPS).

State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) and WebSocket
upgrades must be same-origin when they carry an `Origin` header; native clients
send none.

## Local-only routes

Answered only for software on the host itself: a loopback socket address **and**
a `Host` header naming `localhost`, a `127.0.0.0/8` address or `[::1]`. A phone
session gets 403 `{ "error": "local only" }`; a request with neither gets 401.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/pairing` | `{ endpoint, pin, hostName, hostId, secureEndpoint, securityCode, pairingOpenForMs }`; reopens the pairing window (CLI and older trays) |
| GET | `/api/devices` | `{ devices: [{ id, name, label, issuedAt, lastSeenAt, connected }] }`, newest first. `id` is 16 hex characters, never derived from the token. `label` is the host-side name (string or null); `connected` is true while the session has an open dock (`/`) WebSocket. Times are ms since epoch |
| PATCH | `/api/devices/<id>` | Body `{ "label": string \| null }` with `Content-Type: application/json`. The label is cleaned like `deviceName` (control/format characters removed, trimmed) and cut to 40 characters; null or empty clears it. `{ ok: true, id, label }`; 404 `unknown device`; 400 `label must be a string or null`; 415 without a JSON content type. The phone never sees the label |
| DELETE | `/api/devices/<id>` | `{ ok: true, id }`, or 404 `{ "error": "unknown device" }` |
| DELETE | `/api/devices` | `{ ok: true, revoked: n }` |

Revoking a device makes its cookie get 401 and closes its open WebSockets
(sync and input) at once with close code `1008`, reason `session revoked`.

### Cross-site guard

A web page open in a browser on the computer can make that browser send
requests to `127.0.0.1` (an `<img>`, a form, a `fetch`), and those requests
pass the loopback check. So every local-only route (`/api/pairing`,
`/api/devices*`, `/host*`, `/api/host/*`) answers 403
`{ "error": "cross-site request" }` when:

- `Sec-Fetch-Site` is `cross-site` or `same-site`, or
- an `Origin` header is present and is not the request's own origin (scheme,
  host and port; `Origin: null` never matches).

Requests without these headers (the CLI, the trays, native shells) are
unaffected. Without the guard, an `<img src="http://127.0.0.1:8620/api/pairing">`
on any web page reopened pairing and reset the wrong-PIN budget on every load.

## Host control page (local only)

The computer's own interface: one page shown in a browser, the macOS menu-bar
popover or the Windows tray flyout. Same local-only rule and cross-site guard
as above; a LAN client gets 404 for `/host` (it is not advertised) and 403
`{ "error": "local only" }` for `/api/host/*`. Mutating `/api/host/*` calls
need `Content-Type: application/json` (415 otherwise), which forces a CORS
preflight from any other origin.

Every `/host` and `/api/host/*` response carries
`Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
`X-Frame-Options: DENY`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`
and `X-Content-Type-Options: nosniff`.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/host`, `/host/*` | The page (`host-ui/` in the repository; never under `public/`, which phones load) |
| GET | `/api/host/status` | Status snapshot (below). Never carries the PIN; never reopens pairing |
| GET | `/api/host/events` | Server-sent events: `event: status` with a full snapshot on every change (pairing opened, closed, timed out or rotated; a device paired, renamed, removed, connected or disconnected; address, discovery or capture changes) and a `: heartbeat` comment every 15 s. Ends when the host stops. Clients fall back to polling `/api/host/status` |
| GET | `/api/host/pairing` | Open: `{ open: true, pin, securityCode, address, endpoint, secureEndpoint, hostName, remainingMs, generation, qr }` with `qr` = `{ text, size, version, path }` (null when TLS is off). Closed: `{ open: false, closedReason, generation }`, no PIN. Never reopens |
| POST | `/api/host/pairing/open` | Opens pairing for a full 10 minutes (resets the budget; keeps the PIN); returns the body above. With no LAN address it stays closed (`closedReason: "no-address"`) |
| POST | `/api/host/pairing/close` | Stop pairing: closes now and rotates the PIN; returns the closed body (`closedReason: "stopped"`) |
| GET | `/api/host/spotify` | Spotify setup: `{ configured, clientId, redirectUri, connected, account: { name, premium, product } \| null, error }` (below). Never a token |
| PUT | `/api/host/spotify` | `{ clientId }` (32 lowercase hex, else 400). Saved in the host config; a different ID drops the old sign-in. Returns the setup body |
| POST | `/api/host/spotify/connect` | `{}`. Starts a login: clears `error`, opens Spotify's authorize page in this computer's default browser. `{ ok: true, …setup }`; 501 `spotify not configured`, 502 `could not open the browser` |
| DELETE | `/api/host/spotify` | Disconnect: deletes the tokens from the secret store, keeps the client ID. Returns the setup body |

`closedReason` is `"timeout"`, `"budget"` (10 wrong PINs), `"stopped"`,
`"no-address"`, or null while open. `generation` grows on every change a QR
code depends on: opened, PIN rotated (after a pairing or by the budget),
stopped, timed out, LAN address changed. A page refetches `/api/host/pairing`
when `status.pairing.generation` changes and `/api/devices` when
`status.devices.generation` changes.

Status snapshot:

```json
{
  "app": "windock", "version": "0.2.2",
  "hostId": "5b0e8f3a-2c41-4d7e-9a16-73c2be4d91f0", "hostName": "Geris-MacBook-Air",
  "platform": "macos", "platformName": "macOS",
  "shell": null,
  "network": { "address": "192.168.1.34", "port": 8620,
    "endpoint": "http://192.168.1.34:8620", "secureEndpoint": "https://192.168.1.34:8620",
    "others": [{ "address": "10.0.0.12", "interface": "en5", "kind": "ethernet" }] },
  "tls": { "code": "6E21-B4F0-93AD" },
  "plainHttp": true,
  "discovery": { "bonjour": "on", "udp": "on" },
  "firewall": "unknown",
  "pairing": { "open": true, "remainingMs": 540000, "closedReason": null, "generation": 7 },
  "devices": { "count": 3, "generation": 12 },
  "capture": null,
  "features": { "spotify": { "account": { "available": true, "connected": true, "premium": true, "name": "Geri", "error": null } } }
}
```

- `shell`: `WINDOCK_SHELL` from the shell that spawned the host
  (`macos-menubar`, `windows-tray`), null from a terminal or the LaunchAgent.
- `discovery.*`: `"on"`, `"off"` (`WINDOCK_BONJOUR=0`) or `"failed"`. `tls` is
  null with TLS off. `firewall` is `"ok"`, `"blocked"` or `"unknown"` (the host
  reports `"unknown"`; the macOS shell checks the firewall itself). `capture` is
  null on hosts without screen capture, else `{ phase }`.
- `hostName` drops macOS's `.local` suffix.
- `features` carries only `spotify.account` (same shape as in the dock
  snapshot). A change of the Spotify account (configured, connected, Premium,
  name, `error`) emits an SSE `status` event.

### Spotify setup (`/api/host/spotify`)

- `redirectUri` is `http://127.0.0.1:<actual port>/api/spotify/callback`. Spotify
  accepts only the loopback IP literal (never `localhost`), and the URI must match
  the app's registered one exactly, so the page shows it for copying.
- `account.product` is Spotify's `product` from `GET /me`. Spotify removed that
  field for Development Mode apps in February 2026, so it is usually null; then
  `premium` is null until a playback command answers (success → true,
  `PREMIUM_REQUIRED` → false).
- `error`: null, or `invalid_client` (Spotify refused the client ID),
  `redirect_mismatch` (the redirect URI is not registered as sent),
  `access_denied` (the user declined), `disconnected` (the sign-in was revoked
  or expired: refresh `invalid_grant`, or a second 401), `exchange_failed`,
  `unavailable` (any other failure). A new login clears it.

### QR pairing payload

The page shows a QR code (byte mode, error correction M, version 8 for typical
names, never above 9) encoding:

```
windock://pair?v=1&id=<hostId>&addr=<ipv4>:<port>&fp=<fingerprint>&pin=<pin>&name=<name>
```

| Field | Encoding |
| --- | --- |
| `v` | `1`. A phone refuses `v > 1` ("needs a newer WinDock app") |
| `id` | The host ID UUID as 16 raw bytes, base64url without padding (22 characters); must equal `/health.hostId` |
| `addr` | The advertised LAN IPv4 address and port (the same address as Bonjour TXT `addr`) |
| `fp` | SHA-256 of the leaf certificate DER, 32 bytes, base64url without padding (43 characters). The phone pins it and sends the PIN only over a TLS connection presenting it |
| `pin` | The current 6-digit PIN |
| `name` | The computer name, control characters removed, percent-encoded (RFC 3986 unreserved characters kept), cut on a character boundary to at most 32 encoded bytes. Display only |

Fields are written in this order; parsers accept any order, ignore unknown
keys and reject duplicate known keys. QR pairing needs TLS: with
`WINDOCK_TLS=0` there is no QR. The link carries the PIN, so neither side logs
it. Example (148 bytes, version 8):
`windock://pair?v=1&id=Ww6POixBTX6aFnPCvk2R8A&addr=192.168.1.34:8620&fp=biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9qE&pin=482913&name=Geris-MacBook-Air`.

## Dock endpoints (session required)

| Method | Path | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/state` | — | Snapshot (below) | |
| GET | `/api/apps/installed` | — | `{ apps: [{ id, name, target, … }] }` | |
| GET | `/api/apps/icon` | `?id=<app id>` | PNG, or an SVG placeholder | 404 `unknown app` |
| GET | `/api/tiles` | — | `{ tiles: [...] }` | |
| PUT | `/api/tiles` | `{ tiles: [...] }` | Saved (sanitised) tiles; broadcasts a snapshot | 400 / 413 |
| POST | `/api/apps/launch` | `{ id }` | `{ ok: true, id }` | 404 `unknown app` (after one rescan), 502 `launch failed` (native detail stays on the host) |
| POST | `/api/apps/focus`, `/api/apps/close` | `{ pid }` | `{ ok: true, pid }` | 400 bad pid, 404 `process not running` |
| POST | `/api/apps/close` | `{ id }` | `{ ok: true, id, requested, closed, stillOpen: [{ pid, title }] }` after up to 5 s; broadcasts a snapshot | 400 bad id, 403 `not closable`, 404 `not running`, 501 `close unavailable` |
| POST | `/api/control` | `{ verb, value? }` | `{ ok: true, verb }`; sleep/restart/shutdown reply `{ ok: true, verb, expectDisconnect: true }` first and run 500 ms later | 400 unknown verb / bad value, 403 `power actions disabled` (sleep, restart, shutdown only), 409 `permission needed` (below), 501 `controls unavailable` / `control unavailable`, 503 with an actionable message |
| GET | `/api/nowplaying` | — | `{ nowPlaying: {...} \| null }` (null when the host lacks the feature; derived from `/api/media` when the host has media) | |
| GET | `/api/media` | — | Media state (below) | 501 `media unavailable`, 503 |
| POST | `/api/media` | `{ action, value?, sessionId? }` | The new media state | 400 bad action/value, 404 `no media session` / `player not installed`, 409 `permission needed`, 501 `action unavailable` |
| GET | `/api/media/artwork` | `?key=<32 hex>` | JPEG or PNG, at most 512 px, `cache-control: private, max-age=86400, immutable` | 400 `invalid key`, 404 `no artwork`, 501 `artwork unavailable` |
| GET | `/api/volume` | — | `{ level: 0..100 \| null, muted: bool \| null }` | 501 `volume unavailable` |
| POST | `/api/volume` | `{ level?, muted? }` (at least one) | The new `{ level, muted }` | 400, 501 `volume unavailable` / `mute unavailable` |
| POST | `/api/permissions/request` | `{ scope: "spotify" \| "music" \| "system-events" }`, JSON | `{ scope, status: "granted" \| "needed" \| "denied" }` when answered or after 60 s (`needed`); broadcasts when the capability map changed | 400 `unknown scope`, 409 `not running` (a player is never launched to ask), 415, 501 `permissions unavailable` |
| POST | `/api/permissions/open-settings` | `{ scope }`, JSON | `{ ok: true, scope }`; opens System Settings › Privacy & Security › Automation on the Mac | 400, 415, 501 |
| GET | `/api/spotify/status` | — | `{ configured, connected, premium, name, error, playback }` (below) | |
| POST | `/api/spotify/connect` | `{}`, JSON | `{ ok: true }`; opens the login in the computer's browser (same as the host page) | 415, 501, 502 |
| DELETE | `/api/spotify/account` | — | `{ ok: true, connected: false }` | 501 |
| GET | `/api/spotify/playlists` | `?offset=0..100000&limit=1..50` (default 0, 50) | Page of playlists (below), cached 60 s per page | 400 |
| GET | `/api/spotify/liked` | same | Page of Liked Songs (tracks), cached 60 s per page | 400 |
| GET | `/api/spotify/search` | `?q=` (1..100 chars) `&types=track,artist,album,playlist` (or `songs,artists,albums,playlists`; default all) `&limit=1..10&offset=0..1000` | `{ q, tracks?, artists?, albums?, playlists? }`, each a page | 400 |
| GET | `/api/spotify/devices` | — | `{ devices: [{ id \| null, name, type, active, restricted, privateSession, volume, supportsVolume }] }` | |
| POST | `/api/spotify/play` | `{ uri?, contextUri?, deviceId? }` | `{ ok: true }` | 400, 403 `premium required`, 409 `no active device` |
| POST | `/api/spotify/queue` | `{ uri, deviceId? }` (track or episode) | `{ ok: true }` | 400, 403, 409 |
| GET | `/api/spotify/queue` | — | `{ currentlyPlaying, queue: [...] }` (Up next, at most 20) | |
| POST | `/api/spotify/transfer` | `{ deviceId, play? }` | `{ ok: true }` | 400, 403, 409 |
| POST | `/api/spotify/like` | `{ trackId, liked }` | `{ trackId, liked }` | 400 |
| GET | `/api/spotify/like` | `?trackId=` | `{ trackId, liked }` | 400 |
| GET | `/api/spotify/image` | `?key=<32 hex>` | PNG/JPEG, at most 300 px where the host can resize (else Spotify's ≤ 640 px original), `cache-control: private, max-age=3600` | 400 `invalid key`, 404 `no image` |
| GET | `/api/stats` | — | CPU, memory, battery (fields may be missing) | |
| GET | `/api/capture` | — | `{ available, phase, … }` | |
| POST | `/api/capture/screenshot`, `/start`, `/stop` | `{}` | Capture status | 400 options given, 501 not on this host, 503 |
| GET | `/api/input` | — | `{ available, keyboard, signatureInsert }` | |
| POST | `/api/signature`, `/api/signature/insert` | Signature strokes | Saved result | 400, 501, 503 |

Unknown `/api/*` routes are 404 `{ "error": "not found" }`; unexpected failures
are 500 `{ "error": "internal error" }` with no detail.

### Dock controls (DOCK-CONTROLS.md section 8)

**Close by app.** `{ id }` politely closes every running instance with that
app id (Windows: the helper's `close <pid>` per process; macOS: `terminate` per
app), then polls up to 5 s. A 404 means it was already gone, which the dock
treats as success. `closable: false` entries (File Explorer / the Windows shell,
Finder, WinDock's own processes, shell hosts) are refused with 403.

**Media state** (`GET /api/media`, and the reply to `POST /api/media`):

```jsonc
{
  "source": { "id": "spotify", "name": "Spotify", "appId": "com.spotify.client", "sessionId": null } | null,
  "title": "Houdini", "artist": "Dua Lipa", "album": "Radical Optimism",
  "playing": true, "positionMs": 72000, "durationMs": 185000, "updatedAt": 1761043200000,
  "artwork": "/api/media/artwork?key=9f2c…" | null,
  "controls": { "previous": true, "next": true, "playPause": true, "seek": true, "shuffle": true, "repeat": true },
  "shuffle": true, "repeat": "off" | "all" | "one" | null,
  "repeatModes": ["off", "all"],          // additive: the repeat values this source accepts (Spotify has no "one")
  "sessions": [],                         // Windows session list (empty until the helper reports sessions)
  "permission": { "player": "spotify", "status": "needed" } | null
}
```

`source: null` means nothing plays; `permission` is set only then, when a
running player has not been allowed yet. The phone interpolates `positionMs`
from `updatedAt`. Actions: `play | pause | toggle | next | previous | seek`
(integer ms) `| shuffle` (bool) `| repeat` (`off`/`all`/`one`) `| select`
(sessionId; 501 until the host lists sessions) `| open` (a player id from
`features.media.players`; the host launches the installed app). A `409` body is
`{ "error": "permission needed", "player": "spotify", "status": "needed" | "denied" }`.
Reads are shared for 750 ms, so several polling phones cost one read.

**Artwork** never comes from the internet on the phone: the host mints a key
per track, fetches Spotify's `https://i.scdn.co/…` image itself (that host
only, no redirects, 2 MB cap) or extracts Music's artwork, resizes anything
over 512 px (macOS `sips`), and caches by key.

### Spotify account (DOCK-CONTROLS.md sections 8.8 and 12)

The host holds the Spotify sign-in and proxies a small part of the Web API;
the phone never sees a token and never talks to Spotify.

**Login (PKCE, on the computer).** `POST /api/spotify/connect` (or the host
page's connect) makes a 64-character `code_verifier`, its S256
`code_challenge` (`base64url(sha256(verifier))`) and a random `state` (single
use, 10 minutes, at most 8 waiting), and opens
`https://accounts.spotify.com/authorize?client_id=…&response_type=code&redirect_uri=http://127.0.0.1:<port>/api/spotify/callback&code_challenge_method=S256&code_challenge=…&state=…&scope=…`
in the default browser (macOS `/usr/bin/open <url>`, Windows
`rundll32 url.dll,FileProtocolHandler <url>`, Linux `xdg-open`; argv only, and
only a URL the host built). Scopes: `user-read-playback-state
user-modify-playback-state user-read-currently-playing user-library-read
user-library-modify playlist-read-private playlist-read-collaborative
user-read-private`.

**`GET /api/spotify/callback`** needs no session: it is the user's own browser
coming back from Spotify. It answers only a loopback client whose `Host` is
exactly `127.0.0.1:<port>`, only to a top-level document navigation (when the
browser sends `Sec-Fetch-Mode`/`Sec-Fetch-Dest` they must be `navigate`/
`document`; a foreign `Origin` is refused), and only with a waiting `state`,
which it spends. It exchanges the code at `https://accounts.spotify.com/api/token`
(form body, no redirects, 10 s timeout), stores the tokens, broadcasts, and shows
"Connected. You can close this tab." (or a short error page). Pages have
`Content-Security-Policy: default-src 'none'; style-src 'sha256-…'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
and `Referrer-Policy: no-referrer`.

**Tokens** live in the OS secret store, never in the config: the macOS login
Keychain (generic password, service `dev.gerikotori.windock.spotify`, account =
host ID, written through `security -i` with the command on stdin so the secret
is never in an argv), Windows DPAPI for the current user (WinDockHelper
`protect-write`/`protect-read`, secret on stdin/stdout, blob
`spotify-tokens.dpapi` in the data folder), else a 0600 file
`spotify-tokens.json`. The access token is refreshed 5 minutes before it
expires, one refresh at a time; a refresh that answers `invalid_grant` deletes
the sign-in (`error: "disconnected"`). Codes and tokens are never logged.

**States and errors** for every `/api/spotify/*` route except `status`:
501 `spotify not configured` (no client ID), 409 `spotify not connected`,
409 `spotify disconnected` (the sign-in was revoked; a 401 from Spotify is
retried once after a refresh first), 403 `premium required` (Spotify's
`PREMIUM_REQUIRED`), 403 `spotify user not allowed` (the account is not in the
app's User Management list), 409 `no active device` (`NO_ACTIVE_DEVICE`, or a
404 from a player command), 429 `rate limited` with `Retry-After` (the host
honours Spotify's `Retry-After`, up to 60 s, and answers 429 itself meanwhile),
502 `spotify unavailable`.

**Validation.** Spotify IDs are 22 base62 characters; URIs are
`spotify:<type>:<id>` with `uri` a track or episode and `contextUri` an album,
playlist or artist (an artist context cannot take a starting `uri`). Device IDs
are 1–128 of `[A-Za-z0-9_-]`.

**Shapes.** A page is `{ items, total, offset, limit, next: bool }`.
Playlist: `{ id, uri, name, owner: { id, name }, tracks: <count> | null, collaborative, image }`.
Track: `{ type: "track", id, uri, name, artists: [{ id, uri, name }], album: { id, uri, name }, durationMs, explicit, playable, image }`
(episodes: `{ type: "episode", id, uri, name, show, durationMs, image }`).
Album: `{ id, uri, name, artists, tracks, releaseDate, image }`. Artist:
`{ id, uri, name, image }`. `status.playback` is null (nothing playing, not
connected) or `{ device, playing, item, context: { type, uri }, progressMs, shuffle, repeat: "off" | "track" | "context" }`
(read at most every 2 s).

**Images.** `image` is an opaque key (or null) for `GET /api/spotify/image`.
Keys are stable per entity (`spotify:playlist:…`, `spotify:album:…`), so a tile
keeps its key across restarts; Spotify image URLs expire within a day, so the
host re-resolves an entity's image after 6 hours. The host fetches only from
`i.scdn.co`, `mosaic.scdn.co`, `image-cdn-ak.spotifycdn.com` and
`image-cdn-fa.spotifycdn.com` (https, no redirects, 2 MB cap, PNG/JPEG only),
picks the largest variant ≤ 300 px, resizes larger ones where the provider can
(macOS `sips`), and caches bytes by key.

**Power.** Lock is not a destructive verb: it works with `allowDestructive`
false. On a Mac, restart and shut down go through System Events and need a
one-time Automation permission: until granted the host answers
`409 { "error": "permission needed", "scope": "system-events", "status": "needed" }`
and still runs the action, so macOS shows its prompt and OK there carries it
out; with `"status": "denied"` nothing runs (the phone offers
`/api/permissions/open-settings`). macOS sleep is `pmset sleepnow`; lock is
`SACLockScreenImmediate` (login.framework, no admin or Accessibility needed),
falling back to `pmset displaysleepnow`, which locks only when "Require
password" is set to immediately.

**Permissions (macOS).** Reading media never prompts: each player script checks
that the player is running and asks the system, without prompting
(`AEDeterminePermissionToAutomateTarget`), whether it may send it Apple events.
Only `/api/permissions/request` shows the prompt. macOS attributes the prompt to
the app that started the host (WinDock, or Terminal when run by hand).

## WebSockets

| Path | Purpose |
| --- | --- |
| `/` | Dock sync: read-only. The host sends a snapshot on connect and after every change; clients never mutate over it. The host pings every 30 s and drops silent clients. |
| `/input` | Touchpad and keyboard: one owner at a time, frames ≤ 8 KiB, rate-limited, lease-based. |

Upgrades need the same auth as `/api/*` (session cookie or local trust) and a
same-origin `Origin` when one is sent; otherwise `401`.

Snapshot message:

```json
{
  "type": "snapshot",
  "platform": "windows",
  "platformName": "Windows",
  "hostName": "DESKTOP-1",
  "features": {
    "controls": true, "nowPlaying": true, "capture": true, "input": true,
    "close": true,
    "media": { "sources": "system", "players": [], "artwork": false, "sessions": false },
    "volume": { "get": true, "set": true, "mute": false },
    "power": { "lock": "ready", "sleep": "ready", "restart": "ready", "shutdown": "ready" },
    "spotify": { "installed": false, "local": { "nowPlaying": true, "transport": true, "artwork": false, "seek": false, "shuffle": false, "repeat": false }, "account": { "available": true, "connected": true, "premium": true, "name": "Geri", "error": null } }
  },
  "session": { "locked": false },
  "tiles": [
    { "kind": "app", "id": "…", "label": "…", "running": false, "available": true },
    { "kind": "spotify", "uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "label": "Chill", "image": "9f2c…", "available": true }
  ],
  "running": [{ "id": "…", "pid": 4812, "title": "…", "closable": true }],
  "verbs": ["volume-up", "…"],
  "allowDestructive": true
}
```

`features` says what the host offers; a missing `features` (older host) means
everything is on. `verbs` is empty when `controls` is false, and lists only the
verbs this host maps (a Mac has no `brightness-set`). Control tiles carry
`available: features.controls && verbs.includes(verb)`.

**Spotify tiles** (`kind: "spotify"`) play one playlist or album:
`{ kind, uri: "spotify:(playlist|album):<22 base62>", label, image: <32-hex key or ""> }`.
Anything else is dropped when tiles are saved; duplicates are folded by
`spotify:<uri>`. In the snapshot `image` is always the host's key for that URI
and `available` is true while the account is connected. The phone plays a tile
with `POST /api/spotify/play { contextUri: uri }`.

The four legacy booleans keep "missing means on". Every newer key is
**missing means not offered**:

| Key | Windows | macOS | Linux |
| --- | --- | --- | --- |
| `close` | true | true | omitted |
| `media.sources` | `"system"` (any app, via the system media session) | `"apps"` (Spotify and Music) | omitted |
| `media.players` | Spotify, when installed (`permission: "not-required"`) | Spotify and Music, when installed, with `running` and `permission` (`granted`/`needed`/`denied`) | — |
| `media.artwork`, `media.sessions` | false, false (until the helper reports thumbnails and sessions) | true, false | — |
| `volume` | get, set; `mute: false` (the helper cannot read mute yet) | get, set, mute | omitted |
| `power` | all `ready` | lock, sleep `ready`; restart, shutdown `needs-permission` until System Events is allowed, then `ready` (or `denied`) | omitted |
| `spotify` | `installed` from the catalog; `local` nowPlaying + transport | `installed`; `local` all true | omitted |
| `spotify.account` | `{ available: false }` until a client ID is set; then `{ available: true, connected, premium: true \| false \| null, name, error }` | same | same (with `installed: false` and `local` all false) |

`session` is live: `{ locked }` where the host can tell (macOS, from
`CGSessionCopyCurrentDictionary`); omitted otherwise. Each `running[]` entry
carries `closable`.

While at least one dock socket is open the host polls running apps every 3 s
(one poll at a time) and broadcasts a snapshot when the set of `(id, pid)`
pairs, the capability map or `session` changes; window-title changes alone do
not broadcast. The poll stops when the last dock disconnects.

## Versioning

`/health` reports `api: 1`. Additive changes (new fields, new routes, new error
strings) keep `api: 1`; clients ignore unknown fields. A breaking change to an
existing route or field bumps `api`. Pairing changes in this version (6-digit
PIN, pairing window, `pairingOpen`, devices) are additive for phones: the web UI
ships with the host, and the native shells only read `/health` and discovery.
