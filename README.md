# WinDock (personal fork)

WinDock turns a phone into a dock for your computer. Keep the phone beside the
keyboard and tap an icon to open, focus or quit an app on the computer. The
computer runs a small Node.js host. The phone runs the WinDock app, which pairs
with the host and shows the dock. Everything stays on your local network: no
account, no cloud service, no internet access needed.

This is a personal fork of [WinDock by Ali Saad](https://github.com/aliihsaad/WinDock),
extended from "Windows PC + Android phone" to a macOS or Windows host with an
Android or iPhone client. The current plan and an honest status log are in
[docs/V1-PLAN.md](docs/V1-PLAN.md).


https://github.com/user-attachments/assets/b09a69a9-3dd9-4f4e-be36-1648a9d133a4



## Status

| Host | Phone | Status |
| --- | --- | --- |
| macOS | Android | Verified on real devices (Galaxy A40) |
| macOS | iPhone | Verified on a real iPhone, signed with a free Personal Team |
| Windows | Android | Not yet run on Windows since the fork. Windows code is compile-checked and covered by mocked tests only |
| Windows | iPhone | Not yet run on Windows. Same as above |

The Windows host worked upstream before the fork. What changed since then (the
tray window, the Bonjour responder and the installer) has never run on a
Windows PC. See [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) for the list.

There are no downloads. You build everything from this repository.

## Quick start

1. **Set up the computer.**
   - Mac: build the menu-bar app with `npm run mac:app`.
     See [docs/INSTALL-MACOS.md](docs/INSTALL-MACOS.md).
   - Windows: build with `npm run build:windows` and run the tray app.
     See [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md).
2. **Set up the phone.**
   - Android: build the APK and install it with `adb`.
   - iPhone: build and run it from Xcode with your Apple ID.
   - Both are in [docs/INSTALL-PHONES.md](docs/INSTALL-PHONES.md).
3. **Pair.** On the computer, open WinDock and choose **Pair a new phone**.
   On the phone, tap **Scan QR code** and point it at the code.
4. **Make it yours.** In the dock, swipe up and open **Apps** to pin apps.
   Hold an icon to rearrange.

The computer and the phone must be on the same Wi-Fi or wired network. Guest
networks and Wi-Fi with "client isolation" keep devices apart.

## How pairing works

- **Find the computer.** The phone looks for computers on the network: Bonjour
  (`_windock._tcp`) on both phones, plus UDP broadcast on Android. You can also
  add one by address, for example `192.168.1.20:8620`.
- **Check it is yours.** The phone shows the computer's **security code**
  (`XXXX-XXXX-XXXX`). Compare it with the code on the computer's screen.
- **Enter the PIN.** Type the **6-digit PIN** shown on the computer. Each PIN
  pairs one phone. Pairing stays open for 10 minutes, and 10 wrong PINs close
  it and change the PIN.
- **Or scan the QR code.** The code holds the address, the security code and
  the PIN, so scanning pairs in one step. The phone asks before it pairs.
- **After pairing.** The phone talks to the host over HTTPS. It pins the host's
  self-signed certificate, so it only trusts that one computer. If the
  certificate ever changes, the phone warns you and asks you to check.
- **Phones stay paired** across host restarts and address changes. You can
  remove a phone from the computer, or forget a computer on the phone.

The full contract is in [docs/PROTOCOL.md](docs/PROTOCOL.md). WinDock is meant
for a trusted home or office network. Never forward its port (8620) to the
internet.

## Everyday use

- **Computers list.** The phone keeps every computer it has paired with. Tap one
  to open its dock. Each computer has its own dock.
- **Switching.** Open the drawer in the dock and choose **Switch**. On Android,
  Back also opens the switch sheet.
- **The dock.** Choose 4, 6 or 8 icons per page, hold to rearrange, and drag to
  an edge to move an icon to another page. The pinned apps are stored on the
  computer, so every paired phone shows the same dock. Tiles for apps that were
  removed from the computer are dimmed.
- **Screen stays on.** The phone screen does not turn off while WinDock is
  open. On Android you can dim it after a while in **This phone**.

What each host supports:

| Feature | macOS host | Windows host |
| --- | --- | --- |
| App catalog with icons | Yes | Yes |
| Launch, focus and quit apps | Yes | Yes |
| Media, volume and brightness controls | No | Yes |
| Lock, sleep, restart, shut down | No | Yes |
| Screenshots and screen recording | No | Yes (saved to `Pictures\WinDock` and `Videos\WinDock`) |
| Touchpad, keyboard and signature | No | Yes |
| USB tethering (Android) | No | Yes |

The phone hides features the host doesn't have.

## Troubleshooting

- **The phone can't find the computer.** Check that both are on the same
  network and that WinDock is running. Add the computer by address instead;
  the address is on the computer's WinDock page or in `npm run info`.
- **The phone can't connect.** Allow incoming connections for `node` (macOS) or
  `node.exe` (Windows) when the firewall asks. On iPhone, turn on **Local
  Network** for WinDock in Settings.
- **"Pairing is closed".** On the computer, choose **Pair a new phone** (or run
  `npm run info`). That opens pairing for 10 minutes.
- **"Security code changed".** Expected after reinstalling or resetting
  WinDock on the computer. Compare the codes, then forget and pair again.

More detail: [macOS](docs/INSTALL-MACOS.md#troubleshooting),
[Windows](docs/INSTALL-WINDOWS.md#troubleshooting) and
[phones](docs/INSTALL-PHONES.md#troubleshooting).

## Development

You need Node.js 20 or newer. Run `npm ci` once. Then:

| Command | What it does |
| --- | --- |
| `npm test` | Run the platform-independent test suite (prints `SUITE OK`) |
| `npm start` | Run the host in this terminal |
| `npm run info` | Show the running host's address and PIN, and open pairing (on the host only) |
| `npm run devices` | List paired phones; `-- revoke <id>` or `-- revoke-all` removes them |
| `npm run mac:app` | macOS: build the menu-bar app, `macos/build/WinDock.app` |
| `npm run mac:install` | macOS: run the host at login as a LaunchAgent |
| `npm run mac:status` | macOS: show whether the LaunchAgent is loaded and healthy |
| `npm run mac:uninstall` | macOS: stop the host and remove the LaunchAgent |
| `npm run build:windows` | Windows: build the helper, tray and packaged host into `artifacts\WinDock-win-x64` |
| `npm run test:windows` | Windows: run native smoke checks |
| `npm run build:installer` | Windows: build `artifacts\installer\WinDockSetup.exe` (needs Inno Setup 7) |
| `npm run test:installer` | Windows: check install, launch, upgrade and uninstall |
| `npm run build:android` | Windows: build, test, lint and verify the Android APK |
| `npm run gates` | Show the upstream gate ledger status ([GATES.md](GATES.md), historical) |
| `npm run website` | Serve upstream's marketing site locally (unused here) |
| `npm run build:website-demo` | Regenerate that site's demo (unused here) |
| `npm run package:downloads` | Copy built installers into that site (unused here) |

The developer reference is [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Phone
builds and tests are in [android/README.md](android/README.md) and
[ios/README.md](ios/README.md).

## Project layout

| Path | What it is |
| --- | --- |
| `server.js` | Host entry point: HTTP/HTTPS API, static files, provider wiring |
| `src/` | Host core: pairing, TLS, discovery, Bonjour, sync, and the macOS, Windows and Linux providers |
| `public/` | Shared dock web UI, shown inside both phone apps |
| `host-ui/` | The computer's own control page (`/host`): pairing, QR code, paired phones |
| `macos/` | macOS menu-bar app (Swift) |
| `native/` | Windows: C# helper (`win/`), tray app (`tray/`), installer (`installer/`), test tools |
| `android/` | Android app (Kotlin) |
| `ios/` | iPhone app (Swift, XcodeGen) |
| `scripts/` | Command-line tools, build scripts and the test oracles |
| `test/` | Test suite runner |
| `docs/` | Plan, protocol, install guides and design specs |
| `website/`, `api/`, `lib/` | Upstream's marketing site and its download counter; unused here |
| `artifacts/` | Build output (git-ignored) |

## Credits and license

Based on [WinDock by Ali Saad](https://github.com/aliihsaad/WinDock) (MIT).
The upstream history is in [CHANGELOG.md](CHANGELOG.md), and its earlier notes
are in [ROADMAP.md](ROADMAP.md), [GATES.md](GATES.md) and
[WINDOWS_READINESS.md](WINDOWS_READINESS.md).

WinDock's source code is available under the [MIT license](LICENSE).
Copyright © 2026 [Ali Saad](https://github.com/aliihsaad).
Third-party dependencies and app icons keep their own licenses and trademarks.
