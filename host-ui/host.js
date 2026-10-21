/**
 * WinDock host control page. Spec: docs/design/HOST-CONTROL-PAGE.md.
 *
 * Vanilla JS, no framework, CSP-compatible (no inline script or style). Loaded
 * only on this computer (/host is loopback-only). The pure helpers at the top
 * are exported so the test oracle can import this module under Node; the page
 * itself starts only when a document exists.
 *
 * The PIN is held in memory only: never in storage, a URL, the title, a
 * notification or the clipboard.
 */

// ---------------------------------------------------------------------------
// Copy (section 14)
// ---------------------------------------------------------------------------

export const COPY = Object.freeze({
  chip: { running: "Running", attention: "Needs attention", starting: "Starting", restarting: "Restarting", stopped: "Stopped" },
  chipA11y: { running: "WinDock is running", attention: "WinDock needs attention", restarting: "WinDock is restarting", stopped: "WinDock is stopped" },
  details: "Details",
  pair: "Pair a new phone",
  detailsAddress: "Address",
  detailsSecure: "Secure address",
  detailsOthers: "Also reachable at",
  detailsOlder: "Older phone apps",
  detailsVersion: "Version",
  olderOn: "Allowed (plain HTTP is on)",
  olderOff: "Not allowed (plain HTTP is off)",
  firstTitle: "Pair your first phone",
  pairScan: "Scan with the phone’s camera, or tap <b>Scan QR code</b> in WinDock on the phone.",
  qrLabel: "QR code for pairing. Scan it with your phone.",
  stop: "Stop pairing",
  keep: "Keep open",
  manual: "Or enter these on the phone",
  address: "Address",
  code: "Security code",
  pin: "PIN",
  note: "Each PIN pairs one phone. A new one appears after each pairing.",
  copied: "Address copied",
  pairedBody: "The code below is new. Scan it to pair another phone.",
  done: "Done",
  closedTile: "No code while pairing is closed",
  closedTitle: "Pairing is closed",
  closedTimeout: "It closes 10 minutes after it opens, to keep strangers out.",
  closedStopped: "You stopped pairing. The old code no longer works.",
  closedOpen: "Open pairing for 10 minutes",
  budgetTitle: "Pairing closed after 10 wrong PINs",
  budgetBody: "The PIN has been changed. Someone on this network may have been guessing. If it wasn’t you, check that every paired phone is yours.",
  budgetOpen: "Open pairing again",
  budgetReview: "See paired phones",
  noaddrTile: "No code without a network",
  noaddrTitle: "Connect to a network to pair",
  notls: "QR pairing needs HTTPS, which is turned off. Phones can still pair with the address and PIN.",
  phonesTitle: "Paired phones",
  connected: "Connected now",
  seenToday: "Seen today",
  seenYesterday: "Seen yesterday",
  never: "Not seen since pairing",
  rename: "Rename…",
  remove: "Remove…",
  removeAll: "Remove all phones…",
  renameError: "Couldn’t save the name. Try again.",
  removeBody: "It needs a new PIN to connect again.",
  removeConnected: "It disconnects now and needs a new PIN to connect again.",
  cancel: "Cancel",
  removeConfirm: "Remove",
  removeError: "Couldn’t remove it. Try again.",
  removeAllConfirm: "Remove all",
  computer: "This computer",
  loginMac: "Start at login",
  loginWin: "Start when I sign in",
  loginPending: "Waiting for you to allow it in System Settings.",
  loginOpenSettings: "Open Login Items",
  netTitle: "Visible on this network",
  netOk: "Phones on the same Wi-Fi find it by themselves.",
  netBonjourFailed: "iPhones can’t find this computer by themselves right now. They can still connect by address or QR code.",
  netBonjourOff: "Automatic discovery for iPhones is turned off.",
  netUdpFailed: "Android phones can’t find this computer by themselves right now. They can still connect by address or QR code.",
  netBothFailed: "Phones can’t find this computer by themselves right now. Pair with the QR code or the address.",
  banFirewallTitle: "macOS is blocking phones",
  banFirewallBody: "The firewall stops incoming connections to node, so phones can’t reach this Mac.",
  banFirewallAction: "Open Firewall settings",
  banNoaddrTitle: "Not connected to a network",
  banRecTitle: "Recording your screen",
  banRecBody: "Main monitor, no audio. Saved to Videos\\WinDock.",
  banRecAction: "Stop recording",
  banUpdateBody: "You have {installed}.",
  banUpdateAction: "Download",
  banUpdateLater: "Later",
  moreWindow: "Open in a window",
  moreLogs: "Open logs folder",
  moreUpdates: "Check for updates…",
  moreRestart: "Restart WinDock",
  moreQuit: "Quit WinDock",
  noteShellMac: "Start at login, logs and quit are in the WinDock menu-bar app.",
  noteShellWin: "Start at login, logs and quit are in the WinDock tray icon.",
  noteTerminalMac: "WinDock was started from Terminal. Stop it there with Control-C.",
  noteTerminalWin: "WinDock was started from a command prompt. Stop it there with Ctrl+C.",
  closesSoon: "Pairing closes in less than a minute",
  closedNow: "Pairing closed",
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for the oracle)
// ---------------------------------------------------------------------------

/** Countdown row text and action for the time left (section 5.4). */
export function countdownState(remainingMs) {
  if (!(remainingMs > 0)) return { kind: "closed", lead: "", strong: "", action: null };
  if (remainingMs < 60_000) return { kind: "last", lead: "Closes in ", strong: "less than a minute", action: "keep" };
  if (remainingMs < 120_000) return { kind: "one", lead: "Open for ", strong: "1 more minute", action: "stop" };
  const minutes = Math.ceil(remainingMs / 60_000); // section 5.4: rounded up from 2 minutes
  return { kind: "n", lead: "Open for ", strong: `${minutes} more minutes`, action: "stop" };
}

/** "482913" → ["482", "913"]; the a11y label spells each digit. */
export function pinParts(pin) {
  const s = String(pin ?? "");
  return { head: s.slice(0, 3), tail: s.slice(3), label: `PIN ${[...s].join(" ")}` };
}

/** "6E21-B4F0-93AD" → groups and "Security code 6 E 2 1, B 4 F 0, 9 3 A D". */
export function securityCodeParts(code) {
  const groups = String(code ?? "").split("-").filter(Boolean);
  return { groups, label: `Security code ${groups.map((g) => [...g].join(" ")).join(", ")}` };
}

/** Caption for "Visible on this network" (section 5.7). */
export function discoveryCaption(discovery = {}) {
  const { bonjour = "on", udp = "on" } = discovery;
  if (udp === "failed" && (bonjour === "failed" || bonjour === "off")) return COPY.netBothFailed;
  if (udp === "failed") return COPY.netUdpFailed;
  if (bonjour === "failed") return COPY.netBonjourFailed;
  if (bonjour === "off") return COPY.netBonjourOff;
  return COPY.netOk;
}

/** Chip state from a status snapshot: only firewall and no address raise it. */
export function chipState(status) {
  if (!status) return "stopped";
  if (status.firewall === "blocked" || !status.network?.address) return "attention";
  return "running";
}

function localDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "12 Oct", with the year when it isn't this year. */
export function shortDate(ms, now = Date.now(), locale = undefined) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(d);
}

/** Full local date and time for tooltips and descriptions. */
export function longDateTime(ms, locale = undefined) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(new Date(ms));
}

/** The name a row shows: the host-side label, else the phone's own name. */
export function displayName(device) {
  return device.label || device.name;
}

/**
 * The caption pieces under a phone's name (section 5.5): a seen/connected
 * part, then the phone's own name when renamed, else "Paired {date}".
 */
export function deviceCaption(device, now = Date.now(), locale = undefined) {
  const second = device.label ? device.name : `Paired ${shortDate(device.issuedAt, now, locale)}`;
  if (device.connected) return { connected: true, first: COPY.connected, second };
  if (!(device.lastSeenAt > device.issuedAt)) {
    return { connected: false, first: COPY.never, second: `Paired ${shortDate(device.issuedAt, now, locale)}` };
  }
  const days = Math.round((localDay(now) - localDay(device.lastSeenAt)) / 86_400_000);
  const first = days <= 0 ? COPY.seenToday : days === 1 ? COPY.seenYesterday : `Seen ${shortDate(device.lastSeenAt, now, locale)}`;
  return { connected: false, first, second };
}

/** Initial row order: connected first, then most recently seen. */
export function sortDevices(devices) {
  return [...devices].sort((a, b) => (Number(b.connected) - Number(a.connected)) || (b.lastSeenAt - a.lastSeenAt) || (b.issuedAt - a.issuedAt));
}

/**
 * Keep the visible order stable while the page is open: known ids keep their
 * place, new ones go first, gone ones drop out.
 */
export function stableOrder(previousIds, devices) {
  const ids = new Set(devices.map((d) => d.id));
  const kept = previousIds.filter((id) => ids.has(id));
  const fresh = sortDevices(devices.filter((d) => !kept.includes(d.id))).map((d) => d.id);
  return [...fresh, ...kept];
}

/** The rename field's value to send: trimmed, at most 40 characters, null when empty. */
export function labelToSend(value) {
  const trimmed = Array.from(String(value ?? "").trim()).slice(0, 40).join("").trim();
  return trimmed || null;
}

/** "macos" | "windows" from the shell, else from the browser. */
export function detectOs(shellOs, nav = {}) {
  if (shellOs === "macos" || shellOs === "windows") return shellOs;
  const platform = String(nav.userAgentData?.platform || nav.platform || "");
  return /win/i.test(platform) ? "windows" : "macos";
}

/** The note shown in a browser without a shell (section 5.9). */
export function browserNote(statusShell, os) {
  const win = os === "windows";
  if (statusShell) return win ? COPY.noteShellWin : COPY.noteShellMac;
  return win ? COPY.noteTerminalWin : COPY.noteTerminalMac;
}

/** "10.0.0.12 (Ethernet)" for "Also reachable at". */
export function otherAddressText(other) {
  const kind = other.kind === "wifi" ? "Wi-Fi" : other.kind === "ethernet" ? "Ethernet" : other.interface;
  return kind ? `${other.address} (${kind})` : other.address;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function startPage() {
  const $ = (id) => document.getElementById(id);
  const root = $("root");
  const main = $("main");
  const live = $("live");
  const alertLive = $("alert-live");

  const shellInfo = () => (typeof window.WinDockShell === "object" && window.WinDockShell) || null;
  const hasShell = () => Boolean(shellInfo());
  const cap = (name) => Boolean(shellInfo()?.capabilities?.[name]);
  function post(msg) {
    if (!hasShell()) return;
    try {
      if (window.webkit?.messageHandlers?.windockShell) window.webkit.messageHandlers.windockShell.postMessage(msg);
      else if (window.chrome?.webview) window.chrome.webview.postMessage(msg);
    } catch {
      /* the shell went away */
    }
  }

  const os = detectOs(shellInfo()?.os, navigator);
  document.documentElement.dataset.os = os;
  const container = shellInfo()?.container;
  if (container) document.documentElement.dataset.container = container;
  const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const isWide = () => root.getBoundingClientRect().width >= 640;

  const S = {
    status: null,
    pairing: null, // last /api/host/pairing body
    pairingGen: null,
    devicesGen: null,
    devices: null, // array, or null until loaded
    order: [],
    view: "home", // home | pair | first
    deadline: 0, // performance.now() when pairing closes (local countdown)
    localClosed: false,
    banner: null, // { name } after a pairing
    detailsOpen: false,
    renaming: null, // { id, error }
    confirming: null, // { id, error }
    leaving: new Set(),
    leavingData: new Map(), // id -> device, while its row animates away
    arriving: new Set(),
    login: null, // { state }
    loginBusy: false,
    update: null, // { state, version }
    updateDismissed: false,
    restarting: false,
    offline: false,
    lastAnnounce: "",
  };

  // ---- tiny DOM helpers ----
  const NS = "http://www.w3.org/2000/svg";
  function icon(name, cls = "i") {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", cls);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(NS, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v; // only constant copy with <b>
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }
  function announce(text, assertive = false) {
    const target = assertive ? alertLive : live;
    target.textContent = "";
    setTimeout(() => { target.textContent = text; }, 30);
  }

  // ---- network ----
  async function api(path, { method = "GET", body } = {}) {
    const init = { method, headers: {}, cache: "no-store", credentials: "same-origin" };
    if (method !== "GET") {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(path, init);
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error(json?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function loadPairing() {
    try {
      applyPairing(await api("/api/host/pairing"));
    } catch {
      /* the next status event retries */
    }
  }
  async function openPairing() {
    try {
      applyPairing(await api("/api/host/pairing/open", { method: "POST" }));
    } catch {
      /* stays as it was */
    }
  }
  async function stopPairing() {
    try {
      applyPairing(await api("/api/host/pairing/close", { method: "POST" }));
    } catch {
      /* stays as it was */
    }
  }
  async function loadDevices() {
    try {
      const { devices } = await api("/api/devices");
      applyDevices(devices);
    } catch {
      /* the next status event retries */
    }
  }

  function applyPairing(body) {
    if (!body) return;
    const wasOpen = S.pairing?.open && !S.localClosed;
    S.pairing = body;
    S.pairingGen = body.generation;
    S.localClosed = false;
    if (body.open) S.deadline = performance.now() + body.remainingMs;
    if (wasOpen && !body.open) announce(COPY.closedNow);
    S.announcedLast = body.open ? body.remainingMs < 60_000 : false;
    renderPair();
  }

  function applyDevices(devices) {
    const before = S.devices;
    const previousIds = new Set((before || []).map((d) => d.id));
    S.devices = devices;
    if (!before) {
      S.order = sortDevices(devices).map((d) => d.id);
    } else {
      const fresh = devices.filter((d) => !previousIds.has(d.id));
      for (const d of fresh) S.arriving.add(d.id);
      S.order = stableOrder(S.order, devices);
      // A phone just paired: say so in the pairing view (section 5.4).
      if (fresh.length) {
        const newest = [...fresh].sort((a, b) => b.issuedAt - a.issuedAt)[0];
        S.banner = { name: displayName(newest) };
        if (S.view === "pair" || S.view === "first" || isWide()) announce(`${displayName(newest)} is paired. A new code is showing.`);
      }
    }
    if (S.renaming && !devices.some((d) => d.id === S.renaming.id)) S.renaming = null;
    // Removing the last phone shows the first-run layout, without reopening pairing.
    if (before && devices.length === 0 && S.view === "home" && !S.leaving.size) setView("first", { focus: false });
    if (S.confirming && !devices.some((d) => d.id === S.confirming.id) && !S.leaving.has(S.confirming.id)) S.confirming = null;
    renderPhones();
    renderPair();
  }

  function applyStatus(status) {
    S.status = status;
    S.offline = false;
    S.restarting = false;
    if (status.pairing.generation !== S.pairingGen) {
      S.pairingGen = status.pairing.generation;
      loadPairing();
    } else if (status.pairing.open) {
      S.deadline = performance.now() + status.pairing.remainingMs; // resync
    }
    if (status.devices.generation !== S.devicesGen) {
      S.devicesGen = status.devices.generation;
      loadDevices();
    }
    renderHeader();
    renderIdentity();
    renderBanners();
    renderComputer();
    renderNote();
  }

  // ---- live updates: SSE, polling after 3 failed reconnects (D8) ----
  let source = null;
  let failures = 0;
  let pollTimer = null;
  let paused = false;
  function connect() {
    if (paused || source || pollTimer) return;
    try {
      source = new EventSource("/api/host/events");
    } catch {
      startPolling();
      return;
    }
    source.addEventListener("status", (e) => {
      failures = 0;
      try { applyStatus(JSON.parse(e.data)); } catch { /* malformed */ }
    });
    source.addEventListener("error", () => {
      failures += 1;
      if (failures >= 3) {
        source.close();
        source = null;
        markOffline();
        startPolling();
      }
    });
  }
  function disconnect() {
    source?.close();
    source = null;
    clearInterval(pollTimer);
    pollTimer = null;
  }
  function startPolling() {
    if (pollTimer || paused) return;
    const tick = async () => {
      try {
        applyStatus(await api("/api/host/status"));
        // Back: try the event stream again.
        clearInterval(pollTimer);
        pollTimer = null;
        failures = 0;
        connect();
      } catch {
        markOffline();
      }
    };
    pollTimer = setInterval(tick, 2000);
  }
  function markOffline() {
    if (S.offline) return;
    S.offline = true;
    renderHeader();
  }

  // ---- countdown (local, resynced on every status) ----
  function remaining() {
    if (!S.pairing?.open || S.localClosed) return 0;
    return Math.max(0, S.deadline - performance.now());
  }
  setInterval(() => {
    if (!S.pairing?.open || S.localClosed) return;
    const left = remaining();
    if (left <= 0) {
      // Remove the code at once; the server's own close follows.
      S.localClosed = true;
      announce(COPY.closedNow);
      renderPair();
      return;
    }
    if (left < 60_000 && !S.announcedLast) {
      S.announcedLast = true;
      announce(COPY.closesSoon);
    }
    updateCountdown();
  }, 500);

  // ---- view changes ----
  function setView(view, { focus = true, direction = "fwd", animate = true } = {}) {
    const previous = S.view;
    S.view = view;
    main.dataset.view = view;
    root.classList.toggle("view-pair", view === "pair");
    if (animate && previous !== view && !isWide()) {
      const incoming = view === "home" ? $("col-home") : $("col-pair");
      incoming.classList.remove("entering-fwd", "entering-back");
      void incoming.offsetWidth;
      incoming.classList.add(direction === "back" ? "entering-back" : "entering-fwd");
      incoming.addEventListener("animationend", () => incoming.classList.remove("entering-fwd", "entering-back"), { once: true });
    }
    renderPair();
    renderPhones();
    if (focus) focusHeading();
  }
  function focusHeading() {
    const target = S.view === "pair" && !isWide() ? $("pair-heading") : S.view === "first" ? $("pair-title") : $("home-heading");
    target?.focus({ preventScroll: false });
  }
  function goPair() {
    S.banner = null;
    openPairing();
    if (!isWide()) setView("pair");
  }
  function goHome({ returnFocus = true } = {}) {
    S.banner = null;
    setView("home", { focus: false, direction: "back" });
    if (returnFocus) (isWide() ? $("home-heading") : $("pair-btn")).focus();
  }

  // ---- header ----
  function renderHeader() {
    const chip = $("chip");
    let state = chipState(S.status);
    let word = state === "attention" ? COPY.chip.attention : COPY.chip.running;
    let a11y = state === "attention" ? COPY.chipA11y.attention : COPY.chipA11y.running;
    if (S.restarting) { state = "busy"; word = COPY.chip.restarting; a11y = COPY.chipA11y.restarting; }
    else if (S.offline || !S.status) { state = "stopped"; word = COPY.chip.stopped; a11y = COPY.chipA11y.stopped; }
    if (!S.status && !S.offline) { state = "busy"; word = COPY.chip.starting; a11y = COPY.chip.starting; }
    chip.dataset.state = state;
    $("chip-text").textContent = word;
    $("chip-a11y").textContent = a11y;
    const anyMore = hasShell() && moreItems().length > 0;
    $("more-btn").hidden = !anyMore;
  }

  function moreItems() {
    const items = [];
    if (cap("openWindow") && container !== "window") items.push({ icon: "window", text: COPY.moreWindow, run: () => post({ type: "openWindow" }) });
    if (cap("logs")) items.push({ icon: "logs", text: COPY.moreLogs, run: () => post({ type: "openLogs" }) });
    if (cap("updates")) items.push({ icon: "dl", text: COPY.moreUpdates, run: () => post({ type: "checkUpdates" }) });
    if (cap("restart") || cap("quit")) items.push("sep");
    if (cap("restart")) items.push({ icon: "refresh", text: COPY.moreRestart, run: () => { S.restarting = true; renderHeader(); post({ type: "restart" }); } });
    if (cap("quit")) items.push({ icon: "power", text: COPY.moreQuit, run: () => post({ type: "quit" }) });
    while (items[0] === "sep") items.shift();
    return items;
  }

  // ---- identity ----
  function renderIdentity() {
    const s = S.status;
    if (!s) return;
    const heading = $("home-heading");
    heading.textContent = s.hostName;
    heading.title = s.hostName;
    const meta = $("ident-meta");
    const toggle = h("button", {
      type: "button", class: "h-link", "aria-expanded": String(S.detailsOpen), "aria-controls": "details",
      onclick: () => { S.detailsOpen = !S.detailsOpen; renderIdentity(); },
    }, COPY.details, icon("chev-d"));
    const parts = [];
    if (s.network.address) parts.push(h("span", { class: "h-mono", text: s.network.address }));
    if (s.platformName) parts.push(document.createTextNode(s.platformName));
    if (s.version) parts.push(document.createTextNode(`WinDock ${s.version}`));
    parts.push(toggle);
    const hadFocus = meta.contains(document.activeElement);
    meta.replaceChildren(...parts.flatMap((p, i) => (i ? [h("span", { class: "sep", "aria-hidden": "true", text: "·" }), p] : [p])));
    if (hadFocus) toggle.focus();

    const dl = $("details");
    dl.hidden = !S.detailsOpen;
    const rows = [];
    const copyBtn = (value, label) => h("button", {
      type: "button", class: "h-ib h-copy", "aria-label": `Copy ${label.toLowerCase()}`,
      onclick: (e) => copyText(value, e.currentTarget),
    }, icon("copy", "i base"), icon("check", "i ok"));
    if (s.network.endpoint) rows.push([COPY.detailsAddress, h("dd", {}, h("span", { text: s.network.endpoint }), copyBtn(s.network.endpoint, "Address"))]);
    if (s.network.secureEndpoint) rows.push([COPY.detailsSecure, h("dd", {}, h("span", { text: s.network.secureEndpoint }), copyBtn(s.network.secureEndpoint, "Secure address"))]);
    if (s.network.others?.length) rows.push([COPY.detailsOthers, h("dd", { text: s.network.others.map(otherAddressText).join(", ") })]);
    rows.push([COPY.detailsOlder, h("dd", { class: "plain", text: s.plainHttp ? COPY.olderOn : COPY.olderOff })]);
    if (s.version) rows.push([COPY.detailsVersion, h("dd", { class: "plain", text: `WinDock ${s.version}${s.platformName ? ` on ${s.platformName}` : ""}` })]);
    dl.replaceChildren(...rows.flatMap(([term, dd]) => [h("dt", { text: term }), dd]));
  }

  async function copyText(value, button) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    button.classList.add("copied");
    clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(() => button.classList.remove("copied"), 1500);
    announce(COPY.copied);
  }

  // ---- banners (Home): problem → recording → update ----
  let shownProblem = null;
  function renderBanners() {
    const slot = $("banner-slot");
    const s = S.status;
    if (!s) return slot.replaceChildren();
    let banner = null;
    let problem = null;
    if (s.firewall === "blocked") {
      problem = "firewall";
      banner = h("div", { class: "h-ban bad", role: shownProblem === problem ? null : "alert" }, icon("shield"),
        h("div", { class: "txt" }, h("div", { class: "ttl", text: COPY.banFirewallTitle }), h("p", { class: "h-p", text: COPY.banFirewallBody }),
          cap("firewallSettings") ? h("div", { class: "h-btns" }, h("button", { type: "button", class: "h-btn sm", text: COPY.banFirewallAction, onclick: () => post({ type: "openFirewallSettings" }) })) : null));
    } else if (!s.network.address) {
      problem = "noaddr";
      banner = h("div", { class: "h-ban bad", role: shownProblem === problem ? null : "alert" }, icon("wifi-off"),
        h("div", { class: "txt" }, h("div", { class: "ttl", text: COPY.banNoaddrTitle }),
          h("p", { class: "h-p", text: `Phones can’t reach ${s.hostName} until it joins Wi-Fi or Ethernet.` })));
    } else if (s.capture?.phase === "recording") {
      banner = h("div", { class: "h-ban", role: "status" }, h("span", { class: "rec", "aria-hidden": "true" }),
        h("div", { class: "txt" }, h("div", { class: "ttl", text: COPY.banRecTitle }), h("p", { class: "h-c", text: COPY.banRecBody })),
        h("button", { type: "button", class: "h-btn sm side", text: COPY.banRecAction, onclick: () => api("/api/capture/stop", { method: "POST" }).catch(() => {}) }));
    } else if (S.update?.state === "available" && !S.updateDismissed) {
      banner = h("div", { class: "h-ban" }, icon("dl"),
        h("div", { class: "txt" }, h("div", { class: "ttl", text: `WinDock ${S.update.version} is available` }),
          h("p", { class: "h-c", text: COPY.banUpdateBody.replace("{installed}", s.version || "") }),
          h("div", { class: "h-btns" },
            h("button", { type: "button", class: "h-btn sm", text: COPY.banUpdateAction, onclick: () => post({ type: "openUpdate" }) }),
            h("button", { type: "button", class: "h-btn ghost sm", text: COPY.banUpdateLater, onclick: () => { S.updateDismissed = true; renderBanners(); } }))));
    }
    shownProblem = problem;
    const key = banner ? banner.textContent : "";
    if (slot.dataset.key === key) return; // unchanged: keep it (no re-animation)
    slot.dataset.key = key;
    slot.replaceChildren(...(banner ? [banner] : []));
  }

  // ---- pairing column ----
  function renderPair() {
    const p = S.pairing;
    const s = S.status;
    const first = S.view === "first";
    $("pair-title").textContent = first ? COPY.firstTitle : COPY.pair;

    // Success banner after a pairing.
    const bannerSlot = $("pair-banner-slot");
    if (S.banner && (S.view !== "home" || isWide())) {
      const key = `paired:${S.banner.name}`;
      if (bannerSlot.dataset.key !== key) {
        bannerSlot.dataset.key = key;
        bannerSlot.replaceChildren(h("div", { class: "h-ban ok", role: "status" }, icon("check"),
          h("div", { class: "txt" }, h("div", { class: "ttl", text: `${S.banner.name} is paired` }), h("p", { class: "h-c", text: COPY.pairedBody })),
          h("button", { type: "button", class: "h-btn sm side", text: COPY.done, onclick: onDone })));
      }
    } else if (bannerSlot.dataset.key) {
      bannerSlot.dataset.key = "";
      bannerSlot.replaceChildren();
    }

    const body = $("pair-body");
    if (!p) return body.replaceChildren();
    const open = p.open && !S.localClosed;
    const tlsOn = Boolean(s ? s.tls : p.securityCode);

    if (!open) {
      const reason = S.localClosed ? "timeout" : p.closedReason;
      // Wide layout, closed normally: the card offers the button (section 3.3).
      if (isWide() && !first && (reason === "timeout" || reason === "stopped" || !reason)) {
        const key = "wide-closed";
        if (body.dataset.key === key) return;
        body.dataset.key = key;
        return body.replaceChildren(h("button", { type: "button", class: "h-btn primary block", onclick: goPair }, icon("qr"), COPY.pair));
      }
      const key = `closed:${reason}:${tlsOn}:${first}`;
      if (body.dataset.key === key) return;
      body.dataset.key = key;
      const name = s?.hostName || "this computer";
      const variants = {
        budget: { glyph: "shield", warn: true, tile: COPY.closedTile, title: COPY.budgetTitle, text: COPY.budgetBody, actions: [[COPY.budgetOpen, "primary", openPairing], [COPY.budgetReview, "", () => (isWide() ? $("home-heading").focus() : goHome())]] },
        "no-address": { glyph: "wifi-off", tile: COPY.noaddrTile, title: COPY.noaddrTitle, text: `Phones need ${name} on the same Wi-Fi or Ethernet.`, actions: [] },
        stopped: { glyph: "clock", tile: COPY.closedTile, title: COPY.closedTitle, text: COPY.closedStopped, actions: [[COPY.closedOpen, "primary", openPairing]] },
        timeout: { glyph: "clock", tile: COPY.closedTile, title: COPY.closedTitle, text: COPY.closedTimeout, actions: [[COPY.closedOpen, "primary", openPairing]] },
      };
      const v = variants[reason] || variants.timeout;
      return body.replaceChildren(
        tlsOn ? h("div", { class: "h-qr-wrap" }, h("div", { class: "h-qr closed" }, h("span", { class: `h-gl lg${v.warn ? " warn" : ""}` }, icon(v.glyph)), h("p", { class: "h-c", text: v.tile }))) : null,
        h("p", { class: "h-t h-closed-title", text: v.title }),
        h("p", { class: "h-p h-closed-body", text: v.text }),
        v.actions.length ? h("div", { class: "h-btns h-closed-actions" }, v.actions.map(([text, kind, run]) => h("button", { type: "button", class: `h-btn ${kind}`, text, onclick: run }))) : null,
      );
    }

    const key = `open:${p.generation}:${p.pin}:${p.address}:${first}:${tlsOn}`;
    if (body.dataset.key === key) return updateCountdown();
    body.dataset.key = key;
    const children = [];
    if (p.qr) {
      const dim = (p.qr.size + 8) * 4; // 4 CSS px per module, quiet zone included
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", `-4 -4 ${p.qr.size + 8} ${p.qr.size + 8}`);
      svg.setAttribute("width", String(dim));
      svg.setAttribute("height", String(dim));
      svg.setAttribute("aria-hidden", "true");
      const bg = document.createElementNS(NS, "rect");
      for (const [k, val] of Object.entries({ x: -4, y: -4, width: p.qr.size + 8, height: p.qr.size + 8, fill: "#FFFFFF" })) bg.setAttribute(k, String(val));
      const path = document.createElementNS(NS, "path");
      path.setAttribute("fill", "#090E10");
      path.setAttribute("d", p.qr.path);
      svg.append(bg, path);
      children.push(h("div", { class: "h-qr-wrap" }, h("div", { class: "h-qr", role: "img", "aria-label": COPY.qrLabel }, svg)));
      if (!first) children.push(h("p", { class: "h-c h-scan-cap", html: COPY.pairScan }));
    }
    children.push(h("div", { class: "h-count", id: "countdown" }, icon("clock"), h("span", { class: "grow", id: "count-text" }), h("button", { type: "button", class: "h-btn ghost sm", id: "count-action" })));
    children.push(h("h3", { class: "h-sec", text: COPY.manual }));
    if (!tlsOn) children.push(h("p", { class: "h-c h-note-cap", text: COPY.notls }));
    const pin = pinParts(p.pin);
    const rows = [];
    if (p.address) {
      rows.push(h("div", { class: "h-kv" }, h("span", { class: "k", text: COPY.address }), h("span", { class: "v", text: p.address }),
        h("button", { type: "button", class: "h-ib h-copy", "aria-label": "Copy address", onclick: (e) => copyText(p.address, e.currentTarget) }, icon("copy", "i base"), icon("check", "i ok"))));
    }
    if (tlsOn && p.securityCode) {
      const code = securityCodeParts(p.securityCode);
      const v = h("span", { class: "v", "aria-label": code.label, role: "text" });
      code.groups.forEach((g, i) => { if (i) v.append(h("span", { class: "dash", "aria-hidden": "true", text: "-" })); v.append(document.createTextNode(g)); });
      rows.push(h("div", { class: "h-kv" }, h("span", { class: "k", text: COPY.code }), v));
    }
    rows.push(h("div", { class: "h-kv" }, h("span", { class: "k", text: COPY.pin }),
      h("span", { class: "v pin", "aria-label": pin.label, role: "text" }, pin.head, h("span", { class: "gap", "aria-hidden": "true" }), pin.tail)));
    children.push(h("div", { class: "h-group" }, rows));
    children.push(h("p", { class: "h-c h-pair-note", text: COPY.note }));
    body.replaceChildren(...children);
    updateCountdown();
  }

  function onDone() {
    S.banner = null;
    if (S.view === "first" || S.view === "pair") goHome();
    else renderPair();
  }

  function updateCountdown() {
    const text = $("count-text");
    const action = $("count-action");
    if (!text || !action) return;
    const c = countdownState(remaining());
    const label = `${c.lead}${c.strong}`;
    if (text.dataset.label !== label) {
      text.dataset.label = label;
      text.replaceChildren(document.createTextNode(c.lead), h("b", { text: c.strong }));
    }
    const want = c.action === "keep" ? "keep" : "stop";
    if (action.dataset.kind !== want) {
      action.dataset.kind = want;
      action.textContent = want === "keep" ? COPY.keep : COPY.stop;
      action.onclick = want === "keep" ? openPairing : stopPairing;
    }
  }

  // ---- paired phones ----
  function renderPhones() {
    const wrap = $("phones");
    const devices = S.devices;
    if (!devices) return;
    // Never rebuild the list under a rename field that has focus (it would
    // lose what was typed); render once the rename ends.
    const field = S.renaming && wrap.querySelector(`[data-device="${S.renaming.id}"] input`);
    if (field && document.activeElement === field) {
      S.phonesDirty = true;
      return;
    }
    S.phonesDirty = false;
    const byId = new Map(devices.map((d) => [d.id, d]));
    const ids = S.order.filter((id) => byId.has(id) || S.leaving.has(id));
    if (!ids.length) {
      wrap.replaceChildren();
      return;
    }
    const activeId = document.activeElement?.closest?.("[data-device]")?.dataset.device;
    const activeRole = document.activeElement?.dataset?.role;
    const list = h("ul", { class: "h-list" });
    for (const id of ids) {
      const d = byId.get(id) || S.leavingData.get(id);
      if (!d) continue;
      list.append(phoneRow(d));
    }
    const count = devices.length;
    wrap.replaceChildren(
      h("h2", { class: "h-sec" }, COPY.phonesTitle, h("span", { class: "n", text: String(count) })),
      h("div", { class: "h-group" }, list),
      count >= 2 ? h("div", { class: "h-foot-act" }, h("button", { type: "button", class: "h-btn ghost sm muted", id: "remove-all-btn", text: COPY.removeAll, onclick: openRemoveAll })) : null,
    );
    S.arriving.clear();
    // Keep focus where it was across a re-render.
    if (activeId) {
      const el = wrap.querySelector(`[data-device="${activeId}"] [data-role="${activeRole}"]`) || wrap.querySelector(`[data-device="${activeId}"] [data-role="more"]`);
      el?.focus();
    }
    if (S.renaming) {
      const field = wrap.querySelector(`[data-device="${S.renaming.id}"] input`);
      if (field && document.activeElement !== field && !S.renaming.focused) {
        S.renaming.focused = true;
        field.focus();
        field.select();
      }
    }
    if (S.confirming && !S.confirming.focused) {
      S.confirming.focused = true;
      wrap.querySelector(`[data-device="${S.confirming.id}"] [data-role="cancel"]`)?.focus();
    }
  }

  function phoneRow(d) {
    const name = displayName(d);
    const li = h("li", { class: `h-li${S.arriving.has(d.id) ? " arriving" : ""}${S.leaving.has(d.id) ? " leaving" : ""}`, "data-device": d.id });
    const descId = `desc-${d.id}`;
    const caption = deviceCaption(d);
    const desc = `${caption.connected ? `${COPY.connected}. ` : ""}Paired ${longDateTime(d.issuedAt)}.${d.lastSeenAt > d.issuedAt ? ` Last seen ${longDateTime(d.lastSeenAt)}.` : ""}${d.label ? ` The phone calls itself ${d.name}.` : ""}`;

    if (S.confirming?.id === d.id) {
      const row = h("div", { class: "h-row danger-zone" }, h("span", { class: "h-gl warn" }, icon("phone")),
        h("div", { class: "txt" },
          h("div", { class: "ttl", text: `Remove ${name}?` }),
          h("div", { class: "sub wrap", text: d.connected ? COPY.removeConnected : COPY.removeBody }),
          S.confirming.error ? h("p", { class: "h-err", role: "alert", text: S.confirming.error }) : null,
          h("div", { class: "h-btns" },
            h("button", { type: "button", class: "h-btn sm", "data-role": "cancel", text: COPY.cancel, onclick: () => { S.confirming = null; renderPhones(); focusMore(d.id); } }),
            h("button", { type: "button", class: "h-btn sm danger", "data-role": "confirm", text: COPY.removeConfirm, onclick: () => removeDevice(d.id) }))));
      row.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); S.confirming = null; renderPhones(); focusMore(d.id); } });
      li.append(row);
      return li;
    }

    if (S.renaming?.id === d.id) {
      const input = h("input", { class: "h-field", type: "text", maxlength: "40", value: d.label || d.name, "aria-label": `Name for ${name}`, "aria-describedby": `hint-${d.id}`, "data-role": "field", spellcheck: "false", autocomplete: "off" });
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        if (save) saveLabel(d, input.value);
        else { S.renaming = null; input.blur(); renderPhones(); focusMore(d.id); }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true));
      li.append(h("div", { class: "h-row" }, h("span", { class: `h-gl${d.connected ? " on" : ""}` }, icon("phone")),
        h("div", { class: "txt" }, input,
          S.renaming.error ? h("p", { class: "h-err", role: "alert", text: S.renaming.error }) : null,
          h("p", { class: "h-c rename-hint", id: `hint-${d.id}`, text: `Only this computer uses this name. Leave it empty to use “${d.name}”.` }))));
      return li;
    }

    const sub = h("div", { class: "sub", "aria-hidden": "true" });
    if (caption.connected) sub.append(h("span", { class: "dot" }));
    sub.append(h("span", { text: caption.first }), h("span", { class: "sep", text: "·" }), h("span", { class: "ell", text: caption.second }));
    const more = h("button", {
      type: "button", class: "h-ib", "aria-label": `More for ${name}`, "aria-haspopup": "menu", "aria-expanded": "false", "data-role": "more",
      onclick: (e) => openRowMenu(d, e.currentTarget),
    }, icon("more"));
    more.addEventListener("keydown", (e) => {
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); openRowMenu(d, more); }
    });
    const row = h("div", { class: "h-row phone", title: `${name}\n${desc}` },
      h("span", { class: `h-gl${d.connected ? " on" : ""}` }, icon("phone")),
      h("div", { class: "txt" }, h("div", { class: "ttl", text: name }), sub, h("span", { class: "vh", id: descId, text: `${caption.first}. ${caption.second}. ${desc}` })),
      more);
    more.setAttribute("aria-describedby", descId);
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); openRowMenu(d, more); });
    li.append(row);
    return li;
  }

  function focusMore(id) {
    $("phones").querySelector(`[data-device="${id}"] [data-role="more"]`)?.focus();
  }

  async function saveLabel(d, value) {
    if (document.activeElement?.dataset?.role === "field") document.activeElement.blur();
    const label = labelToSend(value);
    const current = d.label || null;
    // Typing the phone's own name back means "no label".
    const next = label === d.name ? null : label;
    if (next === current) {
      S.renaming = null;
      renderPhones();
      focusMore(d.id);
      return;
    }
    try {
      const res = await api(`/api/devices/${d.id}`, { method: "PATCH", body: { label: next } });
      d.label = res.label;
      S.renaming = null;
      renderPhones();
      focusMore(d.id);
    } catch {
      S.renaming = { id: d.id, error: COPY.renameError, focused: false };
      renderPhones();
    }
  }

  async function removeDevice(id) {
    const ids = S.order.filter((x) => S.devices.some((d) => d.id === x));
    const index = ids.indexOf(id);
    try {
      await api(`/api/devices/${id}`, { method: "DELETE" });
    } catch {
      S.confirming = { id, error: COPY.removeError, focused: false };
      renderPhones();
      return;
    }
    S.confirming = null;
    const nextFocus = ids[index + 1] || ids[index - 1] || null;
    const finish = () => {
      S.leaving.delete(id);
      S.devices = S.devices.filter((d) => d.id !== id);
      S.order = S.order.filter((x) => x !== id);
      renderPhones();
      if (S.devices.length === 0) setView("first", { focus: false });
      if (nextFocus) focusMore(nextFocus);
      else (S.view === "first" ? $("pair-title") : $("pair-btn")).focus();
    };
    const li = $("phones").querySelector(`[data-device="${id}"]`);
    const device = S.devices.find((d) => d.id === id);
    if (!li || !device || reduceMotion()) return finish();
    // Fade the row (120 ms), then close the gap (180 ms). A re-render in the
    // meantime keeps drawing it from leavingData.
    S.leaving.add(id);
    S.leavingData.set(id, device);
    li.replaceChildren(...phoneRow(device).childNodes);
    li.classList.add("leaving");
    setTimeout(() => {
      $("phones").querySelector(`[data-device="${id}"]`)?.classList.add("collapsing");
      setTimeout(() => { S.leavingData.delete(id); finish(); }, 190);
    }, 120);
  }

  // ---- remove all ----
  function openRemoveAll() {
    const dialog = $("remove-all");
    const n = S.devices.length;
    $("ra-title").textContent = `Remove all ${n} phones?`;
    $("ra-error").hidden = true;
    dialog.showModal();
    $("ra-cancel").focus();
  }
  $("ra-cancel").addEventListener("click", () => { $("remove-all").close(); $("remove-all-btn")?.focus(); });
  $("ra-confirm").addEventListener("click", async () => {
    try {
      await api("/api/devices", { method: "DELETE" });
    } catch {
      $("ra-error").textContent = COPY.removeError;
      $("ra-error").hidden = false;
      return;
    }
    $("remove-all").close();
    S.devices = [];
    S.order = [];
    renderPhones();
    setView("first");
  });
  $("remove-all").addEventListener("cancel", () => setTimeout(() => $("remove-all-btn")?.focus(), 0));

  // ---- menus (row menu, ⋯ menu): roving focus ----
  let menuOwner = null;
  function openMenu(items, trigger) {
    closeMenu(false);
    const menu = $("menu");
    menu.replaceChildren(...items.map((item) => (item === "sep"
      ? h("hr", { role: "separator" })
      : h("button", { type: "button", role: "menuitem", tabindex: "-1", class: item.danger ? "destr" : null, onclick: () => { closeMenu(true); item.run(); } }, icon(item.icon), item.text))));
    menu.hidden = false;
    menu.classList.remove("closing");
    const r = trigger.getBoundingClientRect();
    const mw = Math.max(168, menu.offsetWidth);
    menu.style.setProperty("top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("left", `${Math.round(Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)))}px`);
    const mh = menu.offsetHeight;
    if (r.bottom + 4 + mh > window.innerHeight - 8 && r.top - 4 - mh > 8) {
      menu.style.setProperty("top", `${Math.round(r.top - 4 - mh)}px`);
      menu.style.setProperty("transform-origin", "bottom right");
    } else {
      menu.style.setProperty("transform-origin", "top right");
    }
    menuOwner = trigger;
    trigger.setAttribute("aria-expanded", "true");
    menu.querySelector("[role=menuitem]")?.focus();
  }
  function closeMenu(returnFocus = true) {
    const menu = $("menu");
    if (menu.hidden) return;
    const owner = menuOwner;
    menuOwner = null;
    owner?.setAttribute("aria-expanded", "false");
    if (reduceMotion()) menu.hidden = true;
    else {
      menu.classList.add("closing");
      setTimeout(() => { if (!menuOwner) menu.hidden = true; }, 100);
    }
    if (returnFocus && owner?.isConnected) owner.focus();
  }
  $("menu").addEventListener("keydown", (e) => {
    const items = [...$("menu").querySelectorAll("[role=menuitem]")];
    const i = items.indexOf(document.activeElement);
    const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      items[(move + items.length) % items.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === "Tab") {
      e.preventDefault();
      closeMenu(true);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!$("menu").hidden && !$("menu").contains(e.target) && e.target !== menuOwner && !menuOwner?.contains(e.target)) closeMenu(false);
  });
  function openRowMenu(d, trigger) {
    if (menuOwner === trigger) return closeMenu(true);
    openMenu([
      { icon: "pencil", text: COPY.rename, run: () => { S.confirming = null; S.renaming = { id: d.id, error: null, focused: false }; renderPhones(); } },
      { icon: "close", text: COPY.remove, danger: true, run: () => { S.renaming = null; S.confirming = { id: d.id, error: null, focused: false }; renderPhones(); } },
    ], trigger);
  }
  $("more-btn").addEventListener("click", (e) => {
    if (menuOwner === e.currentTarget) return closeMenu(true);
    openMenu(moreItems(), e.currentTarget);
  });

  // ---- this computer ----
  function renderComputer() {
    const s = S.status;
    if (!s) return;
    const rows = [];
    const loginState = S.login?.state;
    if (hasShell() && cap("loginItem") && loginState && loginState !== "unavailable") {
      const on = loginState === "on" || loginState === "requiresApproval";
      const label = os === "windows" ? COPY.loginWin : COPY.loginMac;
      const capId = "login-cap";
      const sw = h("button", {
        type: "button", class: "h-sw", role: "switch", "aria-checked": String(on), "aria-labelledby": "login-ttl",
        "aria-describedby": loginState === "requiresApproval" ? capId : null, "aria-busy": S.loginBusy ? "true" : null,
        onclick: () => { S.loginBusy = true; post({ type: "loginItem.set", enabled: !on }); renderComputer(); },
      });
      rows.push(h("div", { class: "h-row" }, h("span", { class: "h-gl" }, icon("power")),
        h("div", { class: "txt" }, h("div", { class: "ttl", id: "login-ttl", text: label }),
          loginState === "requiresApproval"
            ? h("div", { class: "sub wrap", id: capId }, `${COPY.loginPending} `, h("button", { type: "button", class: "h-link", text: COPY.loginOpenSettings, onclick: () => post({ type: "loginItem.openSettings" }) }))
            : null),
        sw));
    }
    rows.push(h("div", { class: "h-row" }, h("span", { class: "h-gl" }, icon("net")),
      h("div", { class: "txt" }, h("div", { class: "ttl", text: COPY.netTitle }), h("div", { class: "sub wrap", text: discoveryCaption(s.discovery) }))));
    const box = $("computer");
    const hadFocus = box.contains(document.activeElement) ? document.activeElement.getAttribute("role") : null;
    box.replaceChildren(...rows);
    if (hadFocus === "switch") box.querySelector("[role=switch]")?.focus();
  }

  function renderNote() {
    const slot = $("note-slot");
    if (hasShell() || !S.status) return slot.replaceChildren();
    const text = browserNote(S.status.shell, os);
    if (slot.dataset.key === text) return;
    slot.dataset.key = text;
    slot.replaceChildren(h("div", { class: "h-note" }, icon(S.status.shell ? "info" : "terminal"), h("p", { class: "h-c", text })));
  }

  // ---- keyboard ----
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w" && hasShell()) {
      e.preventDefault();
      post({ type: "close" });
      return;
    }
    if (e.key === "Escape") {
      if (!$("menu").hidden) { closeMenu(true); return; }
      if ($("remove-all").open) return; // the dialog handles it
      if (S.renaming || S.confirming) return; // handled by the row
      if (S.view === "pair" && !isWide()) { e.preventDefault(); goHome(); return; }
      if (hasShell()) post({ type: "close" });
      return;
    }
    // Focus wraps inside the popover and flyout.
    if (e.key === "Tab" && (container === "popover" || container === "flyout") && !$("remove-all").open) {
      const focusables = [...root.querySelectorAll("button, input, [href], [tabindex]:not([tabindex='-1'])")]
        .filter((el) => !el.disabled && el.offsetParent !== null && !el.closest("[hidden]"));
      if (!focusables.length) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
      else if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    }
  });

  $("pair-btn").addEventListener("click", goPair);
  $("back-btn").addEventListener("click", () => goHome());

  // ---- shell bridge (section 13.5) ----
  window.addEventListener("windockshell", (e) => {
    const detail = e.detail || {};
    if (detail.type === "loginItem") {
      S.login = { state: detail.state };
      S.loginBusy = false;
      renderComputer();
    } else if (detail.type === "update") {
      S.update = { state: detail.state, version: detail.version };
      renderBanners();
    } else if (detail.type === "visibility") {
      if (detail.visible) {
        paused = false;
        // The list order refreshes on the next open.
        if (S.devices) S.order = sortDevices(S.devices).map((d) => d.id);
        renderPhones();
        connect();
      } else {
        paused = true;
        closeMenu(false);
        disconnect();
      }
    } else if (detail.type === "navigate" && detail.view === "pair") {
      goPair();
    }
  });

  if (hasShell()) {
    let frame = 0;
    let lastHeight = 0;
    const frameEl = $("frame");
    new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const height = Math.round(frameEl.getBoundingClientRect().height);
        if (height !== lastHeight) {
          lastHeight = height;
          post({ type: "resize", height });
        }
      });
    }).observe(frameEl);
  }

  // Re-render layout-dependent pieces when crossing the wide breakpoint.
  let wasWide = isWide();
  new ResizeObserver(() => {
    const wide = isWide();
    if (wide === wasWide) return;
    wasWide = wide;
    $("pair-body").dataset.key = "";
    renderPair();
  }).observe(root);

  // ---- start ----
  async function init() {
    renderHeader();
    let status = null;
    try {
      status = await api("/api/host/status");
    } catch {
      S.offline = true;
      renderHeader();
      startPolling();
      return;
    }
    let devices = [];
    try { devices = (await api("/api/devices")).devices; } catch { devices = []; }
    S.devicesGen = status.devices.generation;
    applyDevices(devices);
    S.pairingGen = status.pairing.generation;
    if (devices.length === 0) {
      setView("first", { focus: false, animate: false });
      // D1: with no phones paired, opening the page opens pairing.
      if (status.pairing.closedReason !== "no-address") {
        try {
          applyPairing(await api("/api/host/pairing/open", { method: "POST" }));
        } catch {
          await loadPairing();
        }
      } else {
        await loadPairing();
      }
    } else {
      await loadPairing();
    }
    applyStatus(S.pairing ? { ...status, pairing: { ...status.pairing, generation: S.pairing.generation } } : status);
    focusHeading();
    connect();
    post({ type: "ready" });
  }
  init();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startPage, { once: true });
  else startPage();
}
