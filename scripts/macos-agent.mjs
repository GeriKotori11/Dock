/**
 * Run the WinDock host at login on macOS with a per-user LaunchAgent.
 *
 *   node scripts/macos-agent.mjs install   [--label <label>] [--port <port>]
 *   node scripts/macos-agent.mjs uninstall [--label <label>]
 *   node scripts/macos-agent.mjs status    [--label <label>] [--port <port>]
 *
 * The agent runs `server.js` with the Node binary that ran this script, keeps
 * the PIN out of its log (WINDOCK_HIDE_PIN=1) and is restarted by launchd after
 * a crash but not after a clean exit. launchctl is always run with an argv
 * array, never through a shell. Everything that builds text or argv is a pure
 * exported function so scripts/verify-macos-agent.mjs can check it anywhere.
 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { formatInfo, fetchPairing, DEFAULT_PORT } from "./windock-info.mjs";

export const DEFAULT_LABEL = "dev.windock.host";
export const LAUNCHCTL = "/bin/launchctl";
export const AGENT_PATH_ENV = "/usr/bin:/bin:/usr/sbin:/sbin";
export const HEALTH_WAIT_MS = 10_000;
const REPO = resolve(import.meta.dirname, "..");
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMANDS = ["install", "uninstall", "status"];

export const USAGE = `Usage: node scripts/macos-agent.mjs <install|uninstall|status> [--label <label>] [--port <port>]
  install    run the WinDock host now and at every login
  uninstall  stop it and remove the login item (data and logs are kept)
  status     show whether it is loaded and healthy
`;

/** Escape text for an XML element body or attribute. */
export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Parse argv (without node and the script). Throws with a usable message. */
export function parseArgs(argv) {
  const out = { command: null, label: DEFAULT_LABEL, port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--label") out.label = take();
    else if (arg.startsWith("--label=")) out.label = arg.slice(8);
    else if (arg === "--port") out.port = take();
    else if (arg.startsWith("--port=")) out.port = arg.slice(7);
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else if (out.command === null) out.command = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!COMMANDS.includes(out.command)) {
    throw new Error(out.command === null ? "missing command" : `unknown command ${out.command}`);
  }
  if (!LABEL_RE.test(out.label)) {
    throw new Error("--label may contain only letters, digits, dots, hyphens and underscores");
  }
  if (out.port !== null) {
    const port = /^\d{1,5}$/.test(out.port) ? Number(out.port) : NaN;
    if (!(port >= 1 && port <= 65535)) throw new Error("--port must be a number from 1 to 65535");
    out.port = port;
  }
  return out;
}

/** Where the agent's files live for one label. */
export function agentPaths({ home = homedir(), label = DEFAULT_LABEL } = {}) {
  const logDir = join(home, "Library", "Logs", "WinDock");
  return {
    plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
    logDir,
    logPath: join(logDir, label === DEFAULT_LABEL ? "host.log" : `${label}.log`),
  };
}

/** The LaunchAgent property list. Every interpolated value is XML-escaped. */
export function agentPlist({ label = DEFAULT_LABEL, nodePath, serverPath, workingDirectory, logPath, port = null }) {
  for (const [name, value] of Object.entries({ nodePath, serverPath, workingDirectory, logPath })) {
    if (typeof value !== "string" || !value.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  }
  const s = (value) => `<string>${xmlEscape(value)}</string>`;
  const env = { WINDOCK_HIDE_PIN: "1", PATH: AGENT_PATH_ENV };
  if (port !== null && port !== undefined) env.PORT = String(port);
  const envXml = Object.entries(env)
    .map(([key, value]) => `\t\t<key>${xmlEscape(key)}</key>\n\t\t${s(value)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${s(label)}
\t<key>ProgramArguments</key>
\t<array>
\t\t${s(nodePath)}
\t\t${s(serverPath)}
\t</array>
\t<key>WorkingDirectory</key>
\t${s(workingDirectory)}
\t<key>EnvironmentVariables</key>
\t<dict>
${envXml}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>StandardOutPath</key>
\t${s(logPath)}
\t<key>StandardErrorPath</key>
\t${s(logPath)}
</dict>
</plist>
`;
}

/** The PORT an installed plist sets, or null. */
export function plistPort(xml) {
  const match = /<key>PORT<\/key>\s*<string>(\d{1,5})<\/string>/.exec(String(xml ?? ""));
  return match ? Number(match[1]) : null;
}

export const launchctlArgs = {
  bootstrap: (uid, plistPath) => ["bootstrap", `gui/${uid}`, plistPath],
  bootout: (uid, label) => ["bootout", `gui/${uid}/${label}`],
  print: (uid, label) => ["print", `gui/${uid}/${label}`],
};

function run(file, args) {
  return new Promise((resolveRun) => {
    execFile(file, args, { shell: false, timeout: 15_000 }, (error, stdout, stderr) => {
      resolveRun({ ok: !error, code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
const launchctl = (args) => run(LAUNCHCTL, args);

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return res.status === 200 && body?.ok === true && body?.app === "windock";
  } catch {
    return false;
  }
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
function portInUse(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value) => { socket.destroy(); resolvePort(value); };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitFor(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return check();
}

async function install({ label, port }, { uid, paths }) {
  const effectivePort = port ?? DEFAULT_PORT;
  // Unload any previous copy first so a reinstall picks up the new plist.
  const previous = await launchctl(launchctlArgs.bootout(uid, label));
  if (previous.ok) await waitFor(async () => !(await portInUse(effectivePort)), 5000);
  if (await portInUse(effectivePort)) {
    process.stderr.write(
      `Port ${effectivePort} is already in use, probably by WinDock started with npm start.\n`
      + "Stop that copy first (Ctrl+C in its terminal), or pass --port to use another port.\n",
    );
    return 1;
  }

  const plist = agentPlist({
    label,
    nodePath: process.execPath,
    serverPath: join(REPO, "server.js"),
    workingDirectory: REPO,
    logPath: paths.logPath,
    port,
  });
  await mkdir(paths.logDir, { recursive: true });
  await mkdir(resolve(paths.plistPath, ".."), { recursive: true });
  await writeFile(paths.plistPath, plist, { mode: 0o644 });
  await chmod(paths.plistPath, 0o644);

  const boot = await launchctl(launchctlArgs.bootstrap(uid, paths.plistPath));
  if (!boot.ok) {
    process.stderr.write(`launchctl bootstrap failed: ${boot.stderr.trim() || `exit ${boot.code}`}\n`);
    return 1;
  }
  process.stdout.write(`Installed login item ${label}\n  plist: ${paths.plistPath}\n  log:   ${paths.logPath}\n`);

  if (!(await waitFor(() => healthy(effectivePort), HEALTH_WAIT_MS))) {
    process.stderr.write(
      `WinDock did not answer on port ${effectivePort} within ${HEALTH_WAIT_MS / 1000} s. Check the log:\n  ${paths.logPath}\n`,
    );
    return 1;
  }
  const pairing = await fetchPairing(effectivePort);
  if (!pairing.ok) {
    process.stdout.write(`WinDock is running. Run "npm run info" to show the address and PIN.\n`);
    return 0;
  }
  process.stdout.write(`\n${formatInfo(pairing.info)}`);
  return 0;
}

async function uninstall({ label }, { uid, paths }) {
  const out = await launchctl(launchctlArgs.bootout(uid, label));
  if (out.ok) process.stdout.write(`Stopped ${label}\n`);
  else process.stdout.write(`${label} was not loaded\n`);
  await rm(paths.plistPath, { force: true });
  process.stdout.write(`Removed ${paths.plistPath}\nData and logs were kept (log: ${paths.logPath}).\n`);
  return 0;
}

async function status({ label, port }, { uid, paths }) {
  const printed = await launchctl(launchctlArgs.print(uid, label));
  let xml = null;
  try {
    xml = await readFile(paths.plistPath, "utf8");
  } catch {
    /* not installed */
  }
  const effectivePort = port ?? plistPort(xml) ?? DEFAULT_PORT;
  const ok = await healthy(effectivePort);
  process.stdout.write([
    `Login item: ${label}`,
    `  installed: ${xml === null ? "no" : "yes"}`,
    `  loaded:    ${printed.ok ? "yes" : "no"}`,
    `  healthy:   ${ok ? "yes" : "no"} (http://127.0.0.1:${effectivePort}/health)`,
    `  plist:     ${paths.plistPath}`,
    `  log:       ${paths.logPath}`,
    "",
  ].join("\n"));
  return printed.ok && ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), platform = process.platform) {
  if (platform !== "darwin") {
    process.stderr.write("The WinDock login item is for macOS only. On Windows, use the WinDock installer.\n");
    return 1;
  }
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    return 2;
  }
  const context = { uid: process.getuid(), paths: agentPaths({ label: args.label }) };
  const commands = { install, uninstall, status };
  return commands[args.command](args, context);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`WinDock login item: ${err.message}\n`);
    process.exit(1);
  });
}
