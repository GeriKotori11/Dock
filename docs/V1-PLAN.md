# Cross-platform V1: audit and plan

Audit date: 2026-10-20, against upstream `aliihsaad/WinDock` v0.2.2 (commit `ddfe520`
in this repository). "Verified" means inspected in code or run on this Mac
(macOS 27, Node 26, Xcode 27.1). "Assumed" means not yet tested.

## Current architecture (verified)

- **Host**: Node.js (`server.js`, ESM, one dependency: `ws`). It serves the shared
  web UI (`public/`) and an HTTP JSON API, pushes dock snapshots over WebSocket
  (`src/sync.js`), and answers UDP broadcast discovery on port 41234
  (`src/discovery.js`). All OS work goes through a **provider** that implements
  `src/platform/contract.js`. Providers: `windows.js` (constant PowerShell for
  inventory, `WinDockHelper.exe` C# argv verbs for actions/icons) and `linux.js` (dev).
  There is **no darwin provider**: `npm start` on macOS exits with
  `unsupported platform: darwin`.
- **Client UI**: one vanilla-JS web app (`public/`), loaded from the host.
  It handles pairing, the dock (pages, long-press arrange, drag reorder), the app
  picker, appearance, and the Windows-only extras (controls, capture, touchpad,
  signature).
- **Android**: a Kotlin WebView shell (`android/`). It does UDP discovery, validates
  private-IPv4 endpoints, remembers one Wi-Fi and one USB address, and locks the
  WebView to that origin.
- **iOS**: a Swift WKWebView shell (`ios/`, XcodeGen). It takes a manual private-IPv4
  address only, runs a bounded `/health` probe, applies origin-locked content rules,
  and keeps the pairing cookie. It has simulator integration tests in CI, but it is
  unsigned and has not been tested on a device.
- **Windows tray**: a C# WinForms app (`native/tray`). It starts Node, parses
  `PIN: dddd` from stdout, and offers startup at login through the Inno installer.
- **Pairing**: a 4-digit PIN that stays the same for the life of the process. A
  correct PIN earns a 32-byte random session token in an HttpOnly cookie. Sessions
  are held **in memory only**, so every host restart forces a re-pair. Failed
  attempts are limited per IP (5 failures, then a 60 s lockout). Loopback is trusted.
  State-changing requests are origin-checked. Transport is **plain HTTP**.
- **Favorites**: stored **on the host** (`config.json`, written atomically), separate
  from the app catalog. The catalog is rescanned at most every 60 s. Launch resolves
  `id` against the host's own inventory, so the client never supplies a path.
- **Tests**: `npm test` runs 19 Node oracles. All pass on this Mac (1,096 assertions).
  There are also Android unit and instrumented tests, iOS XCTest, and Windows native
  smoke scripts.
- **License**: MIT, (c) 2026 Ali Saad. Reuse is fine with attribution kept.

## Keep, change, add

| Area | Keep | Change / add |
| --- | --- | --- |
| Provider contract | Yes, it is the right seam | Add a macOS provider; add per-host `features` |
| Windows provider | Yes, untouched | None in V1 beyond the shared changes |
| Shared web UI | Yes, it is the shared client for both phones | Platform-neutral copy, hide unsupported features, stale-tile state |
| Pairing/auth | PIN flow, lockout, origin checks | Persist hashed sessions; host identity; later TLS pinning and stronger codes |
| Discovery | UDP broadcast (Android) | Add Bonjour `_windock._tcp`, because iOS cannot broadcast without a special entitlement |
| Phone shells | Both | A saved-computers list with a selector, discovery, IP-change handling |
| Favorites | Host-side storage, one dock per computer | Mark tiles whose app has disappeared |
| Out-of-scope extras (media, power, capture, touchpad) | Left as-is on Windows | Not ported to macOS; hidden when a host lacks them |

## Technology decision

No framework migration. The existing split already gives **one shared client** (the
web UI, identical on Android and iOS) and **one shared host core** with OS-specific
providers. Rewriting in Flutter or React Native would duplicate working code and
gain nothing for this product. V1 needs:

1. A **macOS provider** that uses JXA (`osascript -l JavaScript`) with constant
   scripts and argv input, mirroring the Windows constant-PowerShell design. App
   identity is the **bundle identifier**, and launch uses `/usr/bin/open -b <id>`
   (argv, no shell). A feasibility probe on this Mac read 95 apps in about 0.7 s,
   all with bundle IDs, plus localized names and running apps, with no permission
   prompts.
2. Thin native phone shells that manage *which* computer to load. The dock itself
   stays in the shared web UI.

### Decision: favorites stay on the host

The brief lists favorites under phone persistence. They are kept host-side because:

- the dock is per-computer by construction;
- it survives phone reinstalls;
- it is already implemented, atomic and tested;
- the catalog is already separate from the tiles.

The phone persists the list of computers it has paired with, plus the pairing
cookie. This decision is reversible: a phone-side cache can be added later.

## Phases

1. **Shared host stabilization** (testable on any OS):
   - persistent hashed sessions;
   - stable host ID and name in `/health`;
   - a per-host `features` map with UI hiding;
   - platform-neutral copy;
   - stale and unavailable tiles;
   - clear launch errors;
   - catalog cache that serves stale results while it refreshes.
2. **macOS host**:
   - the provider (catalog, icons, running apps, launch, focus, close);
   - a darwin data directory;
   - a LaunchAgent, plus a loopback-only way to read the URL and PIN;
   - docs.
   - Milestone: **macOS + Android** end to end (emulator here; a real phone needs
     the user).
3. **Identity and transport security**:
   - self-signed TLS whose certificate fingerprint is pinned at pairing (TOFU);
   - a stronger pairing code with a pairing window;
   - a global failure limit;
   - a paired-device list with revocation.
   - The HTTP listener stays available during the transition so existing APKs
     keep working.
4. **Phone shells**:
   - a saved-computers list with a selector on Android and iOS;
   - Bonjour discovery (iOS `NWBrowser`, Android `NsdManager` alongside the existing
     UDP discovery);
   - IP-change handling keyed by host ID;
   - WebView trust that checks the pinned fingerprint;
   - resume and reconnect behavior.
5. **Verification and polish**:
   - the four-combination matrix (real device versus simulator recorded honestly);
   - install docs for each platform;
   - packaging.

## Main risks

- **Windows cannot be run here.** Windows-side changes stay minimal and are covered by
  mocked oracles; the user must validate them on a real PC.
- **iOS on a device needs signing.** A free Apple ID works but needs re-signing every
  7 days. The user must grant Local Network permission. UDP broadcast needs Apple's
  multicast entitlement, which is why Bonjour is the plan.
- **Pairing cookies are tied to the host's IP address.** An IP change currently means
  re-pairing. Moving the cookie safely to a new address requires pinned TLS identity;
  otherwise a LAN impostor could claim the host ID and receive the cookie.
- **The PIN is weak.** A 4-digit, per-IP lockout can be brute-forced over hours by
  rotating addresses. This is fixed in phase 3.
- **WebView with a self-signed certificate.** Both platforms support custom trust
  evaluation. It must be pinned, never "accept all".
- **macOS host behavior.** The firewall prompts for Node. JXA is old but present
  on macOS 27. The user needs Node installed until packaging.


## To-do (requested, not yet scheduled)

- **Desktop host interface (user request, 2026-10-20).** The computer-side app
  needs a real interface on both Windows and macOS. Today Windows has only a tray
  menu, and macOS has a terminal plus `npm run info`. At minimum it should show:
  - running status;
  - address, PIN and pairing QR code;
  - the security code;
  - paired phones, with revoke;
  - start at login;
  - quit.

  Design and technology are still to be decided. Options: a native shell on each
  OS (extend the Windows tray, add a macOS menu-bar app) or one shared local
  web page served on loopback.

## Status log

### 2026-10-20: milestone 1 (shared host fixes and macOS host), done

- Pairing sessions now persist as hashed tokens and survive host restarts.
- `/health` reports `hostId`, `hostName` and `api`.
- macOS data directory is `~/Library/Application Support/WinDock`.
- New macOS provider:
  - JXA catalog with 95 apps on the dev Mac, identified by bundle ID;
  - 256px icons;
  - running apps;
  - launch with `open -b`, plus focus and polite quit.
- Per-host `features` map; the UI hides controls, capture and touchpad when a host lacks them.
- Catalog cache serves stale results while it refreshes; launch rescans once on a miss.
- Launch errors are clear: 404 for an unknown app, 502 when the launch fails.
- Tiles whose app has gone are dimmed.
- `npm test`: 20/20.

Validation (emulator and simulator only, **not real devices**), with the macOS host
reached over the LAN IP so pairing was exercised:

| Combination | Result |
| --- | --- |
| macOS host + Android emulator (API 37) | Pass: manual IP, wrong/correct PIN, add apps, launch Calculator, restart host with no re-pair, cold relaunch. UDP discovery did not cross the emulator NAT (expected). |
| macOS host + iOS simulator (iPhone 17) | Pass: manual IP, pair, shared dock, launch TextEdit, live running state on the other phone. XCTest 7/7. |
| macOS host + real Android phone | User reported a successful test on 2026-10-20 (details not recorded). |
| Windows host + either phone | Not re-run here (no Windows machine). Windows provider unchanged; shared changes covered by mocked oracles. |

Open items carried forward:
- Leftover PC/Windows wording in the web pairing page and in the iOS and Android shells.
- The macOS host has no UI showing the PIN.
- "1 apps" plural bug.
- No visible disconnected state on the dock.
- Dock layout with few tiles.

### 2026-10-20: milestone 2 (finish the macOS host), done

- **Security:** loopback trust now also requires a loopback-literal `Host` header. This closes a DNS-rebinding path that let any website open on the host launch apps.
- **Pairing info:** `npm run info` (local-only `GET /api/pairing`) shows the address and PIN.
- **Login item:** `npm run mac:install|uninstall|status` manages a LaunchAgent, and the PIN is kept out of its logs. See `docs/INSTALL-MACOS.md`.
- **Screen stays on (user requirement):** phone screens never turn off while WinDock is open.
  - Android sets `FLAG_KEEP_SCREEN_ON` whenever the app is resumed, and the Screen-off/rest feature was removed.
  - iOS disables the idle timer.
- **Wording and dock polish:**
  - Platform-neutral wording in the web UI and both phone shells.
  - "Reconnecting to …" pill when the host drops off.
  - A single row of tiles is centred.
- **Verification:**
  - `npm test` passes 21/21.
  - All 7 Android instrumented tests pass on the API 37 emulator, each run with its fixture.
  - Manual emulator check: the screen stays awake in-app past a 15 s system timeout and sleeps normally outside the app.
  - iOS simulator build succeeds.

### 2026-10-20: milestone 3 (identity and transport security), done

**Host**
- HTTPS on the same port as plain HTTP.
  - The certificate is a dependency-free, self-signed ECDSA P-256 X.509 certificate.
  - The security code is the first 6 bytes of the SHA-256 fingerprint.
- Pairing hardening:
  - single-use 6-digit codes;
  - a 10-minute pairing window, reopened by `npm run info` or the Windows tray;
  - a global budget of 10 failed attempts, after which the code rotates and the window closes.
- Device management: `npm run devices` lists and revokes phones, and revoking closes their live sockets.
- The contract is documented in `docs/PROTOCOL.md`.

**Phones (Android and iOS)**
- They probe over HTTPS and confirm the security code on first contact.
- After that they pin the host ID to the leaf certificate's SHA-256.
- If the certificate changes, they show a "Security code changed" warning with a forget-and-re-pair option.
- The WebView trusts only the pinned certificate, and this also covers wss.
- iOS moved to the UIScene lifecycle; without it the app did not launch on iOS 27.

**Verification**
- `npm test`: 22/22 oracles pass.
- iOS: XCTest 16/16 on both iOS 27.0 and iOS 26.5.
- Android: unit and instrumented tests pass. The exception is `UsbDiscoveryTest`, which only fails when another host is holding UDP port 41234.
- Upgrade path on the API 37 emulator: pair over HTTP, then the host enables TLS. The phone confirms the security code once, opens the dock over HTTPS without asking for the PIN, and launches apps. Revoke, re-pair and the closed-window message also work.
- The Windows tray change was compile-checked only.

**Carried to milestone 4**
- A host with a new identity at a known address gets the confirmation prompt, not a warning. The saved-computers list should warn instead.
- Android WebView cookie flush on force-stop.
- Probe HTTPS first, so that hosts running with `WINDOCK_PLAIN_HTTP=0` are reachable.

### 2026-10-20: milestone 4 (phone apps: computers, discovery, native pairing), done

**Design**
- Designer spec and mockups in `docs/design/`.
- User decisions:
  - native PIN entry;
  - Android Back opens the switch sheet;
  - Forget revokes the session on both the phone and the host;
  - all other recommendations accepted.

**Host**
- Bonjour advertisement of `_windock._tcp`: `dns-sd` on macOS, a dependency-free mDNS responder on Windows and Linux.
- `DELETE /api/session`.
- Web bridge (`WinDockNative`): computer nickname, a drawer "Switch" row, a ready handshake, and an unauthorized hand-off.

**Phones (Android and iOS)**
- Native screens: Computers list, two-step pairing (security code, then native PIN), can't-reach, security-changed, switch sheet, and Local Network priming and denied screens on iOS.
- Discovery uses Bonjour and UDP. Results are merged by hostId and verified over pinned HTTPS.
- Saved computers are keyed by hostId plus pin. If a computer's IP changes, the session cookie moves with it and no PIN is needed.
- Probing tries HTTPS first.
- Existing pairings migrate without any prompts.

**Verification**
- `npm test` 23/23.
- Android: unit and instrumented tests pass on the API 37 emulator.
- iOS: 53 tests pass on both iOS 27.0 and 26.5.
- Manual passes against real hosts in the emulator and simulator: pairing, wrong PIN, pairing closed, switch sheet, forget on both sides, can't-reach then recovered, security changed, and a new address (simulated on iOS).
- **Real device (Samsung Galaxy A40, Android):**
  - The update installed over the previous build and the pairing migrated straight into the dock with no prompts.
  - Back opens the native Switch sheet.
  - The keep-screen-on flag is set.
  - The drawer Switch row has not been checked yet: adb swipes were caught by the system gesture.

**Open**
- Windows host Bonjour responder: not run on Windows.
- iPhone real-device test: needs signing.
- Copy written by the workers but missing from the copy deck needs designer sign-off.
- Android single-column layout at large font scales.
- iOS README is out of date.
