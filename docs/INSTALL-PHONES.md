# Install WinDock on your phone

WinDock has an Android app and an iPhone app. You build both from this
repository; there are no store or download builds. Set up the computer first
([macOS](INSTALL-MACOS.md) or [Windows](INSTALL-WINDOWS.md)), so you have
something to pair with.

Both apps show the same dock, which the computer serves. They keep a list of
computers, find them on the network, pair with them, and keep the screen on
while WinDock is open.

## Android

Android 7.0 or newer. Tested on a Samsung Galaxy A40.

### Build

You need **JDK 17 or 21** and the **Android SDK** with Platform 34 and Build
Tools 34.0.0. Android Studio installs both. Tell Gradle where the SDK is with
`ANDROID_HOME`, or with `sdk.dir` in `android/local.properties`.

On a Mac with Android Studio:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd android && bash gradlew assembleDebug
```

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`.

On Windows, `npm run build:android` from the repository root finds Android
Studio's JDK and SDK, runs the tests and lint, and writes
`artifacts\WinDock-android-debug.apk`. See [android/README.md](../android/README.md).

### Install

With USB debugging on (Settings → About phone → tap **Build number** seven
times, then Settings → Developer options → **USB debugging**), connect the phone
and approve the computer on the phone. Then, from the repository root:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`adb` is in the SDK's `platform-tools` folder.

Without a cable, copy the APK to the phone and open it. Android asks you to
allow installs from the app you opened it with (Files, a browser); allow it.

The APK is signed with your computer's own debug key. `-r` updates an existing
install and keeps its pairings. An APK built on a different computer has a
different key, so Android refuses to update over it: uninstall the old app
first, then pair again.

### First run

1. Open WinDock. The **Computers** screen lists computers it finds on this
   network.
2. Tap **Scan QR code**. On the computer, open WinDock and choose **Pair a new
   phone**. Android uses its own camera app: tap **Open camera**, point it at
   the code, then tap the link that appears. WinDock opens and asks before it
   pairs. If nothing appears, turn on QR scanning in the camera's settings, or
   use Google Lens.
3. Or tap the computer in the list (or **Add by address**), check that the
   security code matches the one on the computer, then type the 6-digit PIN.

Android doesn't ask for a local network permission. The phone only needs to be
on the same Wi-Fi as the computer. With a Windows computer, you can also
connect by USB tethering: **Connect by USB** on the Computers screen.

### Everyday use

- **Back** in the dock opens the switch sheet, to change computer.
- **The screen stays on** while WinDock is open, and turns off normally when you
  leave it.
- **Idle dimming:** open **This phone** on the Computers screen, or
  **Appearance → This phone · screen** in the dock. Choose when to dim (never,
  15 seconds, 30 seconds, 1 or 2 minutes) and how dim (5%, 10% or 20%). The
  first tap on a dimmed dock only wakes it. This changes only the phone, never
  the computer.

## iPhone

iOS 16 or newer. Tested on a real iPhone, signed with a free Apple ID.

### Build and install

You need a Mac with Xcode, XcodeGen (`brew install xcodegen`) and Node 20+.
Follow **Run on a real iPhone** in [ios/README.md](../ios/README.md#run-on-a-real-iphone).
In short:

1. Add your Apple ID in Xcode → Settings → Accounts. A free **Personal Team**
   works.
2. On the iPhone, trust the Mac, then turn on **Settings → Privacy & Security →
   Developer Mode** and restart.
3. Copy `ios/Local.xcconfig.example` to `ios/Local.xcconfig` and set your team
   ID in it. The file is git-ignored.
4. Generate the project, open it, pick your iPhone and press ⌘R.
5. On first launch, trust your Apple ID under **Settings → General → VPN &
   Device Management**.

With a Personal Team, the app stops opening after **7 days**. Connect the
iPhone and press ⌘R again to renew it. Pairings are kept.

### First run

1. WinDock explains why it needs the local network, then iOS asks. Allow
   **Local Network**: without it, WinDock can't find or reach any computer.
2. The **Computers** screen lists computers it finds on this network.
3. Tap **Scan QR code**. On the computer, open WinDock and choose **Pair a new
   phone**. Allow the camera when iOS asks, and point it at the code. WinDock
   asks before it pairs. You can also scan the code with the Camera app.
4. Or tap the computer in the list (or **Add by address**), check the security
   code, then type the 6-digit PIN.

The screen stays on while WinDock is open. To change computer, open the drawer
in the dock and choose **Switch**.

## Troubleshooting

**No computers in the list.**
- Check that WinDock is running on the computer and that both devices are on the
  same Wi-Fi. Guest networks often keep devices from seeing each other.
- On iPhone, check **Settings → Privacy & Security → Local Network → WinDock**.
- Add the computer by address, for example `192.168.1.20:8620`. The address is
  on the computer's WinDock page.

**"Pairing is closed on {computer}".**
On the computer, choose **Pair a new phone**. The phone continues by itself.

**"That PIN didn't work".**
Each PIN works once. Use the PIN on the computer's screen now.

**"{computer} has a new security code".**
That's expected if WinDock was reinstalled or reset on the computer. Compare the
code with the computer's screen; if it matches, choose **Forget and pair again**.
If you didn't reset anything, don't continue.

**The iPhone app won't open.**
The 7-day Personal Team signature has expired. Press ⌘R in Xcode again.

**Android refuses to install the update.**
The APK was signed with a different debug key. Uninstall WinDock, install the
new APK and pair again.
