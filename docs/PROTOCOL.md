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

## Pairing

`POST /api/auth` with JSON `{ "pin": "123456", "deviceName": "iPhone" }`.

- **PIN:** exactly 6 ASCII digits, uniformly random.
- **Window:** pairing is open for 10 minutes after the host starts and for 10
  minutes after every local `GET /api/pairing` (`npm run info`, macOS installer,
  Windows tray *Show connection info*). Each reopen grants a full 10 minutes.
- **Single use:** a new PIN is generated after every successful pairing.
- **Budget:** wrong PINs from all clients share a budget of 10 per window. The
  tenth rotates the PIN and closes the window until the next local
  `GET /api/pairing`, which also resets the count.
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
| GET | `/api/pairing` | `{ endpoint, pin, hostName, hostId, secureEndpoint, securityCode, pairingOpenForMs }`; reopens the pairing window |
| GET | `/api/devices` | `{ devices: [{ id, name, issuedAt, lastSeenAt }] }`, newest first. `id` is 16 hex characters, never derived from the token. Times are ms since epoch |
| DELETE | `/api/devices/<id>` | `{ ok: true, id }`, or 404 `{ "error": "unknown device" }` |
| DELETE | `/api/devices` | `{ ok: true, revoked: n }` |

Revoking a device makes its cookie get 401 and closes its open WebSockets
(sync and input) at once with close code `1008`, reason `session revoked`.

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
| POST | `/api/control` | `{ verb, value? }` | `{ ok: true, verb }` | 400 unknown verb / bad value, 403 `power actions disabled`, 501 `controls unavailable`, 503 with an actionable message |
| GET | `/api/nowplaying` | — | `{ nowPlaying: {...} \| null }` (null when the host lacks the feature) | |
| GET | `/api/stats` | — | CPU, memory, battery (fields may be missing) | |
| GET | `/api/capture` | — | `{ available, phase, … }` | |
| POST | `/api/capture/screenshot`, `/start`, `/stop` | `{}` | Capture status | 400 options given, 501 not on this host, 503 |
| GET | `/api/input` | — | `{ available, keyboard, signatureInsert }` | |
| POST | `/api/signature`, `/api/signature/insert` | Signature strokes | Saved result | 400, 501, 503 |

Unknown `/api/*` routes are 404 `{ "error": "not found" }`; unexpected failures
are 500 `{ "error": "internal error" }` with no detail.

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
  "features": { "controls": true, "nowPlaying": true, "capture": true, "input": true },
  "tiles": [{ "kind": "app", "id": "…", "label": "…", "running": false, "available": true }],
  "running": [{ "id": "…", "pid": 4812, "title": "…" }],
  "verbs": ["volume-up", "…"],
  "allowDestructive": true
}
```

`features` says what the host offers; a missing `features` (older host) means
everything is on. `verbs` is empty when `controls` is false. Control tiles carry
`available: features.controls`.

## Versioning

`/health` reports `api: 1`. Additive changes (new fields, new routes, new error
strings) keep `api: 1`; clients ignore unknown fields. A breaking change to an
existing route or field bumps `api`. Pairing changes in this version (6-digit
PIN, pairing window, `pairingOpen`, devices) are additive for phones: the web UI
ships with the host, and the native shells only read `/health` and discovery.
