# Run WinDock on a Mac

The WinDock host runs on macOS from a checkout of this repository. There is no
packaged Mac app yet: you run it with Node.js, either in a terminal or as a login
item that starts with your Mac.

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

## Install

```sh
git clone https://github.com/aliihsaad/WinDock.git
cd WinDock
npm ci
```

Then choose how to run the host.

### Option A: run it in a terminal

```sh
npm start
```

The host prints its address and PIN. It stops when you close the terminal or
press Ctrl+C.

### Option B: start it automatically at login

```sh
npm run mac:install
```

This installs a per-user LaunchAgent (`dev.windock.host`), starts the host now,
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
| `npm run info` | Show the address and PIN of the running host |

## Pair your phone

```sh
npm run info
```

```
WinDock is running on Anns-MacBook-Air.local
  Address: http://192.168.1.20:8620
  PIN:     0427
Enter this address and PIN in the WinDock app on your phone.
```

Open WinDock on your phone, pick your Mac (Android can find it automatically) or
type the address, then enter the PIN.

`npm run info` works only on the Mac itself. The login item never writes the PIN
to its log file, so this command is how you see it. The PIN changes each time
the host restarts, but phones that are already paired stay paired.

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
| Host log (login item only) | `~/Library/Logs/WinDock/host.log` |

Paired devices are stored as hashes of their session tokens, never the tokens
themselves.

## Uninstall

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
- Automatic discovery is Android-only and some networks block it. Type the
  address from `npm run info` instead.
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

- Anyone on the network who learns the 4-digit PIN can pair. Use WinDock only
  on networks you trust, and never forward port 8620 to the internet.
- Software on the Mac itself is trusted without pairing, but only when it
  connects to `127.0.0.1`, `localhost` or `[::1]`. Websites open in a browser on
  the Mac cannot use this trust.
