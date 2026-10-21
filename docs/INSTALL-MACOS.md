# Run WinDock on a Mac

The WinDock host runs on macOS from a checkout of this repository, with Node.js.
The recommended way is the WinDock menu-bar app, which you build from the same
checkout. You can also run the host in Terminal, or as a LaunchAgent. There is
no signed, downloadable Mac app.

macOS + Android and macOS + iPhone have both been tested on real devices.

## What works on a Mac

| Feature | macOS host |
| --- | --- |
| Installed-app catalog and icons | Yes (apps in `/Applications`, `~/Applications` and system apps) |
| Launch, focus and quit apps | Yes (quit asks the app politely, so it can offer to save) |
| Pinned dock shared by every paired phone | Yes |
| Media, volume and brightness controls, now playing | No |
| Lock, sleep, restart, shut down | No |
| Screenshot and screen recording | No |
| Touchpad, keyboard and signature | No |

The phone hides the features a Mac host doesn't have.

## Requirements

- macOS 13 or newer.
- **Node.js 20 or newer** (`node --version`), from [nodejs.org](https://nodejs.org),
  Homebrew (`brew install node`) or nvm. The menu-bar app runs the host with
  Node, so Node must stay installed.
- For the menu-bar app: Xcode 15 or newer and XcodeGen (`brew install xcodegen`).
- The Mac and the phone on the **same Wi-Fi network**.

## Get the code

```sh
git clone https://github.com/GeriKotori11/Dock.git
cd Dock
npm ci
```

Keep the checkout where it is once you've built the app: the app runs
`server.js` from the folder it was built in.

## The menu-bar app (recommended)

### Build it

```sh
npm run mac:app
```

This runs `macos/build.sh`: XcodeGen, then a Release build signed ad hoc, so no
Apple developer account is needed. The result is `macos/build/WinDock.app`.
Move it to `/Applications`, or run it from `macos/build`.

### First launch

Open `WinDock.app`. It has no Dock icon: look for the four-square icon in the
menu bar. Click it to open WinDock (pairing, paired phones, settings).
Right-click it for **Open WinDock**, **Pair a new phone…** and **Quit WinDock**.
The app starts the host itself, keeps the PIN out of the log, and stops the
host when you quit.

macOS may ask a few things the first time:

- **"WinDock can't be opened"** or **unidentified developer.** The app is signed
  ad hoc, not notarized. Control-click `WinDock.app`, choose **Open**, then
  **Open** again. Or allow it in **System Settings → Privacy & Security**.
- **"WinDock would like to access files in your Documents folder."** Click
  **Allow**: the app runs the checkout from there. macOS asks again after each
  rebuild. To stop the prompts, keep the checkout outside `Documents`, `Desktop`
  and `Downloads` (for example `~/Dock`) and rebuild.
- **"Do you want the application node to accept incoming network connections?"**
  Click **Allow**, or phones can't reach the Mac. See
  [Allow incoming connections](#allow-incoming-connections).
- **Node.js isn't found.** WinDock says so and offers **Get Node.js**. It looks
  in `/opt/homebrew/bin`, `/usr/local/bin`, then your login shell's `PATH`.

### Start at login

In WinDock, under This computer, turn on **Start at login**. This adds WinDock
to **System Settings → General → Login Items**. If macOS wants you to approve it
there, WinDock shows **Open Login Items**.

### Logs

The host's output goes to `~/Library/Logs/WinDock/host.log`, rotated at 1 MB
with three files kept. **⋯ → Open logs folder** in WinDock shows it.

### If a host is already running

If a WinDock host is already running on the port when the app starts (from
`npm start` or the LaunchAgent), the app attaches to it instead of starting a
second one. The page works, but the app can't restart or stop that host, and
Quit only quits the app. To let the app own the host, stop the other one (for
the LaunchAgent, run `npm run mac:uninstall`) and reopen the app.

### Settings for testing

All optional. Quit and reopen the app after changing them.

```sh
defaults write dev.gerikotori.windock.menu port -int 8621        # another port
defaults write dev.gerikotori.windock.menu nodePath /path/to/node
defaults write dev.gerikotori.windock.menu repoPath /path/to/Dock
defaults write dev.gerikotori.windock.menu hostEnvironment -dict WINDOCK_CONFIG /tmp/wd/config.json
defaults delete dev.gerikotori.windock.menu                      # back to the defaults
```

`hostEnvironment` passes `WINDOCK_*` variables to the host the app starts, for
example a temporary data folder. The app is not sandboxed, because it runs Node
and reads this checkout.

## Other ways to run the host

### In Terminal

```sh
npm start
```

The host prints its address and PIN. It stops when you press Ctrl+C or close
the window.

### As a LaunchAgent

```sh
npm run mac:install
```

Use this only if you want the host without a menu-bar icon, and don't use it
together with the menu-bar app. It installs a per-user LaunchAgent
(`dev.windock.host`), starts the host now and prints the address and PIN. The
host then starts every time you log in, and launchd restarts it if it crashes.
Stop any `npm start` copy first: both use port 8620.

The LaunchAgent runs this checkout with the exact Node binary that ran the
command. **Run `npm run mac:install` again** after you upgrade or switch Node,
move the repository folder, or `git pull`. Reinstalling replaces the old login
item.

| Command | What it does |
| --- | --- |
| `npm run mac:install` | Install or reinstall the LaunchAgent and start the host |
| `npm run mac:status` | Show whether the LaunchAgent is loaded and the host is healthy |
| `npm run mac:uninstall` | Stop the host and remove the LaunchAgent |

## Pair your phone

1. Click the WinDock icon in the menu bar, or right-click it and choose **Pair a
   new phone…**. With no phones paired yet, pairing opens by itself.
2. In WinDock on the phone, tap **Scan QR code**, or point the phone's camera at
   the code. You can also add the computer by the address under the code, then
   compare the security code and type the 6-digit PIN.

Pairing stays open for 10 minutes. **Stop pairing** closes it and retires the
PIN on screen. Each PIN pairs one phone; a new one appears after each pairing.
Phones that are already paired stay paired when the host restarts.

Without the menu-bar app, open <http://127.0.0.1:8620/host> in any browser on
the Mac. It's the same page. It works only on the Mac itself, at `127.0.0.1` or
`localhost`. If you use another port, change it in the address.

From Terminal instead:

```sh
npm run info
```

```
WinDock is running on Anns-MacBook-Air.local
  Address: http://192.168.1.20:8620
  PIN:     042718
  Pairing: open for 10 more minutes
Enter this address and PIN in the WinDock app on your phone.
```

`npm run info` works only on the Mac. It opens pairing for 10 minutes and, with
HTTPS on (the default), also prints the QR code. The LaunchAgent never writes
the PIN to its log, so this is how you see it there.

## See and remove paired phones

**Paired phones** on the WinDock page shows which phones are connected now, and
lets you rename one (the name is only used on this Mac) or remove it. From
Terminal:

```sh
npm run devices
```

```
2 paired devices (newest first)
  iPhone         3f2a9c01  paired 2026-10-20 14:03  last seen 2026-10-20 15:10
  Android phone  9b17e2d4  paired 2026-10-18 09:41  last seen 2026-10-20 08:02
Revoke one with: npm run devices -- revoke <id>
```

`npm run devices -- revoke 3f2a9c01` removes one phone (the short id is
enough); `npm run devices -- revoke-all` removes every phone. A removed phone is
disconnected at once and needs a new PIN to pair again.

## Allow incoming connections

The first time the host runs, macOS may ask whether **node** may accept incoming
network connections. Click **Allow**.

If you clicked Don't Allow, or phones can't connect while the firewall is on,
open **System Settings → Network → Firewall → Options**, find **node** and allow
incoming connections. Each Node binary is a separate entry, so macOS may ask
again after you switch Node versions. The WinDock page shows a banner when the
firewall blocks node.

## Where WinDock keeps its files

| What | Where |
| --- | --- |
| Pinned dock, paired phones, host ID, certificate | `~/Library/Application Support/WinDock/` (`config.json`, `sessions.json`, `host.json`, `tls-cert.pem`, `tls-key.pem`) |
| Host log (menu-bar app or LaunchAgent) | `~/Library/Logs/WinDock/host.log` |
| LaunchAgent | `~/Library/LaunchAgents/dev.windock.host.plist` |
| Menu-bar app settings | `defaults read dev.gerikotori.windock.menu` |

Paired phones are stored as hashes of their session tokens, never the tokens
themselves.

## Uninstall

- **Menu-bar app:** turn off **Start at login** in WinDock, quit it, and delete
  `WinDock.app`.
- **LaunchAgent:** run `npm run mac:uninstall`.

Both keep your dock, paired phones and log. To remove those too, delete
`~/Library/Application Support/WinDock` and `~/Library/Logs/WinDock`, then the
repository folder.

## Troubleshooting

**The phone can't find the Mac.**
- Check that both are on the same Wi-Fi, not a guest network. Guest, hotel and
  office Wi-Fi, and routers with "client isolation", keep devices apart.
- On iPhone, WinDock needs **Local Network** access. Turn it on in
  **Settings → Privacy & Security → Local Network → WinDock**.
- Check the firewall setting above.
- Add the computer by address on the phone, using the address on the WinDock
  page.
- To check that the Mac announces itself, run `dns-sd -B _windock._tcp local`
  (Ctrl+C to stop). It should list your Mac. If not, the host isn't running, or
  it was started with `WINDOCK_BONJOUR=0`.

**The phone was paired but now can't connect.**
Paired phones follow the Mac to a new address by themselves when they can find
it on the network. If they can't, add it by its new address; the pairing is
kept. To keep the address stable, reserve one for the Mac in your router.

**The WinDock page says the host stopped, or `npm run info` says WinDock isn't running.**
Read `~/Library/Logs/WinDock/host.log`. For the LaunchAgent, run
`npm run mac:status`. If you use another port, run `PORT=<port> npm run info`.

**The log shows `EADDRINUSE`.**
Another program, often an `npm start` copy, is using port 8620. Stop it.

**The log shows `Operation not permitted`, or the LaunchAgent never answers.**
macOS can block background programs from reading `Documents`, `Desktop` and
`Downloads`. Move the checkout elsewhere (for example `~/Dock`), then rebuild
the app or run `npm run mac:install` again. Or allow **node** in **System
Settings → Privacy & Security → Files and Folders**.

**The LaunchAgent stopped after a Node upgrade.**
Run `npm run mac:install` again so it uses the current Node binary.

## Security notes

- Anyone on the network who learns the current PIN while pairing is open can
  pair. Each PIN works once, pairing closes 10 minutes after it opens, and 10
  wrong PINs change the PIN and close pairing. Use WinDock only on networks you
  trust, never forward port 8620 to the internet, and check **Paired phones**
  for phones you don't recognise.
- Programs on the Mac itself can use the host without pairing, but only through
  `127.0.0.1`, `localhost` or `[::1]`. Websites open in a browser on the Mac
  can't use this: the host refuses requests a browser marks as coming from
  another site.
