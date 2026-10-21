# Run WinDock on a Mac

The WinDock host runs on macOS from a checkout of this repository, with Node.js.
You build the WinDock menu-bar app from the same checkout (recommended), or run
the host in a terminal, or as a LaunchAgent that starts with your Mac. There is
no signed, downloadable Mac app yet.

## What works on a Mac (V1)

| Feature | macOS host |
| --- | --- |
| Installed-app catalog and icons | Yes (apps in `/Applications`, `~/Applications` and system apps) |
| Launch, focus and quit apps | Yes (quit asks the app politely, so it can offer to save) |
| Pinned dock shared by every paired phone | Yes |
| Media, volume and brightness controls, now playing | No |
| Lock, sleep, restart, shut down | No |
| Screenshot and screen recording | No |
| Touchpad, keyboard and signature | No |

The phone hides the features a Mac host does not have.

## Requirements

- macOS with **Node.js 20 or newer** (`node --version`). Install it from
  [nodejs.org](https://nodejs.org), Homebrew (`brew install node`) or nvm.
- The Mac and the phone on the **same Wi-Fi network**.
- For the menu-bar app: Xcode 15 or newer and XcodeGen (`brew install xcodegen`),
  macOS 13 or newer.

## Install

```sh
git clone https://github.com/aliihsaad/WinDock.git
cd WinDock
npm ci
```

Then choose how to run the host.

### Option A: the WinDock menu-bar app (recommended)

```sh
npm run mac:app
```

This builds `macos/build/WinDock.app` from this checkout (it runs
`macos/build.sh`: XcodeGen, then a Release build signed ad hoc, so no Apple
developer account is needed). Move `WinDock.app` to `/Applications`, or run it
from `macos/build`. Keep the checkout where it is: the app runs `server.js` from
the folder it was built in.

**First launch.** Open `WinDock.app`. It has no Dock icon: look for the
four-square icon in the menu bar. Click it to open WinDock (pairing, paired
phones, settings); right-click it for Open WinDock, Pair a new phone… and Quit
WinDock. The app starts the host itself (`node server.js`, with the PIN kept out
of the log) and stops it when you quit.

- If macOS says the app **can't be opened** or is from an unidentified
  developer, Control-click `WinDock.app`, choose **Open**, then **Open** again (or
  allow it in **System Settings → Privacy & Security**). This is because the
  app is signed ad hoc, not notarized.
- If macOS asks whether **WinDock may access files in your Documents folder**,
  click **Allow**: the app runs the checkout from there. macOS asks again after
  each rebuild. To avoid that, keep the checkout outside `Documents`, `Desktop`
  and `Downloads` (for example `~/WinDock`) and rebuild.
- If macOS asks whether **node** may accept incoming connections, click
  **Allow** (see "Allow incoming connections" below).
- If Node.js isn't found, WinDock says so and offers **Get Node.js**. The app
  looks in `/opt/homebrew/bin`, `/usr/local/bin`, then your login shell's
  `PATH`.

**Start at login.** In WinDock, under This computer, turn on **Start at login**.
This adds WinDock to **System Settings → General → Login Items**; if macOS asks
you to approve it there, WinDock shows **Open Login Items**.

**Logs.** The host's output goes to `~/Library/Logs/WinDock/host.log` (rotated
at 1 MB, three files kept). ⋯ → Open logs folder shows it.

**The app and the LaunchAgent (Option C).** Use one or the other. If a WinDock
host is already running on the port when the app starts (started with
`npm start` or by `npm run mac:install`), the app attaches to it instead of
starting a second one: the page works, but the app can't restart or stop that
host, and Quit only quits the app. To let the app own the host, remove the
LaunchAgent and restart the app:

```sh
npm run mac:uninstall
```

Settings for testing (all optional; quit and reopen the app after changing):

```sh
defaults write dev.gerikotori.windock.menu port -int 8621        # another port
defaults write dev.gerikotori.windock.menu nodePath /path/to/node
defaults write dev.gerikotori.windock.menu repoPath /path/to/WinDock
defaults write dev.gerikotori.windock.menu hostEnvironment -dict WINDOCK_CONFIG /tmp/wd/config.json
defaults delete dev.gerikotori.windock.menu                      # back to the defaults
```

`hostEnvironment` passes `WINDOCK_*` variables to a host the app starts, for
example a temporary data folder. The app is not sandboxed, because it runs
Node and reads this checkout.

### Option B: run it in a terminal

```sh
npm start
```

The host prints its address and PIN. It stops when you close the terminal or
press Ctrl+C.

### Option C: start it automatically at login (LaunchAgent)

```sh
npm run mac:install
```

Prefer the menu-bar app (Option A) unless you want the host without a menu-bar
icon. This installs a per-user LaunchAgent (`dev.windock.host`), starts the host now,
and prints the address and PIN once the host answers. From then on the host
starts every time you log in, and launchd restarts it if it crashes.

Stop any `npm start` copy first: both use port 8620, and the installer refuses
to continue while the port is taken.

The login item runs this checkout with the exact Node binary that ran
`npm run mac:install`. **Run `npm run mac:install` again** after you:

- upgrade or switch Node (nvm, Homebrew or the nodejs.org installer can move or
  remove the old binary);
- move or rename the repository folder;
- update the checkout (`git pull`), so the host restarts on the new code.

Reinstalling replaces the old login item; it does not create a second one.

| Command | What it does |
| --- | --- |
| `npm run mac:install` | Install or reinstall the login item and start the host |
| `npm run mac:status` | Show whether the login item is loaded and the host is healthy |
| `npm run mac:uninstall` | Stop the host and remove the login item |
| `npm run info` | Show the address and PIN of the running host, and open pairing for 10 minutes |
| `npm run devices` | List paired phones; `-- revoke <id>` or `-- revoke-all` to unpair them |

## Pair your phone

The easiest way: open **<http://127.0.0.1:8620/host>** in a browser on the Mac
(Safari, Chrome or any other), or click the WinDock icon in the menu bar if you
use the app (Option A). This page is WinDock's control panel: it shows whether the host is running, a QR code and
PIN for pairing, your paired phones (rename or remove them there), and whether
phones can find the Mac. Opening it with no phones paired opens pairing
straight away; otherwise click **Pair a new phone**. Pairing stays open for 10
minutes, and **Stop pairing** closes it and retires the code on screen.

In WinDock on the phone, tap **Scan QR code**, or point the phone's camera at
the code. You can also type the address and PIN shown under the code.

The page works only on the Mac itself (on another device the address answers
"not found"), and only at `127.0.0.1` or `localhost`. If you run the host on
another port, use that port in the address.

From a terminal instead:

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

Open WinDock on your phone, pick your Mac (Android can find it automatically) or
type the address, then enter the 6-digit PIN within 10 minutes. With HTTPS on
(the default), `npm run info` also prints the pairing QR code in the terminal.

`npm run info` works only on the Mac itself. The login item never writes the PIN
to its log file, so this command is how you see it. Pairing is open for 10
minutes after the host starts and for 10 minutes after each `npm run info`;
outside that window the phone says pairing is closed, and running
`npm run info` again reopens it. Each PIN pairs one phone: after a phone pairs,
run `npm run info` again for the next PIN. The PIN also changes when the host
restarts, but phones that are already paired stay paired.

## See and remove paired phones

The control page at <http://127.0.0.1:8620/host> lists paired phones, shows
which are connected now, and lets you rename a phone (the name is only used on
this Mac) or remove it. From a terminal:

```sh
npm run devices
```

```
2 paired devices (newest first)
  iPhone         3f2a9c01  paired 2026-10-20 14:03  last seen 2026-10-20 15:10
  Android phone  9b17e2d4  paired 2026-10-18 09:41  last seen 2026-10-20 08:02
Revoke one with: npm run devices -- revoke <id>
```

`npm run devices -- revoke 3f2a9c01` unpairs one phone (the short id is
enough); `npm run devices -- revoke-all` unpairs every phone. A revoked phone is
disconnected immediately and has to pair again with a new PIN.

## Allow incoming connections

The first time the host runs, macOS may ask whether **node** may accept incoming
network connections. Click **Allow**; otherwise the phone cannot reach the Mac.

If you clicked Don't Allow, or the phone cannot connect while the firewall is
on, open **System Settings → Network → Firewall → Options**, find **node** and
set it to allow incoming connections. Each Node binary is a separate entry,
so you may be asked again after switching Node versions.

## Where WinDock keeps its files

| What | Where |
| --- | --- |
| Pinned dock, paired devices, host ID | `~/Library/Application Support/WinDock/` (`config.json`, `sessions.json`, `host.json`) |
| Login item | `~/Library/LaunchAgents/dev.windock.host.plist` |
| Host log (menu-bar app or LaunchAgent) | `~/Library/Logs/WinDock/host.log` |
| Menu-bar app settings | `defaults read dev.gerikotori.windock.menu` |

Paired devices are stored as hashes of their session tokens, never the tokens
themselves.

## Uninstall

Menu-bar app: turn off **Start at login** in WinDock, quit it, and delete
`WinDock.app`. LaunchAgent:

```sh
npm run mac:uninstall
```

This stops the host and removes the login item. It keeps your dock, paired
devices and log. To remove those too, delete
`~/Library/Application Support/WinDock` and `~/Library/Logs/WinDock`, then
delete the repository folder.

## Troubleshooting

**The phone can't find the Mac.**
- Check that both devices are on the same Wi-Fi network, not a guest network.
  Guest networks, hotel and office Wi-Fi, and routers with "client isolation"
  or "AP isolation" stop devices from reaching each other.
- The Mac announces itself on the network with Bonjour, and answers
  Android's discovery probe. Some networks block both. Type the address from
  `npm run info` instead.
- On an iPhone, WinDock needs **Local Network** access to find and reach the
  Mac. If you declined it, turn it on in **Settings → Privacy & Security →
  Local Network → WinDock** (or **Settings → WinDock**).
- To check that the Mac is announcing itself, run
  `dns-sd -B _windock._tcp local` on the Mac (press Ctrl+C to stop). It should
  list your Mac's name. If it does not, the host is not running, or it was
  started with `WINDOCK_BONJOUR=0`.
- Check that the host is running: `npm run mac:status`, or `npm run info`.
- Check the firewall setting above.

**The phone was paired but now can't connect.**
The Mac's address may have changed, for example after a router restart or on a
different network. Run `npm run info` and enter the new address on the phone.
You may need to pair again with the PIN. To keep the address stable, reserve
an IP address for the Mac in your router's settings.

**`npm run info` says WinDock isn't running.**
Start it with `npm start`, or check the login item with `npm run mac:status`.
If it is installed but not healthy, read `~/Library/Logs/WinDock/host.log`. If
you run the host on another port, use `PORT=<port> npm run info`.

**The log shows `EADDRINUSE`.**
Another program, often an `npm start` copy, is using port 8620. Stop it.

**The log shows `Operation not permitted`, or the login item never answers.**
macOS can block background programs from reading `Documents`, `Desktop` and
`Downloads`. Move the checkout to another folder (for example `~/WinDock`) and
run `npm run mac:install` again. Or allow **node** in **System Settings →
Privacy & Security → Files and Folders**.

**The login item stopped after a Node upgrade.**
Run `npm run mac:install` again so it points at the current Node binary.

## Security notes

- Anyone on the network who learns the current 6-digit PIN while pairing is
  open can pair. Each PIN works once, pairing closes 10 minutes after it was
  last opened, and after 10 wrong PINs the PIN changes and pairing closes until
  you run `npm run info`. Use WinDock only on networks you trust, never forward
  port 8620 to the internet, and check `npm run devices` for phones you don't
  recognise.
- Software on the Mac itself is trusted without pairing, but only when it
  connects to `127.0.0.1`, `localhost` or `[::1]`. Websites open in a browser on
  the Mac cannot use this trust: the host refuses any request a browser marks
  as coming from another site, so a web page can't reopen pairing or read the
  control page.
