# Developer reference

## Architecture

The Android app is a Kotlin WebView host: it discovers the PC by UDP broadcast,
remembers the endpoint, and loads the same web interface served to browsers.
The web interface handles pairing; the Android wrapper does not receive the PIN
or session cookie. Ordinary browsers do not perform UDP discovery.

The Node host owns pinned tiles and publishes updates over WebSocket. Platform
providers implement a common contract. The Windows provider invokes a C# helper
for app identity, launch, focus, icons, media, brightness, and screen capture.
A Linux provider supports development without the Windows native layer.

| Path | Responsibility |
| --- | --- |
| `server.js` | HTTP API, static serving, provider wiring |
| `src/platform/` | Provider contract, Windows/Linux implementations, capture lifecycle |
| `src/auth.js` | PIN pairing window, sessions and paired devices, lockout |
| `src/config.js` | Atomic tile persistence |
| `src/discovery.js` | UDP responder |
| `src/sync.js` | WebSocket updates |
| `src/input-hub.js`, `src/input.js` | Exclusive touchpad channel, bounded input/signature validation |
| `src/platform/input.js` | Persistent Windows touchpad helper and signature export process |
| `public/` | Shared dock UI and offline shell |
| `android/` | Discovery, validated endpoints, landscape WebView |
| `native/win/` | Windows helper |
| `native/tray/` | System tray host |
| `website/` | Static product website and isolated demo |
| `scripts/verify-*.mjs` | Platform-independent verification scripts |

## Boundaries

- Native commands use `execFile` with argument arrays and `shell: false`.
  Inventory and telemetry use fixed read-only PowerShell scripts without
  interpolating user input. Control verbs are allowlisted.
- App close uses `WM_CLOSE`, allowing the application to offer a save prompt.
- Shortcut argument strings are preserved. Shortcut profiles have separate IDs
  because an executable path alone cannot identify the requested launch mode.
- Packaged Windows apps use stable app identities rather than versioned paths
  inside WindowsApps.
- The service worker never caches `/api/` requests or replays actions. It needs
  a secure origin; ordinary LAN HTTP can serve the online interface only.
- Android permits LAN HTTP, validates private/loopback IPv4 endpoints, and
  restricts navigation and intercepted requests to the selected origin. DNS
  names other than localhost and IPv6 are not supported by this wrapper yet.

## Pairing and network access

The phone↔host contract (endpoints, fields, error codes) is written down in
[PROTOCOL.md](PROTOCOL.md); this section covers how it is implemented.

One TCP port serves both plain HTTP and HTTPS: `createSharedPortListener` in
`src/tls.js` hands each connection to the http or https server by its first
byte. The certificate is a self-signed ECDSA P-256 one kept in the data
directory (`tls-key.pem`, `tls-cert.pem`); phones pin its SHA-256 fingerprint
when they first pair, and the security code (first 6 bytes of the fingerprint,
`XXXX-XXXX-XXXX`) lets a person compare phone and computer by eye.
`WINDOCK_TLS=0` turns HTTPS off; `WINDOCK_PLAIN_HTTP=0` turns plain HTTP off.

`POST /api/auth` exchanges a 6-digit PIN for a session. Other `/api/*` routes
require that session or trusted loopback access. `/health` and the web UI are
public. PIN comparison is constant-time; five failed attempts lock a client out
for 60 seconds. On top of that (`createPairing` in `src/auth.js`):

- **Pairing window.** Pairing is open for 10 minutes after the host starts and
  again for 10 minutes after every local `GET /api/pairing` (`npm run info`,
  `npm run mac:install`, the Windows tray's *Show connection info*). While it is
  closed, `POST /api/auth` answers 403 `pairing closed` without looking at the
  PIN and without counting a failure.
- **Single-use codes.** A new code is generated after each successful pairing.
- **Global failure budget.** Wrong PINs from every client share a budget of 10
  per window. The tenth rotates the code and closes the window; only a local
  `GET /api/pairing` reopens it, which also resets the count. Malformed PINs
  (400 `invalid pin`) count against the per-client lockout only.

`createApp` takes `nextPin` and `now` (or a whole `pairing`) so tests and the
device fixture hosts can fix the code and the clock.

Cookies use `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS. Their maximum
age is 180 days. Sessions persist in `sessions.json` in the data directory as
SHA-256 hashes of the tokens (never the tokens themselves), written atomically
with owner-only permissions, so paired devices survive host restarts. Expired
entries are dropped and at most 64 sessions are kept, oldest first out.

Each session is a **paired device** with a random public `id` (8 bytes hex,
never derived from the token), a `name` (the phone's `deviceName`, sanitised,
default `Phone`), `issuedAt` and `lastSeenAt`. `lastSeenAt` is written at most
once an hour per session. Files from before device management load with a new
id, the name `Phone` and `lastSeenAt = issuedAt`, and are rewritten in place
(still `version: 1`). `GET /api/devices`, `DELETE /api/devices/<id>` and
`DELETE /api/devices` list and revoke devices; like `/api/pairing` they answer
loopback-trusted requests only. Revoking also closes that session's open sync
and input WebSockets at once (`disconnect(hash)` / `disconnectAll()` on both
hubs). `npm run devices` (`scripts/windock-devices.mjs`) is the local client:

```sh
npm run devices                    # name, short id, paired date, last seen
npm run devices -- revoke <id>     # full id or a unique prefix (4+ characters)
npm run devices -- revoke-all
```

The data directory holds `config.json`, `sessions.json` and `host.json`. It is
`%APPDATA%\windock` on Windows, `~/Library/Application Support/WinDock` on macOS
and `~/.config/windock` elsewhere; when `WINDOCK_CONFIG` is set, its directory is
used instead. `host.json` holds a random host ID created on first run.

`GET /health` returns `ok`, `app: "windock"`, `platform`, the stable `hostId`,
`hostName`, `api` (currently `1`), `tls` (fingerprint and code, or `null`) and
`pairingOpen`. It stays under 4096 bytes, the limit the phone apps' probes
accept, and never includes the PIN or session data.

State-changing requests and WebSocket upgrades check the request origin.
Loopback is trusted by default for the tray, which calls
`http://127.0.0.1:<port>`. Trust needs **both** a loopback socket address and a
`Host` header naming a loopback literal: `localhost`, a `127.0.0.0/8` dotted quad
or `[::1]`, with any port (`isLoopbackHost` in `src/auth.js`). This blocks DNS
rebinding: a website on the host can point its own hostname at 127.0.0.1, but
the browser then sends that hostname as `Host` (and a matching `Origin`), so the
request gets no loopback trust. A loopback request with any other `Host`, or
none, falls through to ordinary session auth, so a paired cookie still works
and a bare request gets 401. The same rule covers the `/` and `/input`
WebSocket upgrades. `trustLoopback: false` in `createApp` also requires pairing
on the host. Discovery never includes the PIN.

`GET /api/pairing` returns `{ endpoint, pin, hostName, hostId, secureEndpoint,
securityCode, pairingOpenForMs }` (`endpoint` is the LAN URL the host
advertises) and reopens the pairing window. It answers only loopback-trusted
requests and returns 403 to everyone else, including paired phones. `npm run
info` (`scripts/windock-info.mjs`) reads it from `http://127.0.0.1:${PORT:-8620}`
and prints `Pairing: open for N more minutes`.
With `WINDOCK_HIDE_PIN=1` the startup banner prints
`PIN:      (run "npm run info" to show it)` instead of the PIN, so the PIN stays
out of log files; the macOS LaunchAgent sets it. The default banner keeps its
format because the Windows tray parses `open:` and `PIN:\s*(\d{4,8})` from it;
the banner shows the initial code, so the tray's *Show connection info* asks
`/api/pairing` for the current one (falling back to the banner's).

On macOS, `npm run mac:install` (`scripts/macos-agent.mjs`) writes
`~/Library/LaunchAgents/dev.windock.host.plist` and bootstraps it into the
`gui/<uid>` domain with `launchctl` (argv only, no shell). The agent runs
`server.js` with the absolute Node path that ran the installer, `RunAtLoad`,
`KeepAlive: { SuccessfulExit: false }` and a fixed system `PATH`, and logs to
`~/Library/Logs/WinDock/host.log`. `--label` and `--port` install a separate copy
for testing; a non-default label logs to `<label>.log`. See
[Install on macOS](INSTALL-MACOS.md).
The PIN pairing and LAN design are intended for a trusted local network; do not
expose the host port directly to the internet.

## Windows configuration and checks

Touchpad input uses a dedicated `/input` WebSocket; the ordinary dock socket
remains read-only. Upgrades check pairing and origin; messages and the lease
timer recheck session validity. Only one device owns the input worker at once.
Frames are limited to 8192 bytes and 240 messages/second; deltas are bounded.
The phone sends a heartbeat every 500 ms and the host expires an idle input
session after 2 seconds. The native helper independently releases buttons on
stdin EOF or a 2-second read timeout, including if the Node host disappears.
Movement is relative Win32 mouse input; it follows Windows UIPI restrictions.
Two-finger gestures sample both pointers once per frame and lock to scroll or
pinch. Zoom accepts only `{type: "zoom", steps: -8..-1 | 1..8}` and sends
Ctrl + complete 120-unit wheel notches in one native input batch. An existing
Ctrl press is preserved; partial injection releases the synthetic modifier,
with teardown retrying a failed release. Text is bounded to 1024 valid UTF-16 code
units; only named editing keys are accepted. No arbitrary shortcuts are exposed.
The helper watches UI Automation focus on a separate MTA thread while the input
session is active. It emits only opaque focus tokens, editability and password
flags, never field values. Keyboard input requires the current token and foreground
window, and is refused while physical modifier keys are held. Unicode input uses
paired Win32 KEYEVENTF_UNICODE packets, preserving emoji surrogate pairs.
Android's origin-scoped bridge opens a native IME editor. Composition remains
local until committed; each new target invalidates old input connections and
discards pending text. The web fallback has a manually opened composer.

`GET /api/input` advertises support. `POST /api/signature` accepts only black/blue
ink and up to 64 strokes / 2048 normalized points in the existing 64 KiB body
limit. The helper rasterizes validated vectors to transparent PNG. Clients cannot
supply output paths, filenames, dimensions, native commands, or arbitrary SVG.
POST /api/signature/insert uses the same validation, saves a PNG, writes PNG and
bitmap clipboard formats, and requests Ctrl+V only if foreground focus is unchanged
and no physical modifier is down. A successful paste request does not prove the
receiving app accepted an image. Otherwise the clipboard/file remain available.
Only explicit Save or Insert creates a file; strokes are kept in memory on the phone,
not persisted to browser storage or added to logs. This is image export, not
cryptographic document signing.

`scripts/verify-input.mjs` tests protocol validation, authentication, origin,
ownership, timeout/revocation cleanup, native-process handling and gestures.
`dotnet run --project native/input-tests/WinDockInputTests.csproj -c Release`
checks the native INPUT layout, button/modifier cleanup and PNG transparency/rendering
without moving the desktop cursor. It is also part of Windows CI.

The host prefers physical LAN adapters over VPN/VM adapters. Set `WINDOCK_HOST`
to choose another assigned local IPv4 address, `PORT` to change the port, or
`WINDOCK_HELPER` to select another helper executable. `WINDOCK_CONFIG` overrides
the configuration path; the normal tray uses the user's application-data folder.

Brightness uses WMI for built-in panels and DDC/CI for supported HDMI/DisplayPort
monitors, with a VCP luminance fallback. Percentages map to each display's range.
DDC/CI may need enabling in the monitor's own menu.

`WinDockHelper.exe brightness` reads support and current levels.
`node scripts/smoke-brightness.mjs` makes a five-point change and restores the
original level in a `finally` block. Add `--base-url http://127.0.0.1:8620`
to exercise the running host API. This hardware check is separate from `npm test`.

`node scripts/smoke-capture.mjs` explicitly creates a screenshot and short
recording. It is also separate from `npm test`. Captures stay on the PC and are
not served over HTTP. Recording uses one worker, main-monitor capture, silent
H.264 MP4 up to 1920×1080 / 15 fps, and a 60-minute limit.

`npm run test:installer` refuses to overwrite an existing installation or Start
menu shortcut. It tests a separate workspace installation and checks that
personal configuration is unchanged. See [Windows readiness](../WINDOWS_READINESS.md)
for the known focus-smoke failure and other hardware acceptance evidence.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Public health check |
| POST | `/api/auth` | Exchange PIN (and optional `deviceName`) for a session |
| GET | `/api/pairing` | Address and PIN for `npm run info`; reopens pairing; loopback only, 403 otherwise |
| GET | `/api/devices` | Paired devices, newest first; loopback only |
| DELETE | `/api/devices/<id>` | Revoke one device and close its sockets; loopback only |
| DELETE | `/api/devices` | Revoke every device; loopback only |
| GET | `/api/state` | Tiles, running apps, available verbs |
| GET | `/api/apps/installed` | Installed-app inventory |
| GET | `/api/apps/icon` | App icon by validated ID |
| GET / PUT | `/api/tiles` | Read or replace pinned tiles |
| POST | `/api/apps/launch` | Launch an app by ID |
| POST | `/api/apps/focus` | Focus a running PID |
| POST | `/api/apps/close` | Ask a running PID to close |
| POST | `/api/control` | Run an allowed control verb |
| GET | `/api/nowplaying` | Current media session |
| GET | `/api/stats` | CPU, memory, battery |
| GET | `/api/capture` | Recording phase, elapsed time, last saved file |
| POST | `/api/capture/screenshot` | Save the main monitor as PNG |
| POST | `/api/capture/start` | Start one silent MP4 recording; idempotent |
| POST | `/api/capture/stop` | Stop and finalize the recording |

Capture actions accept an empty JSON object and use the same authentication
and origin checks as other actions. Clients cannot choose output paths or
supply encoder arguments.

Control verbs: `volume-up`, `volume-down`, `volume-set`, `mute-toggle`,
`media-play-pause`, `media-next`, `media-previous`, `media-stop`, `brightness-set`,
`lock`, `sleep`, `shutdown`, and `restart`. `volume-set` and `brightness-set`
take integers from 0 to 100; their tiles are keyed by both verb and value.

## Windows update checks

The tray checks `https://windock.vercel.app/downloads.json` once after startup
and on **Check for updates**. `native/tray/UpdateChecker.cs` compares semantic
versions (including preview numbers) against the tray's informational version.
Only this repository's tagged installer URL is accepted. The check has a
12-second timeout and a 64 KiB response limit; startup failures are silent.
An available update shows a notification and a download menu item that opens
the GitHub release page. The app never downloads or executes an installer itself.

Run `dotnet run --project native/update-tests/WinDockUpdateTests.csproj -c Release`
for version, HTTP, invalid-feed and notification-policy checks. Add `-- --live`
after publishing 0.2.1-preview.1 to check the actual public feed for current and
older installations. Update `package.json`, `package-lock.json`, and the tray
project's numeric/informational versions together for future Windows releases.
