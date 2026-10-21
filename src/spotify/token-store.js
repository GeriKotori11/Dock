/**
 * Where the host keeps its Spotify tokens: the OS secret store.
 *
 *  - macOS: the login Keychain, through `/usr/bin/security`. The secret never
 *    appears in a process argv (argv is visible to every local user through
 *    `ps`): writes go through `security -i`, which reads its command line from
 *    stdin, and reads come back on stdout (`find-generic-password -w`). The
 *    token JSON is stored base64-encoded so the stdin command needs no quoting.
 *  - Windows: DPAPI (CurrentUser) through WinDockHelper `protect-write` /
 *    `protect-read`, the secret on stdin/stdout, the blob in the data dir.
 *  - Elsewhere: a 0600 file in the data dir.
 *
 * Every store has the same shape: `read() -> object | null`, `write(object)`,
 * `remove()`. `run(file, args, { input })` is injectable so tests can record
 * every call and assert no token ever reaches an argv.
 */

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../fsutil.js";

export const SECURITY = "/usr/bin/security";
export const KEYCHAIN_SERVICE = "dev.gerikotori.windock.spotify";
/** `find-generic-password` / `delete-generic-password` exit code when nothing matches. */
export const KEYCHAIN_NOT_FOUND = 44;
export const TOKEN_FILE = "spotify-tokens.json";
export const DPAPI_FILE = "spotify-tokens.dpapi";
const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SECRET = 16 * 1024;

/** Run a program with an argv array (never a shell), optional stdin; resolves `{ code, stdout, stderr }`. */
export function runWithInput(file, args = [], { input = "", timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errs = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), timeout);
    const take = (list) => (chunk) => {
      size += chunk.length;
      if (size <= 1024 * 1024) list.push(chunk);
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(errs));
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errs).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function encode(tokens) {
  if (!tokens || typeof tokens !== "object") throw new TypeError("tokens must be an object");
  const json = JSON.stringify(tokens);
  if (json.length > MAX_SECRET) throw new Error("tokens too large");
  return json;
}
function decode(json) {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** macOS login Keychain: one generic password per host (service + account). */
export function createKeychainStore({ service = KEYCHAIN_SERVICE, account, run = runWithInput, security = SECURITY } = {}) {
  if (!NAME_RE.test(service) || !NAME_RE.test(account ?? "")) throw new TypeError("keychain service and account must be simple names");
  const ids = ["-a", account, "-s", service];
  return {
    kind: "keychain",
    service,
    account,
    async read() {
      const r = await run(security, ["find-generic-password", ...ids, "-w"]);
      if (r.code === KEYCHAIN_NOT_FOUND) return null;
      if (r.code !== 0) throw new Error(`keychain read failed (${r.code})`);
      const b64 = r.stdout.trim();
      if (!/^[A-Za-z0-9+/=]*$/.test(b64)) return null;
      return decode(Buffer.from(b64, "base64").toString("utf8"));
    },
    async write(tokens) {
      const b64 = Buffer.from(encode(tokens), "utf8").toString("base64");
      // The command line, secret included, travels on stdin; argv is just `-i`.
      const r = await run(security, ["-i"], { input: `add-generic-password -U ${ids.join(" ")} -l WinDock-Spotify -w ${b64}\n` });
      if (r.code !== 0) throw new Error(`keychain write failed (${r.code})`);
    },
    async remove() {
      const r = await run(security, ["delete-generic-password", ...ids]);
      if (r.code !== 0 && r.code !== KEYCHAIN_NOT_FOUND) throw new Error(`keychain delete failed (${r.code})`);
    },
  };
}

/** Windows DPAPI (CurrentUser) via the helper; the blob lives in the data dir. */
export function createDpapiStore({
  dataDir,
  helperPath = process.env.WINDOCK_HELPER || fileURLToPath(new URL("../../WinDockHelper.exe", import.meta.url)),
  run = runWithInput,
} = {}) {
  const path = join(dataDir, DPAPI_FILE);
  const exists = async () => readFile(path).then(() => true, () => false);
  return {
    kind: "dpapi",
    path,
    async read() {
      if (!(await exists())) return null;
      const r = await run(helperPath, ["protect-read", path]);
      if (r.code !== 0) throw new Error(`dpapi read failed (${r.code})`);
      return decode(r.stdout);
    },
    async write(tokens) {
      const r = await run(helperPath, ["protect-write", path], { input: encode(tokens) });
      if (r.code !== 0) throw new Error(`dpapi write failed (${r.code})`);
    },
    async remove() {
      await rm(path, { force: true });
    },
  };
}

/** Owner-only file (Linux and other hosts without a supported secret store). */
export function createFileStore({ dataDir }) {
  const path = join(dataDir, TOKEN_FILE);
  return {
    kind: "file",
    path,
    async read() {
      try {
        return decode(await readFile(path, "utf8"));
      } catch (err) {
        if (err?.code === "ENOENT") return null;
        throw err;
      }
    },
    async write(tokens) {
      await writeFileAtomic(path, encode(tokens), { mode: 0o600 });
    },
    async remove() {
      await rm(path, { force: true });
    },
  };
}

/** In-memory store for tests and fixtures. */
export function createMemoryTokenStore(initial = null) {
  let value = initial ? JSON.parse(JSON.stringify(initial)) : null;
  const store = {
    kind: "memory",
    writes: 0,
    async read() { return value ? JSON.parse(JSON.stringify(value)) : null; },
    async write(tokens) { value = JSON.parse(encode(tokens)); store.writes += 1; },
    async remove() { value = null; },
    peek() { return value; },
  };
  return store;
}

/** The platform's store. */
export function createTokenStore({ os = process.platform, account = "default", service = KEYCHAIN_SERVICE, dataDir, run, helperPath } = {}) {
  const safeAccount = NAME_RE.test(account ?? "") ? account : "default";
  if (os === "darwin") return createKeychainStore({ service, account: safeAccount, ...(run ? { run } : {}) });
  if (os === "win32") return createDpapiStore({ dataDir, ...(run ? { run } : {}), ...(helperPath ? { helperPath } : {}) });
  return createFileStore({ dataDir });
}
