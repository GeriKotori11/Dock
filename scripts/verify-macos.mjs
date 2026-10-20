/**
 * macOS provider oracle: inventory/running parsing, stable ids, exact argv for
 * every action, constant scripts, icon guards and contract conformance.
 * Runs on any OS: all OS work goes through a recording fake exec.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import { contractViolations } from "../src/platform/contract.js";
import { createProvider, PROVIDERS } from "../src/platform/index.js";
import {
  createMacProvider,
  parseInventory,
  parseRunning,
  launchArgv,
  macAppId,
  validBundleId,
  validAppPath,
  defaultAppDirs,
  osascriptArgv,
  INVENTORY_JXA,
  ICON_JXA,
  RUNNING_JXA,
  FOCUS_JXA,
  CLOSE_JXA,
  OSASCRIPT,
  OPEN,
  ICON_MAX_BYTES,
} from "../src/platform/macos.js";

const t = createChecker("macos");
const FIXTURES = join(import.meta.dirname, "..", "test", "fixtures");
const inventoryRaw = readFileSync(join(FIXTURES, "macos-inventory.json"), "utf8");
const runningRaw = readFileSync(join(FIXTURES, "macos-running.json"), "utf8");

function recorder(stdout = "") {
  const calls = [];
  return {
    calls,
    exec: async (file, args) => {
      calls.push({ file, args });
      return { stdout: typeof stdout === "function" ? stdout(file, args) : stdout, stderr: "" };
    },
  };
}

// ---- registration and contract ----
t.equal(PROVIDERS.darwin, createMacProvider, "darwin maps to createMacProvider");
const registered = createProvider({ os: "darwin", exec: recorder().exec });
t.deepEqual(contractViolations(registered), [], "macOS provider satisfies the contract");
t.equal(registered.id, "macos", "provider id");
t.equal(registered.displayName, "macOS", "provider display name");
t.deepEqual(registered.features, { controls: false, nowPlaying: false }, "features declared");
t.ok(Object.isFrozen(registered.features), "features is frozen");
t.equal(registered.control.length, 2, "control keeps arity 2");
t.throws(() => createMacProvider({ exec: null }), "provider without exec throws");

// ---- constant scripts ----
const SCRIPTS = { INVENTORY_JXA, ICON_JXA, RUNNING_JXA, FOCUS_JXA, CLOSE_JXA };
for (const [name, script] of Object.entries(SCRIPTS)) {
  t.ok(typeof script === "string" && script.includes("function run(argv)"), `${name} defines run(argv)`);
  t.ok(!script.includes("${"), `${name} contains no template interpolation`);
  t.ok(!script.includes("`"), `${name} contains no backticks`);
}
t.ok(!/\bforceTerminate\b|\bkill\b/.test(CLOSE_JXA), "close script never force-terminates");
t.ok(CLOSE_JXA.includes("terminate"), "close script uses polite terminate");
t.ok(FOCUS_JXA.includes("activateWithOptions"), "focus script activates the app");
t.ok(RUNNING_JXA.includes("activationPolicy) !== 0"), "running script keeps regular apps only");
t.ok(!/TIFFRepresentation/.test(ICON_JXA), "icon script draws a fixed bitmap, not the multi-rep TIFF");
t.deepEqual(osascriptArgv("S", ["a"]), ["-l", "JavaScript", "-e", "S", "--", "a"], "osascript argv ends options before data");

// ---- parseInventory ----
const apps = parseInventory(inventoryRaw);
const byName = Object.fromEntries(apps.map((a) => [a.name, a]));
t.equal(apps.length, 10, "inventory keeps the ten valid, non-background-only, unique apps");
t.equal(byName.Safari?.id, "com.apple.Safari", "bundle id becomes the stable id");
t.equal(byName.Safari?.target, "/Applications/Safari.app", "first directory wins on duplicate id");
t.ok(!byName["Safari (user copy)"], "~/Applications duplicate is dropped");
t.equal(byName["Unsigned Tool"]?.id, "path:/applications/unsigned tool.app", "missing bundle id falls back to lowercased path id");
t.equal(byName["Unsigned Tool"]?.bundleId, null, "path-id app has null bundleId");
t.equal(byName["Bad Id"]?.id, "path:/applications/bad id.app", "invalid bundle id (space) falls back to path id");
t.equal(byName["Bad Id"]?.bundleId, null, "invalid bundle id is not kept");
t.equal(byName["Dash Id"]?.id, "path:/applications/dash id.app", "bundle id starting with '-' falls back to path id");
t.equal(byName["Menu Agent"]?.id, "com.docker.docker", "menu-bar (LSUIElement) app stays in the catalog");
t.ok(!byName["Background Daemon"], "LSBackgroundOnly app is skipped");
t.equal(byName["Image Capture"]?.id, "com.apple.Image_Capture", "bundle id with '_' is the stable id");
t.equal(byName["Image Capture"]?.bundleId, "com.apple.Image_Capture", "bundle id with '_' is kept");
t.ok(INVENTORY_JXA.includes("LSBackgroundOnly"), "inventory script reads LSBackgroundOnly");
t.ok(!INVENTORY_JXA.includes("LSUIElement"), "inventory script no longer filters LSUIElement apps");
t.ok(INVENTORY_JXA.includes("backgroundOnly:"), "inventory script emits backgroundOnly");
t.ok(!byName.Relative, "relative path is skipped");
t.ok(!byName["Not An App"], "non-.app path is skipped");
t.ok(!byName["No Path"], "row without path is skipped");
t.ok(!apps.some((a) => a.target === "/Applications/NoName.app"), "row without name is skipped");
t.equal(byName["Microsoft Word"]?.target, "/Applications/Microsoft Office/Microsoft Word.app", "one-level subfolder entry is present");
t.deepEqual(
  apps.map((a) => a.name),
  ["Activity Monitor", "Bad Id", "Calculator", "Dash Id", "Image Capture", "Menu Agent", "Microsoft Word", "Safari", "Unsigned Tool", "zed"],
  "inventory is sorted by name, case-insensitively",
);
t.deepEqual(
  byName.Calculator,
  { id: "com.apple.calculator", name: "Calculator", target: "/System/Applications/Calculator.app", args: "", icon: "", source: "bundle", bundleId: "com.apple.calculator" },
  "record shape keeps target/icon keys",
);
t.equal(new Set(apps.map((a) => a.id)).size, apps.length, "ids are unique");
t.deepEqual(parseInventory(""), [], "empty output parses to []");
t.deepEqual(parseInventory("not json"), [], "garbage output parses to []");
t.deepEqual(parseInventory('{"name":"x"}'), [], "non-array output parses to []");

// ---- parseRunning ----
const running = parseRunning(runningRaw);
t.deepEqual(running.map((r) => r.pid), [77, 300, 411, 512, 902], "valid pids kept, deduped and sorted");
const runById = Object.fromEntries(running.map((r) => [r.pid, r]));
t.equal(runById[902].id, byName.Safari.id, "running Safari id matches inventory id");
t.equal(runById[411].id, byName["Unsigned Tool"].id, "running path-id app matches inventory id");
t.equal(runById[512].id, byName["Bad Id"].id, "running invalid-bundle-id app matches inventory path id");
t.equal(runById[300].id, byName["Image Capture"].id, "running '_' bundle id matches inventory id");
t.equal(runById[77].id, byName["Microsoft Word"].id, "running subfolder app matches inventory id");
t.deepEqual(
  runById[902],
  { id: "com.apple.Safari", name: "Safari", title: "", pid: 902, handle: 0, path: "/Applications/Safari.app", bundleId: "com.apple.Safari" },
  "running record shape",
);
t.equal(runById[902].name, "Safari", "first row wins on duplicate pid");
t.deepEqual(parseRunning("[]"), [], "empty running list");
t.equal(macAppId("com.x", "/A.app"), "com.x", "macAppId prefers bundle id");
t.equal(macAppId("bad id", "/A.app"), "path:/a.app", "macAppId falls back to path");
t.equal(macAppId(null, "rel.app"), null, "macAppId rejects relative path");

// ---- validators ----
for (const bad of ["-b", "-oops", "-foo", "_foo", ".foo", "com.example bad", "com.x\nrm", "com.x;rm", "", "a".repeat(256), null, 42]) {
  t.equal(validBundleId(bad), null, `bundle id rejected: ${JSON.stringify(bad)}`);
}
t.equal(validBundleId("com.apple.calculator"), "com.apple.calculator", "valid bundle id accepted");
t.equal(validBundleId("com.apple.Image_Capture"), "com.apple.Image_Capture", "bundle id with '_' accepted");
for (const bad of ["Applications/X.app", "./X.app", "/Applications/X", "/Applications/X.exe", "/A/../X.app", "/A/X.app\n", null]) {
  t.equal(validAppPath(bad), null, `app path rejected: ${JSON.stringify(bad)}`);
}

// ---- launch ----
let rec = recorder();
let mac = createMacProvider({ exec: rec.exec, appDirs: ["/Applications"] });
await mac.launchApp({ bundleId: "com.apple.calculator", target: "/System/Applications/Calculator.app" });
t.deepEqual(rec.calls[0], { file: OPEN, args: ["-b", "com.apple.calculator"] }, "launch by bundle id is open -b <id>");
await mac.launchApp({ bundleId: null, target: "/Applications/Unsigned Tool.app" });
t.deepEqual(rec.calls[1], { file: OPEN, args: ["/Applications/Unsigned Tool.app"] }, "launch by path passes the path as one argv entry");
await mac.launchApp({ bundleId: "-a", target: "/Applications/Dash Id.app" });
t.deepEqual(rec.calls[2].args, ["/Applications/Dash Id.app"], "bundle id starting with '-' is never passed; path used instead");
await mac.launchApp({ bundleId: "com.x; rm -rf /", target: "/Applications/X.app" });
t.deepEqual(rec.calls[3].args, ["/Applications/X.app"], "bundle id with ';' and spaces is never passed");
await mac.launchApp({ bundleId: "com.x\nevil", target: "/Applications/Y.app" });
t.deepEqual(rec.calls[4].args, ["/Applications/Y.app"], "bundle id with newline is never passed");
await mac.launchApp({ bundleId: "com.apple.Image_Capture", target: "/System/Applications/Image Capture.app" });
t.deepEqual(rec.calls[5].args, ["-b", "com.apple.Image_Capture"], "bundle id with '_' launches via open -b");
await mac.launchApp({ bundleId: "_foo", target: "/Applications/Z.app" });
t.deepEqual(rec.calls[6].args, ["/Applications/Z.app"], "bundle id starting with '_' is never passed");
const callsBefore = rec.calls.length;
await t.rejects(() => mac.launchApp({ target: "Applications/Rel.app" }), "relative path rejected");
await t.rejects(() => mac.launchApp({ target: "/Applications/tool" }), "non-.app path rejected");
await t.rejects(() => mac.launchApp({ bundleId: "-b", target: "" }), "dash bundle id without path rejected");
await t.rejects(() => mac.launchApp({ bundleId: "has space" }), "bundle id with space rejected");
await t.rejects(() => mac.launchApp(null), "null app rejected");
await t.rejects(() => mac.launchApp("/Applications/Safari.app"), "bare string rejected");
t.equal(rec.calls.length, callsBefore, "rejected launches issue no exec");
t.throws(() => launchArgv({}), "launchArgv throws without valid input");

// ---- focus / close ----
rec = recorder('{"ok":true}');
mac = createMacProvider({ exec: rec.exec, appDirs: ["/Applications"] });
await mac.focusApp({ pid: 4812, name: "x; rm -rf /" });
t.equal(rec.calls[0].file, OSASCRIPT, "focus runs /usr/bin/osascript");
t.deepEqual(rec.calls[0].args, ["-l", "JavaScript", "-e", FOCUS_JXA, "--", "4812"], "focus argv carries the pid as its own entry");
t.equal(rec.calls[0].args[3], FOCUS_JXA, "focus script argument is the exported constant");
await mac.closeApp({ pid: 1200 });
t.deepEqual(rec.calls[1].args, ["-l", "JavaScript", "-e", CLOSE_JXA, "--", "1200"], "close argv carries the pid as its own entry");
t.equal(rec.calls[1].args[3], CLOSE_JXA, "close script argument is the exported constant");
for (const pid of [0, -1, 1.5, "12; kill", null, undefined, NaN]) {
  await t.rejects(() => mac.focusApp({ pid }), `focus rejects pid ${String(pid)}`);
  await t.rejects(() => mac.closeApp({ pid }), `close rejects pid ${String(pid)}`);
}
t.equal(rec.calls.length, 2, "rejected focus/close issue no exec");

// ---- inventory / running argv ----
rec = recorder(inventoryRaw);
const dirs = ["/Applications", "/Users/me/Applications"];
mac = createMacProvider({ exec: rec.exec, appDirs: dirs });
const listed = await mac.listInstalledApps();
t.equal(rec.calls[0].file, OSASCRIPT, "inventory runs osascript");
t.deepEqual(rec.calls[0].args, ["-l", "JavaScript", "-e", INVENTORY_JXA, "--", ...dirs], "inventory passes dirs as argv");
t.equal(listed.length, apps.length, "provider inventory uses parseInventory");
const defaults = defaultAppDirs("/Users/me");
t.deepEqual(
  defaults,
  ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", "/Users/me/Applications"],
  "default scan order",
);
rec = recorder("");
await createMacProvider({ exec: rec.exec }).listInstalledApps();
t.equal(rec.calls[0].args.slice(5).length, 5, "default provider scans five directories");
t.ok(rec.calls[0].args.slice(5).every((d) => d.startsWith("/")), "default dirs are absolute");

rec = recorder(runningRaw);
mac = createMacProvider({ exec: rec.exec, appDirs: dirs });
const run = await mac.listRunningApps();
t.deepEqual(rec.calls[0].args, ["-l", "JavaScript", "-e", RUNNING_JXA, "--"], "running argv carries no caller data");
t.equal(run.length, 5, "provider running uses parseRunning");

const failing = createMacProvider({ exec: async () => { throw new Error("osascript failed"); }, appDirs: dirs });
await t.rejects(() => failing.listInstalledApps(), "inventory script failure propagates");

// ---- icons ----
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)]);
rec = recorder(PNG.toString("base64") + "\n");
mac = createMacProvider({ exec: rec.exec, appDirs: dirs });
const icon = await mac.appIcon({ target: "/Applications/Safari.app" });
t.ok(Buffer.isBuffer(icon) && icon.equals(PNG), "valid PNG icon is returned");
t.deepEqual(rec.calls[0].args, ["-l", "JavaScript", "-e", ICON_JXA, "--", "/Applications/Safari.app"], "icon argv carries the bundle path as argv");
t.equal(await mac.appIcon({ target: "Applications/Safari.app" }), null, "icon rejects relative target");
t.equal(await mac.appIcon({ target: "/usr/bin/true" }), null, "icon rejects non-.app target");
t.equal(rec.calls.length, 1, "rejected icon targets issue no exec");

const notPng = createMacProvider({ exec: async () => ({ stdout: Buffer.from("GIF89a-not-a-png").toString("base64") }), appDirs: dirs });
t.equal(await notPng.appIcon({ target: "/Applications/X.app" }), null, "missing PNG signature rejected");
const huge = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(ICON_MAX_BYTES + 1)]);
const tooBig = createMacProvider({ exec: async () => ({ stdout: huge.toString("base64") }), appDirs: dirs });
t.equal(await tooBig.appIcon({ target: "/Applications/X.app" }), null, "icon over 512 KiB rejected");
const edge = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(ICON_MAX_BYTES - 8)]);
const atLimit = createMacProvider({ exec: async () => ({ stdout: edge.toString("base64") }), appDirs: dirs });
t.equal((await atLimit.appIcon({ target: "/Applications/X.app" }))?.length, ICON_MAX_BYTES, "icon of exactly 512 KiB accepted");
const empty = createMacProvider({ exec: async () => ({ stdout: "" }), appDirs: dirs });
t.equal(await empty.appIcon({ target: "/Applications/X.app" }), null, "empty icon output is null");
const iconFail = createMacProvider({ exec: async () => { throw new Error("boom"); }, appDirs: dirs });
t.equal(await iconFail.appIcon({ target: "/Applications/X.app" }), null, "icon script failure returns null");

// ---- out-of-scope surfaces ----
let controlError = null;
try {
  await mac.control("volume-up", null);
} catch (error) {
  controlError = error;
}
t.equal(controlError?.status, 501, "control throws status 501");
t.equal(controlError?.message, "Controls aren't available on the macOS host yet.", "control message");
t.equal(await mac.nowPlaying(), null, "nowPlaying is null");
const stats = await mac.systemStats();
t.equal(stats.cpu, null, "cpu is null");
t.equal(stats.battery, null, "battery is null");
t.equal(stats.charging, null, "charging is null");
t.ok(Number.isInteger(stats.memory) && stats.memory >= 0 && stats.memory <= 100, "memory is a percentage");
t.equal(mac.capture, undefined, "no capture surface on macOS");
t.equal(mac.input, undefined, "no input surface on macOS");

t.done("macos verification passed");
