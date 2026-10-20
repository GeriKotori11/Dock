/** The macOS LaunchAgent and `npm run info`: plist, argv and text builders. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import {
  agentPlist,
  agentPaths,
  parseArgs,
  plistPort,
  xmlEscape,
  launchctlArgs,
  main,
  DEFAULT_LABEL,
  AGENT_PATH_ENV,
} from "./macos-agent.mjs";
import { formatInfo, fetchPairing, failureText, infoPort, NOT_RUNNING, DEFAULT_PORT } from "./windock-info.mjs";

const t = createChecker("macos-agent");

// ---- XML escaping ----
t.equal(xmlEscape(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f", "every XML metacharacter is escaped");
t.equal(xmlEscape("&amp;"), "&amp;amp;", "an existing entity is escaped again, not passed through");
t.equal(xmlEscape("/Users/ann/Side Quests/WinDock"), "/Users/ann/Side Quests/WinDock", "ordinary paths are unchanged");

// ---- plist content ----
const base = {
  label: DEFAULT_LABEL,
  nodePath: "/opt/homebrew/bin/node",
  serverPath: "/Users/ann/WinDock/server.js",
  workingDirectory: "/Users/ann/WinDock",
  logPath: "/Users/ann/Library/Logs/WinDock/host.log",
};
const plist = agentPlist(base);
t.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist'), "the plist has the XML and plist DOCTYPE headers");
t.ok(plist.includes("<key>Label</key>\n\t<string>dev.windock.host</string>"), "the default label is dev.windock.host");
t.ok(plist.includes(
  "<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/opt/homebrew/bin/node</string>\n\t\t<string>/Users/ann/WinDock/server.js</string>\n\t</array>",
), "ProgramArguments is exactly [nodePath, serverPath]");
t.ok(plist.includes("<key>RunAtLoad</key>\n\t<true/>"), "RunAtLoad is true");
t.ok(plist.includes("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>"),
  "KeepAlive restarts only after an unsuccessful exit");
t.ok(plist.includes("<key>WorkingDirectory</key>\n\t<string>/Users/ann/WinDock</string>"), "WorkingDirectory is set");
t.ok(plist.includes("<key>WINDOCK_HIDE_PIN</key>\n\t\t<string>1</string>"), "the agent hides the PIN from its log");
t.ok(plist.includes(`<key>PATH</key>\n\t\t<string>${AGENT_PATH_ENV}</string>`), "the agent has a fixed system PATH");
t.equal(AGENT_PATH_ENV, "/usr/bin:/bin:/usr/sbin:/sbin", "the fixed PATH holds only system directories");
t.ok(!plist.includes("<key>PORT</key>"), "no PORT is set unless one is given");
t.ok(plist.includes("<key>StandardOutPath</key>\n\t<string>/Users/ann/Library/Logs/WinDock/host.log</string>"), "stdout goes to the log");
t.ok(plist.includes("<key>StandardErrorPath</key>\n\t<string>/Users/ann/Library/Logs/WinDock/host.log</string>"), "stderr goes to the log");
t.equal(plistPort(plist), null, "plistPort reads no port from a plist without one");

const withPort = agentPlist({ ...base, label: "dev.windock.host.test", port: 18650 });
t.ok(withPort.includes("<key>PORT</key>\n\t\t<string>18650</string>"), "a given port is passed as PORT");
t.ok(withPort.includes("<string>dev.windock.host.test</string>"), "a custom label is used");
t.equal(plistPort(withPort), 18650, "plistPort reads the PORT back");

const hostile = `/Users/a&b<c>"d'e`;
const escaped = agentPlist({
  ...base, nodePath: `${hostile}/node`, serverPath: `${hostile}/server.js`, workingDirectory: hostile, logPath: `${hostile}/host.log`,
});
const safe = "/Users/a&amp;b&lt;c&gt;&quot;d&apos;e";
t.ok(!escaped.includes(hostile), "no raw metacharacter path reaches the plist");
for (const suffix of ["/node", "/server.js", "", "/host.log"]) {
  t.ok(escaped.includes(`<string>${safe}${suffix}</string>`), `the path ${JSON.stringify(`${hostile}${suffix}`)} is XML-escaped`);
}
t.equal((escaped.match(/<string>/g) || []).length, (plist.match(/<string>/g) || []).length,
  "escaping adds no extra elements");
for (const field of ["nodePath", "serverPath", "workingDirectory", "logPath"]) {
  t.throws(() => agentPlist({ ...base, [field]: "relative/path" }), `a relative ${field} is refused`);
  t.throws(() => agentPlist({ ...base, [field]: undefined }), `a missing ${field} is refused`);
}

// On a Mac, plutil confirms the XML is a valid plist with the intended structure.
if (process.platform === "darwin" && existsSync("/usr/bin/plutil")) {
  const dir = await mkdtemp(join(tmpdir(), "windock-agent-"));
  try {
    for (const [name, xml] of [["plain", withPort], ["escaped", escaped]]) {
      const file = join(dir, `${name}.plist`);
      await writeFile(file, xml);
      const json = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
      t.ok(json.RunAtLoad === true && json.KeepAlive?.SuccessfulExit === false, `plutil (${name}): RunAtLoad and KeepAlive parse`);
      t.equal(json.EnvironmentVariables?.WINDOCK_HIDE_PIN, "1", `plutil (${name}): WINDOCK_HIDE_PIN parses`);
      if (name === "escaped") {
        t.deepEqual(json.ProgramArguments, [`${hostile}/node`, `${hostile}/server.js`], "plutil: escaped paths decode to the originals");
        t.equal(json.WorkingDirectory, hostile, "plutil: the escaped working directory decodes to the original");
      } else {
        t.equal(json.EnvironmentVariables.PORT, "18650", "plutil: PORT parses as a string");
        t.equal(json.Label, "dev.windock.host.test", "plutil: the label parses");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- paths ----
t.deepEqual(agentPaths({ home: "/Users/ann" }), {
  plistPath: "/Users/ann/Library/LaunchAgents/dev.windock.host.plist",
  logDir: "/Users/ann/Library/Logs/WinDock",
  logPath: "/Users/ann/Library/Logs/WinDock/host.log",
}, "default paths are the LaunchAgents plist and Logs/WinDock/host.log");
t.deepEqual(agentPaths({ home: "/Users/ann", label: "dev.windock.host.test" }), {
  plistPath: "/Users/ann/Library/LaunchAgents/dev.windock.host.test.plist",
  logDir: "/Users/ann/Library/Logs/WinDock",
  logPath: "/Users/ann/Library/Logs/WinDock/dev.windock.host.test.log",
}, "a custom label gets its own plist and log");

// ---- argument parsing ----
t.deepEqual(parseArgs(["install"]), { command: "install", label: DEFAULT_LABEL, port: null }, "install with defaults");
t.deepEqual(parseArgs(["install", "--label", "dev.windock.host.test", "--port", "18650"]),
  { command: "install", label: "dev.windock.host.test", port: 18650 }, "--label and --port are parsed");
t.deepEqual(parseArgs(["--port=18650", "status", "--label=a_b-c.d"]),
  { command: "status", label: "a_b-c.d", port: 18650 }, "--flag=value forms and any order are accepted");
t.equal(parseArgs(["uninstall"]).command, "uninstall", "uninstall is a command");
for (const [argv, why] of [
  [[], "a missing command"],
  [["start"], "an unknown command"],
  [["install", "status"], "two commands"],
  [["install", "--label"], "--label without a value"],
  [["install", "--port", "--label", "x"], "--port followed by another flag"],
  [["install", "--label", "../evil"], "a label with a path separator"],
  [["install", "--label", "a/b"], "a label with a slash"],
  [["install", "--label", ".hidden"], "a label starting with a dot"],
  [["install", "--label", "a b"], "a label with a space"],
  [["install", "--port", "0"], "port 0"],
  [["install", "--port", "65536"], "a port above 65535"],
  [["install", "--port", "80a"], "a non-numeric port"],
  [["install", "--port", "-1"], "a negative port"],
  [["install", "--force"], "an unknown option"],
]) {
  t.throws(() => parseArgs(argv), `parseArgs refuses ${why}`);
}

// ---- launchctl argv ----
t.deepEqual(launchctlArgs.bootstrap(501, "/Users/ann/Library/LaunchAgents/dev.windock.host.plist"),
  ["bootstrap", "gui/501", "/Users/ann/Library/LaunchAgents/dev.windock.host.plist"], "bootstrap argv is exact");
t.deepEqual(launchctlArgs.bootout(501, "dev.windock.host"), ["bootout", "gui/501/dev.windock.host"], "bootout argv is exact");
t.deepEqual(launchctlArgs.print(501, "dev.windock.host.test"), ["print", "gui/501/dev.windock.host.test"], "print argv is exact");
t.deepEqual(launchctlArgs.bootstrap(501, "/Users/a b/x.plist"), ["bootstrap", "gui/501", "/Users/a b/x.plist"],
  "a path with spaces stays one argv element");

// ---- non-darwin refusal ----
const realErr = process.stderr.write.bind(process.stderr);
let errText = "";
process.stderr.write = (chunk) => { errText += chunk; return true; };
let code;
try {
  code = await main(["install"], "win32");
} finally {
  process.stderr.write = realErr;
}
t.equal(code, 1, "the agent script refuses to run on a non-macOS platform");
t.ok(errText.includes("macOS only"), "the refusal says it is for macOS only");

// ---- npm run info ----
t.equal(formatInfo({ hostName: "Anns-Mac", endpoint: "http://192.168.1.20:8620", pin: "0427" }),
  "WinDock is running on Anns-Mac\n  Address: http://192.168.1.20:8620\n  PIN:     0427\nEnter this address and PIN in the WinDock app on your phone.\n",
  "the info block has the documented layout");
t.ok(formatInfo({ hostName: "M", endpoint: null, pin: "1111" }).includes("  Address: (unknown)\n"), "a null endpoint prints (unknown)");
t.equal(infoPort({}), DEFAULT_PORT, "info uses port 8620 by default");
t.equal(DEFAULT_PORT, 8620, "the default port matches the host");
t.equal(infoPort({ PORT: "18650" }), 18650, "info honours PORT");
t.equal(infoPort({ PORT: "nope" }), DEFAULT_PORT, "an invalid PORT falls back to the default");
t.equal(failureText({ ok: false, reason: "unreachable" }, 8620), `${NOT_RUNNING}\n`, "an unreachable host prints the not-running hint");
t.ok(NOT_RUNNING.includes("npm start") && NOT_RUNNING.includes("npm run mac:install"), "the hint names both ways to start");
t.ok(failureText({ ok: false, reason: "refused", status: 403 }, 8620).includes("HTTP 403"), "a refusal names the status");

const urls = [];
const fakeFetch = (status, body) => async (url) => {
  urls.push(url);
  return { status, json: async () => (body instanceof Error ? Promise.reject(body) : body) };
};
const good = await fetchPairing(18650, { fetchImpl: fakeFetch(200, { endpoint: "http://x:1", pin: "1234", hostName: "M", hostId: null }) });
t.ok(good.ok && good.info.pin === "1234", "fetchPairing returns the pairing info");
t.equal(urls.at(-1), "http://127.0.0.1:18650/api/pairing", "fetchPairing asks 127.0.0.1 so the Host is a loopback literal");
t.deepEqual(await fetchPairing(1, { fetchImpl: async () => { throw new TypeError("fetch failed"); } }),
  { ok: false, reason: "unreachable" }, "a connection failure is reported as unreachable");
t.deepEqual(await fetchPairing(1, { fetchImpl: fakeFetch(403, { error: "local only" }) }),
  { ok: false, reason: "refused", status: 403 }, "a 403 is reported as refused");
t.deepEqual(await fetchPairing(1, { fetchImpl: fakeFetch(200, new Error("not json")) }),
  { ok: false, reason: "refused", status: 200 }, "a non-JSON answer is reported as refused");

t.done("macos-agent verification passed");
