# Dock controls: close apps, media, Spotify, power

Status: proposal, 2026-10-21. Scope: four features inside the **shared web dock**
(`public/`), shown in the phone apps' WebView and in a phone browser:

1. Close a running app from its tile
2. Audio controls (previous / play-pause / next, volume, now playing)
3. Power actions (lock, sleep, shut down, restart)
4. Spotify: local control now (Phase A), account later (Phase B)

Plus the rule that ties them together: **everything appears only when it works on
this computer, right now.**

- Mockups: [`dock-controls-mockups.html`](dock-controls-mockups.html). Open with
  `#solo=<id>` at 844 × 390 or 932 × 430 to see one screen at its real size.
- Screenshots: [`screens/dock-*.png`](screens/) at 2x (index in section 16).
- Consistent with [`PHONE-CONNECTION-FLOW.md`](PHONE-CONNECTION-FLOW.md) (switch row,
  reconnect pill, motion and always-on rules) and
  [`HOST-CONTROL-PAGE.md`](HOST-CONTROL-PAGE.md) (host owns state, the phone shows it).
- Protocol today: [`../PROTOCOL.md`](../PROTOCOL.md). New routes in section 8.

---

## 1. Recommendation in brief

1. **Close: an × on the top-right corner of every running app tile, two taps to
   close.** The first tap arms it (the × becomes a red "Close" pill), the second
   tap within 3 s closes the app politely. No mode to enter, and no accidental
   quits from a stray tap or a page swipe that starts on the corner. Arrange keeps
   the top-left "−" for "remove from dock"; × is hidden there, so "remove" and
   "quit" are never on screen at the same time. Several windows of one app:
   the pill reads "Close all".
2. **Media: one surface, two sizes.** A **mini player** floats at the bottom of the
   dock while a player has a session (artwork, title, artist, Previous · Play/Pause
   · Next). Tapping it or swiping up on it opens the **Media sheet** (big artwork,
   progress, shuffle/repeat, volume). The drawer gets a **Media** button so the
   sheet is reachable when nothing plays. The default dock is immersive and has
   no footer, so today's footer now-playing widget is invisible for most people;
   the mini player fixes that.
3. **Spotify is not a second media UI.** It is the richest *source* of the one
   media surface. When Spotify (or Apple Music) is the active player, the same
   sheet fills more rows: album, position and seek, shuffle, repeat, "Show on
   Mac/PC". Phase B adds tabs to the same sheet (Now playing · Library · Search ·
   Devices) once an account is connected, so Phase A grows into Phase B without a
   redesign.
4. **Power lives on the drawer's computer row**: `[Studio PC · Connected | Switch]
   [Lock] [Sleep] [Shut down]`. Lock and Sleep act at once (your decision); Shut down
   opens the only confirmation, which also offers Restart. After Sleep or Shut down
   the existing "Reconnecting to …" pill names the reason ("Studio PC is asleep ·
   Wake it to reconnect") and stops pulsing, because nothing is wrong.
5. **Conditional visibility is driven by two layers**: a per-computer capability map
   in the snapshot (what this host can ever do, decides whether an entry point
   exists) and live state from `/api/media` and the snapshot (what is possible now,
   decides which buttons render). New capability keys that are missing mean
   "hidden"; the four existing booleans keep their "missing means on" rule.

---

## 2. Principles used for every call below

- **The dock is a launcher first.** New controls must not cost icon space unless
  they are live (the mini player exists only during a media session) and must
  never sit where a tap meant for an icon lands.
- **One place per job.** Media has one surface; power has one quick path (drawer)
  plus the existing pinnable tiles and Controls sheet, all with identical behaviour.
- **Hide what can't work; explain what could work with one step.** If a feature is
  impossible on this computer it is absent (no greyed-out teasers). If it needs a
  one-time permission on the computer, it shows once, with the exact step.
- **The phone never sleeps** (memory, V1 plan). No marquee titles, no endless
  pulsing for expected states, spinners stop after 60 s.
- **The computer has the last word.** Close is polite (the app may ask to save);
  shut down may be stopped by apps. Copy says so rather than promising.
- **Extend the dock's language**: glass drawer and sheets, `--accent` fills for the
  one primary control, `--danger` only for destructive confirmation, the
  reconnect pill, the toast. No new visual language.

---

## 3. What exists today (grounding)

Read from `public/*`, `server.js`, `src/platform/*` and run at 844 × 390 / 932 × 430.

| Finding | Consequence for this design |
| --- | --- |
| Immersive mode is the default (`normalizeLayout`: `immersive !== false`) and hides `.bar` and `.foot`. The now-playing widget lives in `.foot`. | Most users never see now playing. Media needs a home inside the immersive dock (mini player, 5.2). |
| Every power verb asks first (`powerActions` in `app.js`). | Change: only Shut down (and Restart, inside the same dialog) confirm. |
| `DESTRUCTIVE_VERBS` on the host includes `lock`, but `renderControls` only hides sleep/restart/shutdown when `allowDestructive` is false. Lock is shown and then fails with 403. | Treat **lock as non-destructive** on the host (8.6). |
| `/api/apps/close` exists (by pid). Windows sends `WM_CLOSE` via the helper; macOS calls `NSRunningApplication.terminate`. The UI never calls it. | Close is mostly UI + a by-app-id route that reports the outcome (8.2). |
| `running` only refreshes when the host broadcasts (after launch/close/tiles), on reconnect and on `visibilitychange`. Apps quit on the computer leave a stale dot. | Host polls running apps while a dock is connected (8.1); the UI treats "not running" on close as success. |
| `features` is computed once from the provider and is all-boolean. macOS sets `controls: false, nowPlaying: false`. | Extend the shape (section 7) and allow re-broadcast when permission changes. |
| The service worker serves the shell cache-first; a phone can run a cached UI against an upgraded host for one load, and an IP can be reused by a different computer. | New UI must cope with old hosts (missing keys hidden, legacy mapping in 7.3). |
| Running dot: 4 px `--live` under the icon. Arrange: wobble, top-left "−". Long-press 450 ms = Arrange; horizontal swipe = page; swipe up anywhere on the dock or from the bottom edge = drawer. | × goes top-right; its gestures must not start Arrange or block paging (section 9). |

---

## 4. Information architecture

| Feature | Dock (immersive) | Drawer | Sheet / dialog | Pinnable tile |
| --- | --- | --- | --- | --- |
| Close app | × on running, closable app tiles | — | — | — (it is part of the app tile) |
| Now playing + transport | **Mini player** while a session exists | **Media** button | **Media sheet** | existing Play/Pause, Next, Previous, Stop tiles (Play/Pause tile now shows the live state) |
| Volume | — | (in Media) | Media sheet volume row; Controls sheet Sound card | existing Volume up/down/mute/25/50/75 % tiles |
| Lock, Sleep | — | power group on the computer row | — (act at once) | existing Lock, Sleep tiles |
| Shut down, Restart | — | "Shut down" on the computer row | **Shut down dialog** (Cancel · Restart · Shut down) | existing Shut down and Restart tiles open the same dialog |
| Spotify (Phase A) | mini player shows Spotify artwork + source badge | (in Media) | Media sheet, rich rows | — |
| Spotify account (Phase B) | — | (in Media) | Media sheet tabs: Library, Search, Devices | — (later: "Play playlist" tiles, open question Q8) |
| Locked / asleep / off | status pill at the top (reconnect pill component) | computer row status | — | — |

Classic (non-immersive) mode: the mini player renders inline in the footer's
`#nowplaying` slot instead of floating; everything else is identical.

**Controls sheet** ("Take control") keeps Sound, Display and Your PC/Mac. Its
**Playback** card is removed: transport lives in the Media sheet. Power buttons in
"Your PC" behave exactly like the drawer's (Lock/Sleep immediate, Shut down/Restart
through the dialog). The card hint changes to "Shut down and restart ask first."

**Drawer action grid** order: Apps · **Media** · Controls · Capture · Touch & sign ·
Appearance · Arrange · Fullscreen. Fullscreen is hidden inside the native apps
(`window.WinDockNative` present: the app is already full screen) and when the
Fullscreen API is missing; it stays in Appearance. Result: at most 7 buttons in the
native apps on Windows, 5 on a Mac.

**Settings** (Your space › Layout) gains two switches, both default on:
"Close buttons on open apps" and "Now playing on the dock".

---

## 5. Screens and states

Sizes are CSS px (= pt on iOS, dp on Android). Tokens are the existing ones in
`public/style.css`; new values are listed in section 14.

### 5.1 Close button on app tiles (frames 01–04)

**Where:** an `×` badge centred 4 px outside the icon's top-right corner
(`top/right: -8px` on a 24 px badge relative to `.tile__glyph`). Arrange's "−"
stays top-left.

**Visual:** 24 px disc, fill `rgba(12,20,24,.78)` + `backdrop-filter: blur(12px)`,
1 px `#e1f0ff3a` border, shadow `0 2px 6px #0005`; glyph `close` 12 px, stroke 2.4,
`#e9f1ef`. Dark-on-anything, so it reads on white icons (Calendar, Chrome) and on
dark ones. **Hit area 44 × 44** centred on the badge (`::before { inset: -10px }`).
At 4 per page icons are ~118–140 px, at 8 per page ~80 px; the hit circle never
covers more than one corner.

**Shown when** all are true: the host offers close; the app is running; the host
marks it closable; not in Arrange; online; the setting is on (rules, section 6).

**States**

| State | Badge | Icon | Tile tap | Other |
| --- | --- | --- | --- | --- |
| Rest | × | normal, running dot | focuses the app (unchanged) | |
| Armed (after 1st tap on ×) | red pill "Close" (or "Close all"), 30 tall, `--danger` / `--on-danger`, 12/650, with a 12 px × | normal | focuses (and disarms) | Disarms after 3 s, on any other tap, on page swipe, on drawer open, on going offline. Second tap is ignored for the first 350 ms (a double-tap habit must not close). Android: `navigator.vibrate(10)` on arm. |
| Closing | spinner in the 24 px badge | opacity .45 | ignored (`aria-busy`) | Host waits up to 5 s for exit; client gives up at 8 s. |
| Closed | badge + dot fade out | back to 1 | launches (not running) | Toast "Slack closed". |
| Still open after 5 s | back to × | back to 1 | focuses | Neutral toast: "Word is still open. It may be asking to save changes on Studio PC." 5.5 s. |
| Partly closed (multi) | back to × | | | Toast: "Closed 2 of 3 Notepad windows. One may be asking to save changes on Studio PC." |
| Already gone (404) | fades out | | | Toast "Slack was already closed." (not an error) |
| Failed (5xx, not closable) | back to × | | | Error toast: "Studio PC couldn't close Slack. Try again, or close it on the computer." |

**Multiple windows/instances.** The tile stands for the app, so × closes every
instance the host lists for that app id (`running[]` entries with the same `id`).
With 2 or more, the armed pill reads **"Close all"** and the accessible name says
the count ("Close all 3 Slack windows"). The host closes each politely; the
outcome counts drive the toast.

**Not closable** (host sets `closable: false`): Windows shell (`explorer.exe` that
owns the desktop/taskbar), macOS Finder (terminate relaunches it), WinDock's own
host process and tray, and system processes. These keep the running dot, no ×.

**Running-state lag.** A tile can say "running" for a few seconds after the app
quit on the computer. Tapping × then gets 404 and is treated as success (above).
The reverse (app started on the computer, no dot yet) needs nothing: the host's
running poll (8.1) catches up within 3 s.

### 5.2 Mini player (frames 05, 06)

**Where:** floating, bottom-centre of the immersive dock, 14 px above the bottom
safe area. Width 404 (844 wide) / 440 (932 wide), `min(440px, 100% - 2 × 24px)`;
height 58; radius 19; glass (`--glass-bg`, `--glass-border`, blur
`--glass-blur`, inset highlight). While it is shown, the dock reserves 68 px at the
bottom: in `body.is-immersive.has-mini` the icon formula becomes
`calc((100dvh - 64px - 68px) * var(--icon-scale))`, and `.workspace` gets
`padding-bottom: 82px`. Page dots move up to sit 4 px above the mini player.

**Layout** (left to right, gap 10, padding 0 6 0 8):
- Artwork 42 × 42, radius 9. **Source badge** 17 × 17 radius 5 at its bottom-right
  (the source app's icon from `/api/apps/icon`), with a 1.5 px ring in the glass
  colour. No artwork: the source app's icon fills the 42 px slot instead (frame 06);
  no source app known: `music` glyph on `#ffffff0a`.
- Text block (flex 1, min-width 0): title 13/600, one line; second line 12
  `--muted`: artist, or "Paused · Chrome" when paused (word, not just the icon),
  or "on Sonos Kuzhina" in Phase B when playing elsewhere. Ellipsis; never scroll.
- Previous 44 × 44 (r14), Play/Pause 44 circle `--accent` fill / `--on-accent` glyph
  (the one primary control), Next 44 × 44.

**Behaviour:** tap artwork or text = open Media sheet. Swipe up (≥ 35 px, mostly
vertical) starting on the mini player = open Media sheet (not the drawer).
Horizontal swipes on it do nothing (no hidden skip gesture; it would fire while
people page). Transport buttons send the command and update optimistically (play
↔ pause glyph flips at once, corrected by the next poll).

**States**

| State | Shows |
| --- | --- |
| Playing | artwork, title, artist, Pause |
| Paused | same, second line "Paused · {source}" if no artist, else artist; Play |
| Session without metadata | title "Playing in {app}", second line "No track details" |
| Needs permission (macOS, player running) | compact: Spotify icon, "Allow Spotify control", button **Allow** (opens the Media sheet permission card). A small × hides it for this computer until WinDock restarts on the computer. |
| No session | hidden |
| Offline | hidden after the same 1.5 s threshold as the reconnect pill |
| Setting off | hidden (Media stays in the drawer) |

Arrange mode: unchanged and still usable (it doesn't overlap the grid).

### 5.3 Media sheet (frames 07–10)

A `<dialog class="sheet media-sheet">` like the other sheets: centred, glass,
radius 24, width `min(92vw, 720px)`, max-height 96dvh, grip at top. Opens from the
mini player, the drawer's Media button, and (Phase B) is the home for Spotify.

**Header** (min-height 56): left, the **source button** (44 tall, r12,
`#ffffff07`): source icon 24 (r7) + name 13/600 + context 12 `--muted`
("on Geri's MacBook Air", or "· 2 players" with a chevron when there are several
sessions). Right: "Show on Mac/PC" link button (focuses the player app on the
computer; only when the source is an app the host can focus) and the 44 close button.
With no source, the header reads "Media".

**Body** (two columns, gap 22, padding 6 22 0):
- Artwork 164 (188 at 932 wide), radius 14, shadow `0 14px 30px #0006`.
- Info column, min-height = artwork height:
  title 22/600 two lines max; artist 15 `--muted`; album 13 `--text-3`;
  progress row (11 px tabular times, 4 px track, `#eef3f1` fill, 14 px thumb only
  when seekable; hit height 44); **transport row anchored to the bottom of the
  column** so it never moves between sources: Shuffle 48 · Previous 48 ·
  Play/Pause 60 circle `--accent` · Next 48 · Repeat 48. Shuffle/Repeat use
  `--muted` off, `--accent` + 4 px dot when on (state never by colour alone:
  the dot plus `aria-pressed`). Repeat cycles off → all → one; "one" shows a
  small "1" in the glyph.

**Volume row** (padding 12 22 18): mute button 44 · slider (4 px track, `--accent`
fill, 20 px thumb, 44 px hit height, `touch-action: none`) · value 12 tabular
`--muted` "45%". Muted: speaker-with-× glyph, value reads "Muted", fill turns
`--muted`. This is the **system output volume**, not the player's own volume, so
there is only ever one volume slider.

**Rows the source can't fill are absent, not greyed** (frame 08 has no album,
progress, shuffle or repeat). Transport buttons the session reports as
unavailable right now (e.g. Previous at the start of a queue) stay in place,
disabled (45 % opacity), so the row never reflows.

**Source switcher** (Windows, more than one session): the source button opens a
small list (rows 56: app icon, app name, track title in `--muted`, a check on the
current one). Picking one makes the dock follow that session until it ends or
the user picks again. Single session: the button is static (no chevron).

**States**

| State | Content |
| --- | --- |
| Playing / paused | as above |
| No metadata | title "Playing in {app}", artist line "No track details", artwork = app icon |
| Nothing playing (frame 09) | dashed music glyph 120, "Nothing playing", body per platform (copy deck). Windows: **Resume last player** (primary; sends play, which Windows routes to the last session) + **Open Spotify** if installed and not running. Mac: **Open Spotify** / **Open Music** for installed players. Volume row stays. |
| Needs permission (frame 10) | card: app icon 64, "Control Spotify from your phone", two numbered steps, **Ask on Mac** (primary) + **Not now**. |
| Asking | the primary turns into "Waiting for your Mac…" with a spinner (stops after 60 s, text stays); host broadcasts when granted, then the card is replaced by the player. |
| Denied | card: "Spotify control is off on your Mac", body with the Settings path, **Open Settings on Mac** (host opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Automation`). |
| Offline | sheet stays open but greys its controls (disabled) and shows "Reconnecting to {computer}…" in place of the header context. |
| Mac with no supported player installed | header "Media", body "WinDock can control Spotify and Music on a Mac. Neither is installed on {computer}." Volume row. |

### 5.4 Spotify, Phase A: one model

There is one media surface; the **active source** decides how rich it is. Spotify
is a source like Chrome or Apple Music, with more fields.

| Field | Windows, any app (system media session) | Windows, Spotify (system session) | macOS, Spotify (AppleScript) | macOS, Music (AppleScript) | macOS, any other app |
| --- | --- | --- | --- | --- | --- |
| Title, artist, play state | ✓ | ✓ | ✓ | ✓ | — (not shown) |
| Album | if provided | ✓ | ✓ | ✓ | — |
| Artwork | ✓ thumbnail | ✓ thumbnail | ✓ (artwork URL, proxied by host) | ✓ (artwork data) | — |
| Position / duration | if the session reports timeline | if reported | ✓ | ✓ | — |
| Seek | if `canSeek` | if reported | ✓ | ✓ | — |
| Shuffle / repeat | if the session supports them | if reported | ✓ | ✓ | — |
| Like / queue / playlists / devices | — | — | — | — | — (**Phase B**, Web API) |
| Permission needed | no | no | once (Automation → Spotify) | once (Automation → Music) | — |

"Spotify-rich" therefore means: the Spotify icon as source, album, progress, seek,
shuffle/repeat when reported, "Show on PC/Mac", and (Phase B) the account entry and
tabs. No Spotify green outside the Spotify icon itself; the UI keeps the dock's
accent. When the Web API is used (Phase B), Spotify's attribution rules apply: show
the Spotify icon with content and offer "Open in Spotify".

### 5.5 Drawer (frames 11, 12)

- Width grows from `min(92vw, 640px)` to **`min(92vw, 760px)`** so the computer row
  and the power group fit on one line at 844 (content 720: power group ~282, switch
  row ~430).
- Action grid: Media added after Apps (icon `music`). Columns still follow the
  visible buttons (`grid-auto-flow: column`), so hidden entries leave no holes.
- Bottom row: `display: flex; gap: 8px`. Left: the existing switch button (native)
  or plain connection text (browser), `flex: 1`. Right: **power group**, gap 6:
  `[lock] Lock`, `[moon] Sleep`, `[power] Shut down`. Each 48 tall, r14, `#ffffff08`
  (the switch row's fill), icon 18 + label 13, padding 0 15 0 13. The Shut down
  icon is `--danger-text`; labels stay `--text`. Labels are always visible: an
  unlabelled moon next to "Appearance" could read as dark mode, and Sleep acts
  without asking.
- Below 760 px drawer content width (narrow phones, large text), the power group
  wraps under the computer row as a full-width row of three equal buttons.
- Lock / Sleep: tap closes the drawer, sends the command, toast (5.6).
- Shut down: opens the dialog over the drawer; the drawer closes when the dialog
  confirms.

### 5.6 Power (frames 13–17)

**Lock** (immediate): toast "Studio PC locked". The host usually stays connected
(the session keeps running). If the host reports `session.locked: true`, the dock
shows a still pill at the top: lock icon + "Studio PC is locked" (frame 16). Tiles
keep working (apps open behind the lock screen). The pill clears when unlocked.

**Sleep** (immediate): toast "Studio PC is going to sleep" (frame 14). The host
acknowledges, then sleeps after 500 ms so the reply arrives. When the socket drops,
the reconnect pill shows **"Studio PC is asleep · Wake it to reconnect"** with a
moon icon instead of the pulsing dot, and no pulse (frame 15). The dock dims as
today and keeps retrying; × and running dots are hidden while offline. When the
computer wakes and reconnects, pill and dimming clear; no extra toast.

**Shut down / Restart** (dialog, frame 13): reuse `#confirm`.
- Icon `power` in a 44 px `--danger` 12 % tile; title "Shut down Studio PC?"; body
  "Apps with unsaved work may ask on the computer before it turns off. To reconnect,
  you'll need to turn Studio PC on."
- Buttons (equal width, 44 tall): **Cancel** (autofocus, default; Escape and scrim tap
  = Cancel) · **Restart** (secondary, `refresh` icon) · **Shut down** (`--danger`).
- If the host offers only one of the two, that one is the only action button and
  the title follows it ("Restart Studio PC?").
- After Shut down: toast "Shutting down Studio PC"; offline pill "Studio PC is off ·
  Turn it on to reconnect" (power icon, still).
- After Restart: toast "Restarting Studio PC"; pill "Studio PC is restarting…" with
  the pulsing dot (it is expected back soon). After 5 minutes without reconnecting,
  fall back to the normal "Reconnecting to Studio PC…".
- If the computer comes back (an app blocked shut down), everything clears as a
  normal reconnect would; the user sees why on the computer.

**Expected-disconnect memory:** after a successful sleep/shutdown/restart command
the dock stores `{ reason, computer, at }` in `sessionStorage`. A socket close within
60 s uses that reason's pill copy. The memory is cleared on reconnect. A native
shell's own "can't reach" screens only run at launch (PHONE-CONNECTION-FLOW 4.3), so
there is no conflict.

**macOS shut down permission** (frame 17): macOS needs a one-time Automation
permission (WinDock → System Events). The drawer button looks normal. After the
user confirms in the dialog:
- `needs-permission`: the host runs the request, macOS shows its prompt on the Mac,
  and the dialog changes to: shield icon, "Allow on your Mac", "Geri's MacBook Air
  is asking whether WinDock may shut it down. Click OK there and it shuts down.",
  "Waiting for your Mac…" (spinner stops after 60 s), **Close**. OK on the Mac
  shuts down at once (the user is at the Mac; no second phone tap).
- `denied`: dialog body "Shut down is turned off on your Mac. Turn on WinDock →
  System Events in System Settings › Privacy & Security › Automation.",
  buttons **Close** · **Open Settings on Mac**.

**Pinned power tiles** behave exactly like the drawer buttons (Lock/Sleep immediate,
Shut down/Restart dialog). Note the risk in Q2.

**Disabled power actions** (`allowDestructive: false`): Sleep, Shut down, Restart are
hidden everywhere (drawer, Controls, picker); Lock stays (after the host fix in 8.6).

### 5.7 Locked, asleep, off: one pill component

All use `.reconnect` (glass pill, top centre, 11–12 px). Variants:

| Variant | Icon | Pulse | Dock dim |
| --- | --- | --- | --- |
| Reconnecting to {computer}… (existing) | dot | yes | yes |
| {computer} is restarting… | dot | yes | yes |
| {computer} is asleep · Wake it to reconnect | moon 14 | no | yes |
| {computer} is off · Turn it on to reconnect | power 14 | no | yes |
| {computer} is locked | lock 14 | no | no (connected) |

---

## 6. Conditional visibility rules

Legend: **show**, **hide**, **disable** (visible, not operable, with the reason
nearby), **explain** (visible card/strip that says what one step is needed).
"Capability" = the snapshot's `features` (section 7). "Now" = live state.

### 6.1 Close ×

| Condition | Result |
| --- | --- |
| `features.close` missing or false (older host, Linux, unknown) | hide |
| App not running | hide |
| Running, `closable: false` | hide (dot stays) |
| Arrange mode | hide (and dots) |
| Offline / reconnecting / asleep / off | hide |
| Tile unavailable (app no longer installed) | hide |
| Setting "Close buttons on open apps" off | hide |
| Control tiles | never |
| Closing in progress | spinner badge, tile disabled |
| Otherwise | show |

### 6.2 Media

| Element | Condition | Result |
| --- | --- | --- |
| Mini player | no media capability (and no legacy `nowPlaying`) | hide |
| | capability, but no session now | hide |
| | session with title | show |
| | session without title | show "Playing in {app}" |
| | macOS player running, permission `needed` | explain (compact strip), until dismissed for this computer |
| | macOS player running, permission `denied` | hide on the dock; explain in the sheet |
| | offline (after 1.5 s) | hide |
| | setting "Now playing on the dock" off | hide |
| Drawer **Media** button | media capability **or** volume capability | show |
| | neither | hide |
| Media sheet transport | session present | show; each button disabled when the session says it's unavailable now |
| Album / progress / shuffle / repeat / "Show on…" | field present / control reported for the current source | show; otherwise hide the row or button |
| Seek (draggable thumb) | `controls.seek` true | show thumb; else progress is read-only, no thumb |
| Source switcher chevron | more than one session (Windows) | show; else static label |
| Volume slider | `volume.get && volume.set` | show |
| | legacy only (`verbs` has volume-up/down/mute, no `features.volume`) | show three buttons instead: Quieter · Mute · Louder |
| | none | hide row |
| Permission card | macOS, a supported player is running or was opened from the sheet, permission `needed`/`denied` | explain |
| "Open Spotify/Music" buttons | player installed and not running | show |
| Play/Pause pinned tile glyph | session playing | pause glyph; otherwise play glyph |

### 6.3 Power

| Element | Condition | Result |
| --- | --- | --- |
| Lock button / tile | `power.lock` present | show; offline: disable |
| Sleep button / tile | `power.sleep` present and `allowDestructive` | show; offline: disable |
| Shut down button / tile | `power.shutdown` or `power.restart` present and `allowDestructive` | show (label follows what's offered); offline: disable |
| | status `needs-permission` (macOS) | show normally; permission step inside the dialog |
| | status `denied` | show; dialog explains and offers Open Settings on Mac |
| Restart inside the dialog | `power.restart` present | show |
| Power group | none of the above | hide (switch row takes the full width) |
| Locked pill | online and `session.locked` true | show |
| Asleep / off / restarting pill | offline within 60 s of our own command | show (replaces the plain reconnect copy) |

### 6.4 Spotify

| Element | Condition | Result |
| --- | --- | --- |
| Spotify-rich rows | current source is Spotify | show the fields Spotify reports (5.4) |
| "Show on PC/Mac" | Spotify running and focusable | show |
| Phase B entry row | `spotify.account.available` true, not connected, source is Spotify or Spotify installed | show (Phase A: `available` is false, so hidden) |
| Tabs (Library, Search, Devices) | `spotify.account.connected` | show |
| Library playback, device switching | account is not Premium | disable with "Needs Spotify Premium" |

### 6.5 Drawer and platform

| Element | Condition | Result |
| --- | --- | --- |
| Capture, Touch & sign | existing `features.capture` / `features.input` | unchanged |
| Controls | the sheet would have at least one card (Sound, Display or Your PC) | show |
| Fullscreen | not in a native shell and `document.fullscreenEnabled` | show; else hide |

### 6.6 Older hosts and mismatches

- The four existing booleans (`controls`, `nowPlaying`, `capture`, `input`) keep
  "missing = on" (`feature()` in `app.js`).
- Every **new** key (`close`, `media`, `volume`, `power`, `spotify`) is
  **missing = hidden**, except for the legacy mapping in 7.3, which only uses routes
  that already exist.
- Unknown values (e.g. a future power status string) are treated as "not offered".

---

## 7. Capability map

### 7.1 Shape (in the snapshot and `/api/state`, re-broadcast when it changes)

```jsonc
"features": {
  // existing, unchanged
  "controls": true, "nowPlaying": true, "capture": true, "input": true,

  // new: missing = not offered
  "close": true,
  "media": {
    "sources": "system",            // "system" = any app (Windows media session); "apps" = per-player (macOS)
    "players": [                    // macOS: the supported players and their state; Windows: optional, for "Open Spotify"
      { "id": "spotify", "name": "Spotify", "appId": "com.spotify.client", "installed": true, "running": true, "permission": "granted" },
      { "id": "music",   "name": "Music",   "appId": "com.apple.Music",    "installed": true, "running": false, "permission": "needed" }
    ],
    "artwork": true,                // the host can serve artwork for at least one source
    "sessions": true                // several sessions can be listed and chosen (Windows)
  },
  "volume": { "get": true, "set": true, "mute": true },
  "power": { "lock": "ready", "sleep": "ready", "restart": "ready", "shutdown": "needs-permission" },
  "spotify": {
    "installed": true,
    "local": { "nowPlaying": true, "transport": true, "artwork": true, "seek": true, "shuffle": true, "repeat": true },
    "account": { "available": false }   // Phase B: { available: true, connected: true, premium: true, name: "Geri" }
  }
}
```

`permission` values: `"granted" | "needed" | "denied" | "not-required"`. Power
status values: `"ready" | "needs-permission" | "denied"`; a missing key means the
action isn't offered.

Plus one live field at the top of the snapshot: `"session": { "locked": false }`.

**Two layers, on purpose:** `features` answers "can this computer ever do X?" and
decides whether an entry point exists. `/api/media` (7.2) answers "what can the
current player do right now?" and decides which buttons render or disable. Per-source
abilities (seek, shuffle) change with every track source on Windows, so they don't
belong in `features`.

### 7.2 Expected values per host

| Key | Windows host | macOS host | Linux host (today) |
| --- | --- | --- | --- |
| `close` | true | true | omit (until checked) |
| `media.sources` | `"system"` | `"apps"` | omit |
| `media.players` | Spotify entry if installed (for "Open Spotify") | Spotify, Music if installed | — |
| `volume` | get/set/mute | get/set/mute (`osascript` volume settings) | omit |
| `power.lock` | ready | ready | — |
| `power.sleep` | ready | ready (`pmset sleepnow`) | — |
| `power.restart` | ready | needs-permission until granted (System Events) | — |
| `power.shutdown` | ready | needs-permission until granted (System Events) | — |
| `spotify.local` | through the system session: nowPlaying, transport, artwork; seek/shuffle/repeat only if Spotify reports them | all true | — |
| `controls` (legacy) | true | true once volume/power exist (so the Controls sheet appears) | as today |

### 7.3 Legacy mapping (new UI on a host without the new keys)

| New UI element | Fallback on an older host |
| --- | --- |
| Mini player / Media sheet | legacy `nowPlaying` on → `/api/nowplaying` (title, artist, playing). No artwork (source fallback = music glyph), no progress. Transport via `/api/control` `media-*` verbs if listed in `verbs`. |
| Volume | `verbs` volume-up/down/mute → three buttons. |
| Power | `verbs` lock/sleep/shutdown/restart + `allowDestructive`, via `/api/control`. Expected-disconnect copy works (client side). |
| Close × | hidden (no outcome reporting on old hosts). |
| Locked pill | hidden. |

---

## 8. Host API needs

Additive; `api: 1` stays. Engineers add:

### 8.1 Running apps stay fresh
- While at least one dock socket is open, poll `listRunningApps()` every **3 s**, diff
  by `(id, pid)`, broadcast a snapshot on change. Stop when no dock is connected.
- Each `running[]` entry gains `closable: boolean` (false for the cases in 5.1).

### 8.2 Close by app
`POST /api/apps/close` with `{ id }` (the existing `{ pid }` form stays):
- Closes every running instance with that app id politely (Windows `WM_CLOSE` to each
  top-level window of each pid; macOS `terminate` once per app), then waits up to
  **5 s** for exit.
- `200 { ok: true, id, requested: 3, closed: 2, stillOpen: [{ pid, title }] }`
- `404 { error: "not running" }`, `403 { error: "not closable" }`,
  `501 { error: "close unavailable" }`.
- Broadcast a snapshot after.

### 8.3 Media
- `GET /api/media` →
  ```jsonc
  {
    "source": { "id": "spotify", "name": "Spotify", "appId": "com.spotify.client", "sessionId": "…" } | null,
    "title": "Houdini", "artist": "Dua Lipa", "album": "Radical Optimism",
    "playing": true, "positionMs": 72000, "durationMs": 185000, "updatedAt": 1761043200000,
    "artwork": "/api/media/artwork?key=9f2c…" | null,
    "controls": { "previous": true, "next": true, "playPause": true, "seek": true, "shuffle": true, "repeat": true },
    "shuffle": true, "repeat": "off" | "all" | "one",
    "sessions": [{ "sessionId": "…", "name": "Chrome", "appId": "…", "title": "…", "current": true }],
    "permission": { "player": "spotify", "status": "needed" } | null
  }
  ```
  `source: null` = nothing playing. The client interpolates `positionMs` from
  `updatedAt` between 2 s polls while `playing`.
- `GET /api/media/artwork?key=` → image, host-fetched/converted, max 512 px, cached by
  key (track change = new key). Keeps the phone off the internet and the CSP simple;
  works for Windows thumbnails and the macOS Spotify artwork URL alike.
- `POST /api/media` `{ action, value?, sessionId? }` with actions
  `play | pause | toggle | next | previous | seek (ms) | shuffle (bool) | repeat ("off"|"all"|"one") | select (sessionId) | open (player id)`.
  Returns the new media state. `409 { error: "permission needed" }` when macOS hasn't
  allowed the player.
- `/api/nowplaying` stays for older UIs.

### 8.4 Volume
- `GET /api/volume` → `{ level: 45, muted: false }`
- `POST /api/volume` `{ level?, muted? }` → new state. The phone sends at most one
  `level` per 100 ms while dragging and always the final value on release.
- Existing `volume-*` / `mute-toggle` verbs keep working.

### 8.5 Permissions (macOS)
- `POST /api/permissions/request` `{ scope: "spotify" | "music" | "system-events" }` →
  triggers the macOS prompt by running a harmless script against that app; responds
  `{ status }` when the user answers or after 60 s (`"needed"`). Broadcast on change.
- `POST /api/permissions/open-settings` `{ scope }` → opens the Automation pane on the Mac.

### 8.6 Power
- Keep `/api/control` with `lock | sleep | restart | shutdown`. Change: reply
  `200 { ok: true, verb, expectDisconnect: true }` **first**, then execute after
  500 ms (sleep/restart/shutdown), so the phone gets its answer.
- **Remove `lock` from `DESTRUCTIVE_VERBS`** (or make the UI hide it too); today it's
  shown and then rejected when `allowDestructive` is false.
- macOS: `409 { error: "permission needed", scope: "system-events" }` when not yet
  allowed; the UI then calls 8.5 (or the host triggers the prompt itself as part of
  the shutdown request; either works, the UI copy is the same).
- Snapshot `session.locked` (Windows: WTS session lock/unlock notifications; macOS:
  `CGSessionCopyCurrentDictionary` → `CGSSessionScreenIsLocked`).

### 8.7 Spotify (Phase A)
- No separate routes: Spotify is a `/api/media` source. macOS provider adds
  AppleScript readers for Spotify and Music (name, artist, album, artwork URL /
  data, position, duration, shuffle, repeat, state) and their commands. Windows uses
  the system media session for every app, Spotify included.

### 8.8 Spotify (Phase B, later)
`GET /api/spotify/status`, `POST /api/spotify/connect` (opens the browser on the
computer), `GET /api/spotify/callback` (loopback redirect), `DELETE /api/spotify/account`,
`GET /api/spotify/playlists`, `GET /api/spotify/liked`, `GET /api/spotify/search?q=`,
`GET /api/spotify/devices`, `POST /api/spotify/play { uri, deviceId? }`,
`POST /api/spotify/queue { uri }`, `POST /api/spotify/transfer { deviceId }`,
`POST /api/spotify/like { trackId, liked }`. The host holds the tokens (encrypted
at rest in the config dir), refreshes them, and proxies all Web API calls.

---

## 9. Interaction details

### 9.1 Targets
- Every new control ≥ 44 × 44 px; primary in-sheet controls 48–60. The × visual is
  24 but its hit area is 44. Armed pill: 30 visual, 44 hit height.
- Android WebView: these are CSS px; 44 px ≈ 44 dp. For the drawer power buttons and
  sheet transport, 48 (meets 48 dp).

### 9.2 Accidental-close protection (×)
1. Two taps, 350 ms minimum between them, 3 s window.
2. A pointer that moves > 10 px between down and up on the × is not a tap (it's a
   page swipe that started on the corner).
3. `pointerdown` on the × does not start the 450 ms Arrange timer (the dock's
   pointerdown handler ignores targets inside `.tile__close`); holding the × does
   nothing.
4. The armed state is per tile; arming another tile disarms the first.
5. The close itself is polite on both platforms; unsaved work prompts on the computer.

### 9.3 Gesture map (nothing existing changes)

| Gesture | Where it starts | Result |
| --- | --- | --- |
| Tap | tile | launch / focus (unchanged) |
| Tap | × | arm; tap again (≥ 350 ms, ≤ 3 s) = close |
| Long-press 450 ms | tile | Arrange (unchanged) |
| Long-press | × | nothing |
| Horizontal swipe | dock (incl. on a ×) | page (unchanged); disarms |
| Swipe up | dock, bottom edge, footer | drawer (unchanged) |
| Swipe up | mini player | Media sheet |
| Horizontal swipe | mini player | nothing |
| Swipe down on grip | drawer / Media sheet | close |
| Drag | volume slider, seek bar | set value (`touch-action: none`, pointer capture) |
| Android Back | Media sheet open | closes it (same as other web sheets) |

The mini player covers most of the invisible bottom-edge drawer trigger
(`#drawer-open`, 25–75 % width). The drawer stays reachable by swiping up anywhere
on the dock area and from the edge either side of the mini player.

### 9.4 Commands and feedback
- Transport, shuffle, repeat: optimistic state, confirmed or corrected by the reply
  and the next poll. No toast (the control's state is the feedback).
- Volume: thumb follows the finger; value text updates live; no toast.
- Power: toast on success; error toast with the host's message on failure.
- While a command is in flight, only that control is disabled (`aria-busy`), not the
  surface.

---

## 10. Motion

Curves from the existing system and PHONE-CONNECTION-FLOW: `--ease-out:
cubic-bezier(0.23, 1, 0.32, 1)`; the drawer's existing keyframe curve
`cubic-bezier(.2,.7,.2,1)` for sheets. Add `--ease-out` to `:root` in `style.css`.
CSS transitions only (no library); transitions retarget from the current value, so
a second tap mid-animation never queues.

| Trigger | Element | Properties | Duration | Easing | Interruption | Reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| App becomes running while visible | × badge | opacity 0→1, scale .9→1 | 150 ms | `--ease-out` | transition retargets | opacity only |
| Tap × (arm) | × out; "Close" pill in (origin top right) | × opacity →0; pill opacity 0→1, scale .92→1 | 100 ms out / 160 ms in | `--ease-out` | 2nd tap / timeout retarget | opacity only |
| Disarm (timeout, other tap) | pill out, × in | opacity | 120 ms | `--ease-out` | retarget | same |
| Confirm close | pill → spinner badge; icon | badge crossfade; icon opacity 1→.45 | 100 ms; 160 ms | `--ease-out` | — | same; spinner static (no rotation) |
| Closing | spinner | rotate 360° | 800 ms per turn, linear, ends with the close (≤ 8 s) | linear | — | static ¾ ring |
| App closed | × badge + dot; icon | opacity →0; icon opacity →1 | 150 ms; 200 ms | `--ease-out` | — | same |
| Still open | badge back to ×; icon | crossfade; opacity →1 | 150 ms; 200 ms | `--ease-out` | — | same (no shake: the user did nothing wrong) |
| Session starts | mini player | opacity 0→1, translateY 8→0 (grid reflows instantly first) | 200 ms | `--ease-out` | session ends mid-way: retarget | opacity only |
| Session ends | mini player | opacity →0, translateY 0→8, then grid reflows | 150 ms | `--ease-out` | session returns: retarget | opacity only |
| Track changes | title/artist; artwork | crossfade text; new artwork fades in over the old once loaded | 150 ms; 200 ms | ease | last change wins | same |
| Media sheet opens | sheet | existing `drawer-in` keyframe (translateY 24→0, opacity) | 250 ms | `cubic-bezier(.2,.7,.2,1)` | — | none (existing rule) |
| Progress while playing | progress fill | `transform: scaleX()` once per second | 1000 ms | linear | pause/seek: set instantly | steps each second, no transition |
| Volume changed elsewhere | slider thumb + fill | transform | 150 ms | `--ease-out` | user drags: none | none |
| Shuffle / repeat toggle | glyph colour, dot | color, opacity | 150 ms | ease | retarget | same |
| Locked / asleep / off pill | pill | existing `.reconnect` opacity + translateY | 200 ms | existing | existing | existing |
| Permission / waiting spinner | spinner | rotate | 800 ms, stops after 60 s | linear | — | static ring |
| Any button press | button | existing `:active` scale .96 | 160 ms | existing | — | none (existing rule) |

**Deliberately not animated:** the play/pause glyph swap (used dozens of times a day;
must feel instant); the icon grid reflow when the mini player appears or goes (layout
animation on the grid would cost more than it explains; it happens only when a
player starts or quits); drawer power buttons beyond the press; the Shut down dialog
(existing `.confirm` has none); toasts (existing); volume value text; tab switches
in Phase B (content swaps instantly); running dots (no pulse); long titles (truncate,
never marquee: the screen is on all day); the asleep/off/locked pill icons (still,
for the same reason).

---

## 11. Accessibility

- **Contrast (measured):** "Close" `#301516` on `--danger #ed9695` 7.6:1. × glyph
  `#e9f1ef` on the dark badge ~15:1 over any icon. Play glyph `#152c20` on `#b4edcc`
  11.3:1. On the Clear glass over the aurora wallpaper (~`#1c2a33`), `--muted` is
  6.5:1 and the album line `#8c9c9c` 5.2:1. Frosted glass over the Ember background
  is the lightest combination: check it in the browser (section 17) and darken the
  mini player's glass to the Smoked value there if `--muted` drops under 4.5:1.
- **Never colour alone:** shuffle/repeat on = accent + dot + `aria-pressed`; paused =
  word "Paused" on the strip and the Play glyph; armed close = word "Close"; locked =
  lock icon + words.
- **Close button:** a real `<button class="tile__close">` *after* the tile button
  (buttons can't nest), inside a new `.tile-slot` wrapper. Name "Close Slack" /
  "Close all 3 Slack windows". On arm, its name becomes "Confirm: close Slack" and a
  polite live region says "Tap again to close Slack." Keyboard: Enter/Space arms,
  again confirms, Escape disarms. Focus stays on it through all states; after the
  app closes and the button disappears, focus moves to the tile.
- **Tile name** includes state: "Slack, running" (today it's `aria-pressed`; keep it
  and add the word).
- **Mini player:** `role="region" aria-label="Now playing"`. The artwork/text button
  is named "Houdini by Dua Lipa, Spotify. Open media controls." Transport buttons:
  "Previous track", "Pause" / "Play", "Next track". No live announcements on track
  change (would interrupt all day); announce only results of the user's own actions.
- **Sliders:** native `<input type="range">` styled, `aria-valuetext="45 percent"` /
  "Muted"; seek `aria-valuetext="1 minute 12 seconds of 3 minutes 5 seconds"`.
- **Dialogs:** existing `<dialog>` focus handling; Cancel autofocus on Shut down.
- **Pills:** existing `role="status" aria-live="polite"` on `#reconnect`.
- **Text size:** the dock is a WebView; with large system text (Android font scale,
  iOS text zoom), the mini player's second line drops first, then the source badge;
  the drawer power group wraps under the computer row (5.5).
- **Reduced motion:** table in section 10. **Reduced transparency** (iOS setting via
  `prefers-reduced-transparency`): glass falls back to the Smoked theme values.

---

## 12. Spotify account (Phase B, design now, build later)

**Entry point:** the Spotify Media sheet's footer row, shown when the host has a
Spotify client configured (`spotify.account.available`) and no account is connected:
`[Spotify icon] Your playlists, search and devices   [Connect Spotify]`. Also on the
host control page under This computer (HOST-CONTROL-PAGE 5.7): "Spotify · Connect
account".

**Login happens on the computer** (frame 20). Reasons: Spotify only allows HTTPS or
loopback redirect URIs, and the host already serves `http://127.0.0.1:<port>`; the host
must own the token so every paired phone gets the features and the phone never
handles a Spotify password; the user is at the computer anyway.
1. Phone: tap Connect Spotify → `POST /api/spotify/connect` → host opens the default
   browser on the computer at Spotify's authorize URL (PKCE, scopes: playback
   read/modify, library read, playlists read, user-read-private for Premium check).
2. Phone shows "Finish on Studio PC" + "Waiting for Spotify…" + **Open the window
   again** · **Cancel**.
3. Spotify redirects to `http://127.0.0.1:<port>/api/spotify/callback`; the host
   stores tokens and broadcasts `spotify.account.connected`. The browser tab shows a
   plain "Connected. You can close this tab."
4. The phone's sheet switches to tabs on its own.

**Tabs** in the same sheet header (frames 21, 22), using the picker's tab style:
- **Now playing**: Phase A content, plus a heart (like) next to the title and an
  "Up next" list (queue) on wide screens.
- **Library**: Liked Songs first, then playlists (two-column list, rows 60, art 44).
  Tap = play on the current device. The row playing now shows "Playing" with a
  speaker icon instead of the play button.
- **Search**: field at the top of the sheet; in landscape the phone keyboard covers
  the lower half, so results list directly under the field (rows 56) and the sheet
  pins to the top of the screen while typing. Sections: Songs, Artists, Albums,
  Playlists; tap a song = play, long-press = add to queue.
- **Devices**: Spotify Connect devices, current one checked. Tap = transfer. The mini
  player then reads "on Sonos Kuzhina" and keeps controlling it.
- A footer on every tab keeps the current track, Play/Pause and the device chip in view.

**States:** not Premium → library and devices list stay readable, play/transfer
disabled with "Needs Spotify Premium". Token revoked → footer row "Spotify
disconnected · Connect again". Host offline → tabs grey out with the reconnect pill.
Disconnect lives on the host page (and a "Disconnect Spotify" row at the bottom of
Devices).

---

## 13. Copy deck

`{computer}` = the phone's nickname for it when the native shell gives one
(`WinDockNative.computerName`), else the host name. `{app}` = tile label.
`{Mac/PC}` = "Mac" on macOS hosts, "PC" on Windows.

### Close
| Key | Copy |
| --- | --- |
| close.button.label | Close {app} |
| close.button.label.multi | Close all {n} {app} windows |
| close.armed | Close |
| close.armed.multi | Close all |
| close.armed.label | Confirm: close {app} |
| close.armed.live | Tap again to close {app}. |
| close.done | {app} closed |
| close.done.multi | Closed {n} {app} windows |
| close.stillOpen | {app} is still open. It may be asking to save changes on {computer}. |
| close.partial | Closed {closed} of {n} {app} windows. One may be asking to save changes on {computer}. |
| close.alreadyClosed | {app} was already closed. |
| close.failed | {computer} couldn't close {app}. Try again, or close it on the computer. |
| settings.closeButtons | Close buttons on open apps |

### Media
| Key | Copy |
| --- | --- |
| mini.region | Now playing |
| mini.open.label | {title} by {artist}, {source}. Open media controls. |
| mini.paused | Paused · {source} |
| mini.noInfo.title | Playing in {source} |
| mini.noInfo.sub | No track details |
| mini.permission | Allow {player} control |
| mini.permission.button | Allow |
| btn.previous / btn.play / btn.pause / btn.next | Previous track / Play / Pause / Next track |
| btn.shuffle / btn.repeat | Shuffle / Repeat (value: Off, All, One) |
| sheet.title.empty | Media |
| sheet.context | on {computer} |
| sheet.players | · {n} players |
| sheet.showOn | Show on {Mac/PC} |
| sheet.volume | Volume |
| sheet.muted | Muted |
| sheet.mute / sheet.unmute | Mute / Unmute |
| empty.title | Nothing playing |
| empty.body.windows | Play something on {computer} and it will show up here, with its controls. |
| empty.body.mac | Open Spotify or Music on {computer} to control it here. |
| empty.body.mac.none | WinDock can control Spotify and Music on a Mac. Neither is installed on {computer}. |
| empty.resume | Resume last player |
| empty.open | Open {player} |
| perm.title | Control {player} from your phone |
| perm.body | Your Mac asks once before WinDock can read and control {player}. |
| perm.step1 / perm.step2 | Tap Ask on Mac. / On {computer}, click OK in the prompt. |
| perm.ask / perm.notNow | Ask on Mac / Not now |
| perm.waiting | Waiting for your Mac… Click OK in the prompt on {computer}. |
| perm.denied.title | {player} control is off on your Mac |
| perm.denied.body | Turn on WinDock → {player} in System Settings › Privacy & Security › Automation. |
| perm.openSettings | Open Settings on Mac |
| settings.miniPlayer | Now playing on the dock |
| error.media | {computer} couldn't reach {player}. Try again. |

### Power
| Key | Copy |
| --- | --- |
| power.lock / power.sleep / power.shutdown | Lock / Sleep / Shut down |
| power.lock.label | Lock {computer} |
| power.sleep.label | Put {computer} to sleep |
| power.shutdown.label | Shut down or restart {computer} |
| toast.locked | {computer} locked |
| toast.sleeping | {computer} is going to sleep |
| toast.shuttingDown | Shutting down {computer} |
| toast.restarting | Restarting {computer} |
| pill.locked | {computer} is locked |
| pill.asleep | {computer} is asleep · Wake it to reconnect |
| pill.off | {computer} is off · Turn it on to reconnect |
| pill.restarting | {computer} is restarting… |
| confirm.title | Shut down {computer}? |
| confirm.title.restartOnly | Restart {computer}? |
| confirm.body | Apps with unsaved work may ask on the computer before it turns off. To reconnect, you'll need to turn {computer} on. |
| confirm.body.restartOnly | Apps with unsaved work may ask on the computer first. WinDock reconnects when it's back. |
| confirm.cancel / confirm.restart / confirm.shutdown | Cancel / Restart / Shut down |
| perm.power.title | Allow on your Mac |
| perm.power.body | {computer} is asking whether WinDock may shut it down. Click OK there and it shuts down. |
| perm.power.body.restart | {computer} is asking whether WinDock may restart it. Click OK there and it restarts. |
| perm.power.waiting | Waiting for your Mac… |
| perm.power.denied | Shut down is turned off on your Mac. Turn on WinDock → System Events in System Settings › Privacy & Security › Automation. |
| perm.power.close | Close |
| controls.yourpc.hint | Shut down and restart ask first. |
| error.offline | {computer} is disconnected. Waiting for it to reconnect. (existing, reworded with the name) |

### Spotify Phase B
| Key | Copy |
| --- | --- |
| sp.entry | Your playlists, search and devices |
| sp.connect | Connect Spotify |
| sp.finish.title | Finish on {computer} |
| sp.finish.body | A browser window opened on {computer}. Log in to Spotify there and allow WinDock. Your password never passes through this phone. |
| sp.waiting | Waiting for Spotify… |
| sp.reopen / sp.cancel | Open the window again / Cancel |
| sp.after | After this: playlists, liked songs, search, the queue and choosing which device plays. Playing from your library needs Spotify Premium. |
| sp.tabs | Now playing · Library · Search · Devices |
| sp.liked | Liked Songs · {n} songs |
| sp.playing | Playing |
| sp.devices.label | Play on |
| sp.devices.thisComputer | This computer |
| sp.devices.note | Only devices with Spotify open show up. Switching needs Spotify Premium. |
| sp.premium | Needs Spotify Premium |
| sp.search.placeholder | Songs, artists, albums |
| sp.search.empty | No results for "{q}". |
| sp.disconnected | Spotify disconnected · Connect again |
| sp.browser.done | Connected. You can close this tab. |

---

## 14. Tokens and components (new or changed)

| Token / component | Value |
| --- | --- |
| `--ease-out` *new in style.css* | `cubic-bezier(0.23, 1, 0.32, 1)` (same as the native spec) |
| `--badge` *new* | `rgba(12, 20, 24, .78)` |
| `--text-3` *new in style.css* | `#8c9c9c` (album line, tertiary captions; 5.2:1 on Clear glass) |
| Close badge | 24 visual / 44 hit, offset −8/−8 from the icon corner, glyph 12 stroke 2.4 |
| Armed pill | 30 tall, radius 15, padding 0 12 0 9, `--danger` / `#301516`, 12/650 |
| Mini player | 58 tall, radius 19, width `min(440px, 100% - 48px)`, glass; art 42 r9; source badge 17 r5; buttons 44 |
| Media sheet | `.sheet` + width `min(92vw, 720px)`; art 164/188 r14; play 60; transport 48; slider thumb 20, hit 44 |
| Drawer | width `min(92vw, 760px)` (was 640) |
| Power button | 48 tall, r14, `#ffffff08`, icon 18 + label 13 |
| Status pill variants | `.reconnect` + `[data-variant="asleep|off|restarting|locked"]`, icon 14 replaces the dot when not pulsing |
| New icons for `icons.js` | `shuffle`, `repeat`, `repeat-one`, `speaker`, `heart`, `shield`, `open` (paths in the mockup sprite) |
| Reused | `.sheet`, `.glass-drawer`, `.drawer-switch`, `#confirm`, `.toast`, `.reconnect`, `.picker__tabs`, `.button--primary/--danger`, `.switch` |

---

## 15. Decisions and open questions

**Decided here (say if you disagree):**
- D1. × always visible on running tiles (with a setting to turn it off), two-tap close.
  Rejected: a "close mode" (hidden, extra steps) and showing × in Arrange (mixes
  "remove from dock" with "quit").
- D2. One media surface: mini player + Media sheet. Spotify is a richer source, not a
  separate UI. No 2-wide "now playing" widget tile (breaks the uniform grid and the
  pager's tile-count maths).
- D3. Restart sits inside the Shut down confirmation, so it is confirmed too.
- D4. System volume only; no per-player volume slider.
- D5. Spotify login on the computer, tokens on the host.
- D6. Drawer widens to 760 to keep power on the computer row.

**Questions for you:**
- Q1. **Restart confirmation.** You said only Shut down asks. Restart loses unsaved work
  the same way, so I put it inside the Shut down dialog (D3). Want Restart as its own
  immediate button instead?
- Q2. **Pinned Sleep/Lock tiles** act immediately, like the drawer. On a dock tapped
  all day, a pinned Sleep tile is the one most likely to be hit by accident. Keep
  immediate, or have *pinned* Sleep use the same two-tap arming as ×?
- Q3. **Close all instances** vs. only the frontmost window. I chose all (the tile
  stands for the app). Some people expect "close this window".
- Q4. **Mini player default.** On by default. Fine for a music user; others may prefer
  icons only. Default on, or on only after the first session ever?
- Q5. **Wake on LAN.** "Wake it to reconnect" could become a **Wake** button if the
  phone sends a magic packet (native shells, needs the computer's MAC address and WoL
  enabled in BIOS/macOS settings). Worth a follow-up?
- Q6. **Spotify client ID for Phase B.** The Web API needs a registered app. For a
  personal app, your own Spotify developer app in Development mode (a small allowlist
  of accounts) is enough. Who should be on that list?
- Q7. **Apple Music on Windows / other players on macOS.** macOS only gets Spotify and
  Music. Add more AppleScript players later (e.g. VLC), or keep it to the two?
- Q8. **Phase B pinned tiles** ("play this playlist" as a dock tile). Fits the tile
  model, but adds a third tile kind. Later?

**Expensive to build (for your trade-offs):**
- Tile DOM change for a sibling close button (`.tile-slot`): touches `renderTile`,
  `renderPages`, drag ghost cloning and the gesture code that uses `[data-tile-key]`.
  Medium risk; test long-press, drag and paging carefully.
- macOS AppleScript providers for Spotify and Music, plus TCC permission states.
- Windows media session: thumbnails → artwork route, session list, seek/shuffle/repeat.
- Phase B: OAuth, token storage, Web API proxy, three new tabs. Large; deliberately later.

---

## 16. Screenshot index

| File | Shows |
| --- | --- |
| `dock-01-close-buttons.png` | Running tiles with ×, one armed "Close", a running but not closable app |
| `dock-02-close-anatomy.png` | Close badge and armed pill measurements (annotated) |
| `dock-03-closing.png` | Closing spinner; "still open" toast |
| `dock-04-arrange.png` | Arrange mode: "−" only, no × or dots |
| `dock-05-mini-spotify.png` | 932 wide, 8 per page, mini player with Spotify artwork |
| `dock-06-mini-generic.png` | Paused Chrome session, no artwork, long title |
| `dock-07-media-spotify.png` | Media sheet, Spotify on a Mac (rich) |
| `dock-08-media-generic.png` | Media sheet, any app on Windows, 2 players |
| `dock-09-media-nothing.png` | Nothing playing (Windows) |
| `dock-10-media-permission.png` | Needs permission on the Mac |
| `dock-11-drawer-windows.png` | Drawer on Windows: Media + power group |
| `dock-12-drawer-mac.png` | Drawer on a Mac: fewer entries, no holes |
| `dock-13-shutdown-confirm.png` | Shut down dialog with Restart |
| `dock-14-sleep-sent.png` | Toast right after Sleep |
| `dock-15-asleep.png` | "Studio PC is asleep · Wake it to reconnect" |
| `dock-16-locked.png` | "Studio PC is locked", still connected |
| `dock-17-mac-shutdown-permission.png` | First Mac shut down: waiting for the prompt |
| `dock-20-spotify-connect.png` | Phase B: finish login on the computer |
| `dock-21-spotify-library.png` | Phase B: Library tab |
| `dock-22-spotify-devices.png` | Phase B: Devices tab |

---

## 17. Implementation notes (where it lands)

- `public/index.html`: Media button in `.drawer-actions`; power group next to the
  connection row; `<dialog id="media">`; `#mini-player` container in `.workspace`;
  two switches in Settings › Layout.
- `public/dock.js`: `renderTile` → `.tile-slot` wrapper with the close button;
  `renderMiniPlayer`, `renderMediaSheet` (pure, testable like the rest); Play/Pause
  tile glyph from media state; remove the Playback card from `renderControls`.
- `public/app.js`: extended `feature()` helpers (new keys missing = off); close flow
  (arm/confirm/timeouts); media poller on `/api/media` (replaces `/api/nowplaying`
  when available); volume throttle; power without confirmation for lock/sleep;
  expected-disconnect memory and pill variants; `has-mini` class.
- `public/now-playing.js`: generalise to the media poller (same single-flight design).
- `public/style.css`, `public/icons.js`: section 14.
- Host: `src/platform/contract.js` (`featuresOf` shape), `server.js` (routes in
  section 8, running poll), `src/platform/windows.js` / `macos.js` (providers).
- Verify in the browser after building: × geometry at 4/6/8 per page and in classic
  mode; long-press and drag still work when starting on a tile corner; the mini
  player reflow at 844 × 390 with 8 per page; glass contrast on Frosted + Ember;
  Android Back with the Media sheet open; VoiceOver/TalkBack two-tap close.
