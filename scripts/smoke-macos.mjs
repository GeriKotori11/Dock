/**
 * macOS host smoke test against the REAL system (not part of `npm test`).
 *
 *   node scripts/smoke-macos.mjs            # inventory, one icon, running apps
 *   node scripts/smoke-macos.mjs --launch   # also launch, focus and politely close Calculator
 *
 * Uses the real `exec` from src/platform/index.js, so it exercises exactly the
 * argv the host sends.
 */
import { platform } from "node:os";
import { createExec } from "../src/platform/index.js";
import { createMacProvider, ICON_MAX_BYTES } from "../src/platform/macos.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CALCULATOR = "com.apple.calculator";
const launch = process.argv.includes("--launch");

function fail(message) {
  process.stderr.write(`smoke-macos: FAIL ${message}\n`);
  process.exit(1);
}

async function waitFor(check, { timeoutMs = 10_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

if (platform() !== "darwin") fail(`needs macOS, this is ${platform()}`);

const provider = createMacProvider({ exec: createExec() });

let started = Date.now();
const apps = await provider.listInstalledApps();
console.log(`installed: ${apps.length} apps in ${Date.now() - started} ms`);
if (apps.length === 0) fail("no installed apps found");
for (const app of apps.slice(0, 5)) console.log(`  ${app.name}  [${app.id}]`);
const pathIds = apps.filter((app) => app.id.startsWith("path:")).length;
console.log(`  (${pathIds} without a valid bundle id, using path ids)`);

const iconApp = apps.find((app) => app.bundleId === CALCULATOR) || apps[0];
started = Date.now();
const icon = await provider.appIcon(iconApp);
if (!icon) fail(`no icon for ${iconApp.name}`);
if (!icon.subarray(0, 8).equals(PNG_SIGNATURE)) fail("icon is not a PNG");
if (icon.length > ICON_MAX_BYTES) fail(`icon is ${icon.length} bytes, over ${ICON_MAX_BYTES}`);
const width = icon.readUInt32BE(16);
const height = icon.readUInt32BE(20);
console.log(`icon: ${iconApp.name} ${width}x${height} PNG, ${icon.length} bytes in ${Date.now() - started} ms`);

const running = await provider.listRunningApps();
const installedIds = new Set(apps.map((app) => app.id));
console.log(`running: ${running.length} regular apps (${running.filter((r) => installedIds.has(r.id)).length} match the catalog)`);
for (const app of running.slice(0, 5)) console.log(`  pid ${app.pid}  ${app.name}  [${app.id}]`);

if (launch) {
  const calculator = apps.find((app) => app.bundleId === CALCULATOR);
  if (!calculator) fail("Calculator is not in the catalog");
  const alreadyRunning = (await provider.listRunningApps()).find((r) => r.id === CALCULATOR);
  if (alreadyRunning) fail("Calculator is already running; quit it first so the smoke test does not close your window");

  await provider.launchApp(calculator);
  const up = await waitFor(async () => (await provider.listRunningApps()).find((r) => r.id === CALCULATOR));
  if (!up) fail("Calculator did not appear in running apps after launch");
  console.log(`launch: Calculator running as pid ${up.pid}`);

  await provider.focusApp(up);
  console.log("focus: ok");

  await provider.closeApp(up);
  const gone = await waitFor(async () => !(await provider.listRunningApps()).some((r) => r.pid === up.pid));
  if (!gone) fail("Calculator did not quit after a polite close");
  console.log("close: Calculator quit");
}

console.log("smoke-macos passed");
