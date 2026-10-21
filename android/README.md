# WinDock for Android

A native Kotlin app for a WinDock host on macOS or Windows. It keeps a list of
paired computers, finds them on the network (Bonjour and UDP broadcast), pairs
natively (security code, then PIN, or a QR code scanned with the system
camera), pins each computer's certificate, and opens the shared landscape dock
from the computer in a fullscreen WebView.

It has run on a real phone (Samsung Galaxy A40) against a macOS host. There is
no store or download build. How to install and pair, for users:
[docs/INSTALL-PHONES.md](../docs/INSTALL-PHONES.md).

## Build and install

You need JDK 17 or 21 and the Android SDK with Platform 34 and Build Tools
34.0.0 (Android Studio installs both). Set `ANDROID_HOME`, or `sdk.dir` in
`android/local.properties`.

On macOS or Linux:

```sh
cd android && bash gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

On Windows, run `npm run build:android` from the repository root. The script
finds Android Studio's JDK and the usual SDK folder (`JAVA_HOME` and
`ANDROID_HOME` override them), runs the Kotlin unit tests and lint, checks the
signature, and writes `artifacts/WinDock-android-debug.apk`.

The app supports Android 7/API 24 and newer, targets API 34, and is signed with
the build machine's debug key. Updating over an existing install needs the same
key; an APK from another machine means uninstalling first and pairing again.
The version is still `0.2.2-preview.1` (version code 4), inherited from
upstream.

Without adb, copy the APK to the phone, open it, and allow installs from that
app when Android asks.

## Using it

- The **Computers** screen lists paired computers and computers found on this
  network. Its rail has **Scan QR code**, **Add by address**, **Connect by USB**
  (Windows only) and **This phone**.
- **Scan QR code** opens a sheet that hands off to the system camera (no camera
  permission in the app). The `windock://pair` link opens WinDock, which shows
  a confirmation screen before any network traffic.
- Pairing by hand: check the security code against the computer, then type the
  6-digit PIN.
- In the dock, **Back** opens the switch sheet. The drawer also has **Switch**.
- If a computer's address changes, the app finds it again by host ID and moves
  the session over without a new PIN.
- Android's first fullscreen prompt needs one tap on **Got it**. System-edge
  swipes can briefly reveal the navigation bars.

## USB connection (Windows host only)

The app can reach a Windows host through **USB tethering**. USB debugging is
not needed, but a charging-only cable won't work.

1. Connect the phone to the PC with a USB data cable.
2. Turn on **USB tethering** in Android settings (often under Hotspot &
   tethering).
3. Keep WinDock running on Windows. On the Computers screen, choose **Connect by
   USB → Find computer over USB**.
4. Pair as usual. If discovery is blocked, add the PC by its address on the USB
   network adapter, not its Wi-Fi address.

Allow WinDock through Windows Firewall on the USB network when asked. Tethering
can share the phone's mobile data with the PC; turn mobile data off if you
don't want that. Some phones or carriers restrict USB tethering. USB mode only
searches wired interfaces and never falls back to Wi-Fi on its own. On startup,
if the cable is gone, the app returns to Wi-Fi.

Discovery binds probes to each local interface and uses the responder's source
address, so a PC with several network adapters can't send the phone a stale
address. Upstream verified USB discovery, pairing and app control on a Huawei
Mate 10 Pro with Wi-Fi off (October 19, 2026). It has not been re-run since
the fork.

## This phone: display options

Open **This phone** on the Computers screen, or **Appearance → This phone ·
screen** in the dock. These settings stay on the phone and never change the
computer.

- **Dim after inactivity:** never, 15 seconds, 30 seconds (default), 1 or 2 minutes.
- **Dim brightness:** 5%, 10% (default) or 20%; never raises a brightness that is
  already lower.

The screen stays on the whole time WinDock is open (Computers screen, pairing
and dock); dimming only lowers this window's brightness. No device-admin,
accessibility service or system-settings permission is used. The first tap on a
dimmed dock only wakes it. Leaving the app restores brightness and lets the
screen turn off normally. Live updates from the computer don't reset the idle
timer. Dimming reduces long display exposure but can't guarantee there will be
no OLED burn-in.

## Verification

`npm run build:android` includes Kotlin unit tests, lint and signature validation.
`npm test` includes the cross-language protocol check. The Kotlin tests execute
the real URL/discovery parser and same-origin request policy.

For the emulator flow, start `node scripts/android-smoke-host.mjs` in another
terminal. It listens only on loopback port 18622 and provides five fake apps,
test PIN 864200, and an action log in `artifacts/android-smoke/events.json`.
It never calls a Windows provider or reads the user's saved dock.

With an Android emulator running, use the SDK's adb (specify `-s SERIAL` if
more than one device is attached):

```powershell
cd android
.\gradlew.bat assembleDebug assembleDebugAndroidTest
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb install -r app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk
adb shell am instrument -w -e class com.windock.app.DockSmokeTest com.windock.app.test/androidx.test.runner.AndroidJUnitRunner
```

Expected: `OK (1 test)`. The test targets the emulator's host alias
`http://10.0.2.2:18622`; do not run this fixture test against a physical phone.
It verifies pairing errors/success, WebSocket sync, icon-only landscape layout,
two pages, real injected touch swipes, long press, dialog Back handling,
launch/focus requests, failed manual address recovery and Activity recreation.
Screenshots are in the app's external files directory. The first-run Android
fullscreen explanation is dismissed using UI Automator on the English emulator.

The emulator flow has passed on API 36.1 and API 37. It does not show physical
LAN discovery or real app activation on a computer. Real-device results are
recorded in [docs/V1-PLAN.md](../docs/V1-PLAN.md).

### USB discovery and idle display regression

The Kotlin unit suite also checks actual UDP request/reply exchange, rejects
malformed replies, corrects stale advertised addresses, and verifies USB-only
selection and idle deadlines. It does not emulate a physical USB cable.

With the smoke host above running, install the app and instrumentation APKs,
then run on the emulator:

```powershell
adb -s emulator-5554 shell am instrument -w -e class com.windock.app.PhoneOptionsTest com.windock.app.test/androidx.test.runner.AndroidJUnitRunner
```

The two tests cover native settings through the WebView bridge, saved preferences
after Activity recreation, timed dimming, consumption of the first wake gesture,
keep-awake on both the dock and connection screens, its release when the app is
paused, and remembered USB mode with a return to LAN.
The JVM tests separately verify that USB mode refuses remembered Wi-Fi hosts;
recent emulators also expose a virtual Ethernet link on their Wi-Fi subnet.

For each additional physical device, verify discovery, PIN pairing, and
an app action through USB tethering with the phone's Wi-Fi disabled.

### Automatic now-playing regression

Start `node scripts/now-playing-smoke-host.mjs` from the repository root. It runs
an isolated host on loopback port 18623 and a test-only media control endpoint
on 18624. Keep other clients disconnected from this fixture during the Android
test so its background polling count is isolated. After building/installing the
debug and instrumentation APKs as above, run:

```powershell
adb shell am instrument -w -e class com.windock.app.NowPlayingSmokeTest com.windock.app.test/androidx.test.runner.AndroidJUnitRunner
```

Expected: `OK (1 test)`. The test changes the host's simulated track, artist,
playback state and active media session, checks the actual Android WebView updates
without tapping Refresh, and checks polling pauses in the background and resumes
on return. It uses the emulator host alias `10.0.2.2`; do not run on a physical phone.

The same fixture supports a browser regression. Open `http://127.0.0.1:18623` in
Playwright CLI, then run `run-code --filename=scripts/browser/now-playing.js`
from the repository root. It also checks HTTP error recovery, slow requests,
playback controls, focus preservation and zero Refresh clicks/page reloads.
Create `output/playwright/` first for the screenshot. `npm test` includes the
poller's automatic-update, inactive-state, timeout and concurrency regression.

## Transport and build decisions

Android's network security XML matches domains, not private IP subnets. The
transport allows HTTP, while `EndpointPolicy` limits selected hosts to private
or loopback IPv4 addresses (plus localhost). Health checks reject redirects,
limit response size/time and require WinDock's identity. The WebView permits
only the selected origin, disables file/content access, and keeps PIN/session
handling in the shared web UI.

Hosts whose `/health` reports `tls` are opened over HTTPS on the same port.
The app makes one https `/health` request with a per-connection trust manager
that records the certificate presented in the handshake (the `/health` `tls`
field is only a hint). The first time, it shows that certificate's security
code (`XXXX-XXXX-XXXX`) to compare with the host; "Codes match" pins
`hostId -> SHA-256 fingerprint` in `PinStore`. Later connections must present
the pinned certificate exactly, otherwise "Security code changed" appears and
the app never falls back to http. The WebView proceeds past the self-signed
certificate error only for the selected https origin presenting the pinned
fingerprint; no process-wide trust is changed. Hosts without `tls` keep the
old LAN HTTP behaviour. The smoke fixture serves HTTPS too, so `DockSmokeTest`
accepts the security code dialog before pairing; set `ANDROID_SMOKE_PORT` and
`-Pandroid.testInstrumentationRunnerArguments.smokePort` together if 18622 is taken.

Reference documentation: [Android network security](https://developer.android.com/privacy-and-security/security-config),
[immersive system bars](https://developer.android.com/develop/ui/views/layout/immersive),
[AGP 8.5 compatibility](https://developer.android.com/build/releases/agp-8-5-0-release-notes),
and [Gradle wrapper checksums](https://docs.gradle.org/current/userguide/gradle_wrapper.html).
