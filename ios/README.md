# WinDock for iPhone

A native iOS app for a WinDock host on macOS or Windows. It keeps a list of
paired computers, finds them on the network with Bonjour, pairs natively
(security code, then PIN, or a scanned QR code), pins each computer's
certificate, and opens the shared landscape dock from the computer in a
`WKWebView`.

It has run on a real iPhone against a macOS host, signed with a free Personal
Team. It is not on the App Store or TestFlight; you build and install it from
Xcode. How to install and pair, for users: [docs/INSTALL-PHONES.md](../docs/INSTALL-PHONES.md).

## Using it

1. Run WinDock on the computer and put the iPhone on the same Wi-Fi.
2. Open WinDock on the iPhone. It explains the Local Network permission, then
   iOS asks: allow it.
3. On the computer, choose **Pair a new phone**. On the iPhone, tap **Scan QR
   code** (allow the camera when asked) and scan the code. WinDock asks before
   it pairs.
4. Or tap the computer in the **Computers** list, or **Add by address**, check
   the security code and type the 6-digit PIN.

Paired computers stay in the list. If a computer's address changes, the app
finds it again by its host ID without a new PIN. To change computer, open the
drawer in the dock and choose **Switch**. The screen stays on while WinDock is
open.

If something goes wrong, the app shows what it knows: can't reach, pairing
closed, security code changed, or Local Network turned off (with a shortcut to
**Settings → WinDock**).

## Run on a real iPhone

1. Xcode → Settings → Accounts: add your Apple ID (a free Personal Team works).
2. On the iPhone: connect it by cable, tap **Trust This Computer**, then turn on
   Settings → Privacy & Security → **Developer Mode** and restart.
3. `cp ios/Local.xcconfig.example ios/Local.xcconfig` and set `DEVELOPMENT_TEAM` to
   your team ID. The file is git-ignored, so `xcodegen generate` keeps your team.
   (You can also pick the team in Signing & Capabilities, but regenerating the
   project resets that choice.) If Xcode says the bundle ID is unavailable, set
   `WINDOCK_BUNDLE_ID` in the same file.
4. `cd ios && xcodegen generate && open WinDock.xcodeproj`, choose your iPhone in
   the device menu and press ⌘R.
5. First launch: if iOS says "Untrusted Developer", go to Settings → General →
   VPN & Device Management → your Apple ID → Trust. Allow **Local Network** when
   asked, and keep the phone on the same Wi-Fi as the computer.

With a free Personal Team the app stops opening after 7 days; press ⌘R again to
renew it. Pairings are kept.

## Build on a Mac

Requires Xcode 16.4 or later, an installed iOS Simulator, Node 20+ and XcodeGen:

```sh
npm ci
cd ios
swift scripts/generate-icon.swift
xcodegen generate
open WinDock.xcodeproj
```

`project.yml` is the source of truth; the generated Xcode project, icon PNG and
build output are git-ignored. The bundle ID is `dev.gerikotori.windock`, set in
`Signing.xcconfig`. Do not commit certificates, profiles or Apple secrets.

### Tests

For the integration tests, first run `node ios/scripts/smoke-host.mjs` from the
repository root in another terminal. Choose an iPhone simulator and run the
`WinDock` scheme's tests (⌘U). Afterwards, `node ios/scripts/verify-events.mjs`
checks that launch and focus reached the test host.

The unit tests cover the saved-computers store, connection rules, endpoint
policy, certificate pinning, the web hand-off and the `windock://pair` QR
parser. The integration tests run the real shared web UI and Node host with a
fake provider: wrong and correct PIN, cookie reuse, WebSocket sync, app
launch and focus, and blocking of foreign origins. They don't control a real
desktop.

## Build on GitHub

The workflow in [.github/workflows/build-ios.yml](../.github/workflows/build-ios.yml)
runs on a GitHub-hosted macOS runner with Xcode 16.4 and XcodeGen. Run it from
the repository's Actions tab (**Build WinDock iOS → Run workflow**); relevant
changes also start it. It needs no Apple account. Each run uploads:

- `WinDock-simulator.zip`: the app for the iOS Simulator on a Mac;
- `WinDock-unsigned-archive.zip`: an unsigned device archive, which can't be
  installed on a phone as it is;
- simulator screenshots, `.xcresult` test results, build logs and fixture events.

## Limits

- iOS 16 or newer; landscape only, iPhone and iPad.
- Addresses are private IPv4 addresses (or `localhost`); no IPv6 or host names.
  A bare address uses port 8620.
- The in-app QR scanner needs VisionKit's live scanner. On devices without it,
  the app says **Use your Camera app** instead, which opens the same
  `windock://pair` link.
- Network checks reject redirects, cap responses at 4 KiB and time out.
  Navigation is limited to the selected computer, and WebKit content rules
  block other subresources. Plain-HTTP exceptions cover private and loopback
  addresses only. Over HTTPS the app trusts only the certificate it pinned for
  that host ID, for both the page and its WebSocket; a changed certificate
  stops the connection with a warning.
- The shared dock includes touchpad, signature and the web keyboard. These are
  only useful with a Windows host and haven't been tested on an iPhone. The
  Android app's automatic keyboard bridge is not part of the iOS app.
