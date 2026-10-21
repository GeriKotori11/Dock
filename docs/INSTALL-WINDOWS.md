# Run WinDock on Windows

> **Not yet tested on Windows.** The Windows host worked upstream, before this
> fork. Everything below was written from the code and has not been run on a
> Windows PC since. These parts were changed in the fork and are compile-checked
> or covered by mocked tests only:
>
> - the tray's WebView2 flyout and window (the `/host` control page), its new
>   menu, log rotation and offline page;
> - the built-in Bonjour responder that lets iPhones find the PC;
> - HTTPS with a pinned certificate, 6-digit single-use PINs and the 10-minute
>   pairing window;
> - the installer changes: the finish-page text and removing the login item on
>   uninstall.
>
> If something here doesn't match what you see, trust what you see and note it
> in [V1-PLAN.md](V1-PLAN.md).

The WinDock host runs on Windows 10 (1809 or newer) or Windows 11, x64. You
build it from a checkout of this repository. There is no download.

## What works on Windows

Everything the macOS host does (app catalog with icons, launch, focus, quit,
one shared dock for every paired phone), plus:

- media, volume and brightness controls, and now playing;
- lock, sleep, restart and shut down;
- screenshots and screen recordings of the main monitor, saved to
  `Pictures\WinDock` and `Videos\WinDock`;
- touchpad, keyboard and signature (signatures go to `Pictures\WinDock\Signatures`);
- USB tethering from an Android phone.

## Requirements

- **Node.js 20 or newer** (`node --version`), from [nodejs.org](https://nodejs.org).
- **.NET SDK 8** (`dotnet --version`), from
  [dot.net](https://dotnet.microsoft.com/download/dotnet/8.0). It builds the
  helper and the tray app.
- **Microsoft Edge WebView2 Runtime** for the tray's window. Windows 11 has it,
  and most Windows 10 PCs get it with Edge. Without it, the tray opens the same
  page in your browser instead.
- Optional: **Inno Setup 7**, only to build the installer.
- The PC and the phone on the **same Wi-Fi or wired network**.

## Build

In PowerShell:

```powershell
git clone https://github.com/GeriKotori11/Dock.git
cd Dock
npm ci
npm run build:windows
```

This builds `WinDockHelper.exe` and `WinDockTray.exe`, and packages them with
the host, the web UI and a copy of your `node.exe` into
`artifacts\WinDock-win-x64`. It ends with `WINDOWS BUILD OK`. It also copies
`WinDockHelper.exe` to the repository root so that `npm start` works.

## Run

Choose one.

### Option A: the tray app (recommended)

```powershell
.\artifacts\WinDock-win-x64\WinDockTray.exe
```

The tray app starts the host, puts the WinDock icon in the taskbar tray (by the
clock, possibly under the ^ arrow) and stops the host when you quit. The
packaged folder runs on its own: you can move it anywhere.

- Click the icon to open WinDock: status, pairing, paired phones and settings.
- Right-click it for **Open WinDock**, **Pair a new phone**, **Open saved files**,
  **Check for updates…** and **Quit WinDock**.
- To start WinDock when you sign in, turn on **Start when I sign in** under
  This computer.

**Check for updates** looks at upstream WinDock's releases, not this fork.
Ignore what it offers: an upstream installer would replace this build.

### Option B: run it in a terminal

```powershell
npm start
```

The host prints its address and PIN, and stops when you press Ctrl+C or close
the window. Run `npm run build:windows` once first, because the host needs
`WinDockHelper.exe`.

### Option C: build an installer

```powershell
npm run build:installer
```

Run `npm run build:windows` first. This needs Inno Setup 7 in its default
folder (or `ISCC.exe` on `PATH`) and writes `artifacts\installer\WinDockSetup.exe`.
The installer:

- installs for the current user only, to `%LOCALAPPDATA%\Programs\WinDock`, with
  no administrator prompt;
- adds WinDock to the Start menu, and optionally to the desktop and to sign-in;
- includes its own Node.js, so the PC doesn't need Node installed;
- is unsigned, so Windows SmartScreen may warn about it. Choose **More info**,
  then **Run anyway**.

To upgrade, quit WinDock from the tray and run the new installer. Your dock and
paired phones are kept.

`npm run test:installer` checks install, launch, upgrade and uninstall in an
isolated folder.

## Allow incoming connections

The first time the host runs, Windows Defender Firewall may ask whether
**Node.js JavaScript Runtime** (`node.exe`) may communicate on networks. Allow
it on **Private networks**, and make sure your home network is set to Private
in **Settings → Network & internet**. Otherwise phones can't reach the PC.

If you dismissed the prompt, open **Windows Security → Firewall & network
protection → Allow an app through firewall**, find **Node.js JavaScript
Runtime** and tick **Private**. The tray's packaged `node.exe` and the one used
by `npm start` can be separate entries.

## Pair your phone

1. Click the WinDock icon in the tray, or right-click it and choose **Pair a new
   phone**. On first run, with no phones paired, pairing opens by itself.
2. In WinDock on the phone, tap **Scan QR code** and point it at the code. Or
   add the computer by the address under the code, then compare the security
   code and type the 6-digit PIN.

Pairing stays open for 10 minutes. **Stop pairing** closes it and retires the
PIN on screen. Each PIN pairs one phone; a new one appears after each pairing.

Without the tray, open <http://127.0.0.1:8620/host> in a browser on the PC, or
run `npm run info` in the repository folder. Both work only on the PC itself.

To see or remove paired phones, use **Paired phones** on the same page, or:

```powershell
npm run devices
npm run devices -- revoke <id>
```

## Spotify setup (optional)

Playlists, Liked Songs, search, the queue and choosing which device plays come
from Spotify's Web API, which needs your own Spotify developer app. The sign-in
happens on the PC and stays there: the phone never sees your password or a
token.

1. Open <https://developer.spotify.com/dashboard>, log in, and create an app
   (any name; tick **Web API**).
2. Under **Redirect URIs** add exactly `http://127.0.0.1:8620/api/spotify/callback`.
   It must be `127.0.0.1`, not `localhost`. If you run the host on another port,
   add that port's URI too (the WinDock page shows the exact one to copy).
3. In **User Management** add the Spotify account you will connect (a new app
   in Development Mode allows up to 5 listed users, and the app's owner needs
   Premium).
4. Copy the app's **Client ID** (32 characters) and paste it into the Spotify row
   on the WinDock page on this PC, then choose **Connect**. A browser window
   opens on the PC; log in and allow WinDock. "Connected. You can close this
   tab." means it worked.

Playing from your library, adding to the queue and switching devices need
Spotify Premium. The sign-in is encrypted for your Windows user (DPAPI) in
`%APPDATA%\windock\spotify-tokens.dpapi`; **Disconnect** on the WinDock page
deletes it and keeps the Client ID.

## Where WinDock keeps its files

| What | Where |
| --- | --- |
| Pinned dock, paired phones, host ID, certificate | `%APPDATA%\windock\` (`config.json`, `sessions.json`, `host.json`, `tls-cert.pem`, `tls-key.pem`) |
| Host log (tray app) | `%LOCALAPPDATA%\WinDock\Logs\host.log`, rotated at 1 MB, three files kept |
| Tray window data | `%LOCALAPPDATA%\WinDock\WebView2\` |
| Screenshots, recordings, signatures | `Pictures\WinDock`, `Videos\WinDock`, `Pictures\WinDock\Signatures` |
| Start at sign-in | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `WinDock` |

**Open logs folder** in the tray window's ⋯ menu opens the log folder.

## Uninstall

- **Installed with the installer:** quit WinDock from the tray, then open
  **Settings → Apps → Installed apps → WinDock → Uninstall**. This also removes
  the sign-in entry.
- **Run from the build folder:** turn off **Start when I sign in**, quit WinDock,
  and delete `artifacts\WinDock-win-x64`.

Both keep your dock, paired phones and captures. To remove those too, delete
`%APPDATA%\windock` and `%LOCALAPPDATA%\WinDock`.

## Troubleshooting

**The phone can't find the PC.**
- Check that both are on the same network, not a guest network. Some routers
  keep devices apart ("client isolation" or "AP isolation").
- Check the firewall setting above, and that the network is set to Private.
- Add the computer by address on the phone. The address is on the WinDock page
  and in `npm run info`.

**The tray icon doesn't appear, or WinDock stops right away.**
Read `%LOCALAPPDATA%\WinDock\Logs\host.log`. `EADDRINUSE` means another program,
often an `npm start` copy, is using port 8620. Stop it and start WinDock again.

**Clicking the icon opens a browser instead of a window.**
The WebView2 Runtime is missing. Install it from
[Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/), then
restart WinDock.

**The phone says "Pairing is closed".**
Choose **Pair a new phone** in the tray. That opens pairing for 10 minutes.

**An app doesn't come to the front.**
Windows sometimes refuses to bring another app forward. Click it on the PC once,
or try again.

## Security notes

- Anyone on the network who learns the current PIN while pairing is open can
  pair. Each PIN works once, and 10 wrong PINs change it and close pairing. Use
  WinDock only on networks you trust, never forward port 8620 to the internet,
  and check **Paired phones** for phones you don't recognise.
- Programs on the PC itself can use the host without pairing, but only through
  `127.0.0.1`, `localhost` or `[::1]`. Websites open in a browser on the PC
  can't use this.
