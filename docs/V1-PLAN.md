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
