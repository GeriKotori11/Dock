/**
 * G17: the Android wrapper agrees with the host discovery and API contract.
 *
 * Alongside the Android build and JVM tests, this gate proves the Kotlin constants and the
 * JavaScript host describe the same protocol. Drift between them is the failure
 * that would compile perfectly and then simply never find the PC.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createChecker } from "./lib/assert.mjs";
import { PROBE, REPLY_PREFIX, DISCOVERY_PORT, replyFor, parseReply } from "../src/discovery.js";

const t = createChecker("android");
const root = join(import.meta.dirname, "..");
const AND = join(root, "android");
const read = (p) => readFileSync(join(AND, p), "utf8");

// ---- the sources exist ----
const REQUIRED = [
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/com/windock/app/MainActivity.kt",
  "app/src/main/java/com/windock/app/Discovery.kt",
  "app/src/main/java/com/windock/app/ServerUrl.kt",
  "app/src/main/res/layout/activity_main.xml",
  "app/src/main/res/values/strings.xml",
  "app/src/main/res/xml/network_security_config.xml",
  "app/build.gradle",
  "build.gradle",
  "settings.gradle",
];
for (const file of REQUIRED) {
  t.ok(existsSync(join(AND, file)), `android source present: ${file}`);
}

// ---- protocol agreement: the whole point of this gate ----
const disco = read("app/src/main/java/com/windock/app/Discovery.kt");

const kotlinPort = Number(disco.match(/const val PORT\s*=\s*(\d+)/)?.[1]);
t.equal(kotlinPort, DISCOVERY_PORT, "Kotlin discovery PORT matches the host");

const kotlinProbe = disco.match(/const val PROBE\s*=\s*"([^"]+)"/)?.[1];
t.equal(kotlinProbe, PROBE, "Kotlin PROBE string matches the host");

const kotlinPrefix = disco.match(/const val REPLY_PREFIX\s*=\s*"([^"]+)"/)?.[1];
t.equal(kotlinPrefix, REPLY_PREFIX, "Kotlin REPLY_PREFIX matches the host");

// Drive the HOST's own logic with the Kotlin constants: the probe the app sends
// must be one the server actually answers, and the reply must parse.
const answer = replyFor(kotlinProbe, "http://192.168.1.40:8620");
t.ok(answer !== null, "the host answers the probe the Android app sends");
t.equal(
  answer,
  `${kotlinPrefix}http://192.168.1.40:8620`,
  "the host reply is exactly what the Kotlin prefix expects",
);
t.equal(parseReply(answer), "http://192.168.1.40:8620", "the host can parse its own reply");

// EndpointPolicyTest executes the real Kotlin parser, including unsafe replies.
// Negative control: a deliberately wrong prefix must fail, proving the checks
// above are not passing vacuously.
t.equal(
  "windock:here:v0:http://x".startsWith(kotlinPrefix),
  false,
  "negative control: a version-mismatched reply is not accepted",
);

// ---- the app must only use routes the host serves ----
const server = readFileSync(join(root, "server.js"), "utf8");
const main = read("app/src/main/java/com/windock/app/MainActivity.kt");
const SRC = "app/src/main/java/com/windock/app";
const kotlinFiles = readdirSync(join(AND, SRC)).filter((f) => f.endsWith(".kt"));
const sources = Object.fromEntries(kotlinFiles.map((f) => [f, read(`${SRC}/${f}`)]));
const allKotlin = Object.values(sources).join("\n");
const routes = [...new Set([
  ...[...allKotlin.matchAll(/"\$\w+(\/[a-z/]+)"/g)].map((m) => m[1]),
  ...[...allKotlin.matchAll(/"(\/health|\/api\/[a-z/]+)"/g)].map((m) => m[1]),
])];
t.ok(routes.length > 0, `the app references at least one host route (${routes.join(", ")})`);
for (const route of routes) {
  t.ok(server.includes(`"${route}"`), `host serves the route the app calls: ${route}`);
}
// /health is the only unauthenticated route, so a reachability probe must use it.
t.ok(routes.includes("/health"), "the app probes /health, the only public route");
t.ok(routes.includes("/api/auth") && routes.includes("/api/session"), "native pairing and forget use the host's routes");
t.ok(
  allKotlin.includes('optString("app") == "windock"'),
  "the app verifies the host identity, not just a 200",
);

// ---- permissions and transport ----
const manifest = read("app/src/main/AndroidManifest.xml");
for (const perm of ["INTERNET", "CHANGE_WIFI_MULTICAST_STATE"]) {
  t.ok(manifest.includes(`android.permission.${perm}`), `manifest declares ${perm}`);
}
t.ok(manifest.includes("android:networkSecurityConfig"), "manifest points at a network security config");
t.ok(manifest.includes("MainActivity"), "manifest registers the main activity");
t.ok(manifest.includes("android.intent.category.LAUNCHER"), "the app has a launcher entry");
t.ok(manifest.includes('android:allowBackup="false"'), "backups are disabled so the session cookie is not exported");

// Android domain rules cannot match IP ranges. The app grants transport
// permission and enforces numeric LAN hosts + same-origin requests in Kotlin.
const netcfg = read("app/src/main/res/xml/network_security_config.xml");
t.ok(netcfg.includes('cleartextTrafficPermitted="true"'), "cleartext is permitted for the LAN");
t.ok(!netcfg.includes("<domain"), "network policy does not mistake IP literals for subnets");
t.ok(main.includes("EndpointPolicy.allowsRequest"), "WebView requests are scoped to the selected origin");

// ---- credentials: the shell itself stays free of them; only small classes touch them ----
/** Strip comments: the invariant is about code, and documenting the boundary
 *  in prose must not fail the check that enforces it. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const kotlinCode = stripComments(
  [disco, main, read("app/src/main/java/com/windock/app/ServerUrl.kt")].join("\n"),
);
for (const word of ["pin", "cookie", "token"]) {
  t.ok(
    !new RegExp(`\\b${word}\\b`, "i").test(kotlinCode),
    `the activity and discovery never handle ${word} in code (pairing lives in PairingScreen/HostClient)`,
  );
}
t.ok(!/CookieManager|\/api\/pair/.test(kotlinCode), "the activity does not touch the cookie store or the PIN route");
// The WebView cookie store is touched in exactly one small class.
const cookieUsers = Object.entries(sources)
  .filter(([, code]) => /CookieManager/.test(stripComments(code)))
  .map(([file]) => file);
t.deepEqual(cookieUsers, ["SessionCookies.kt"], `CookieManager is used only in SessionCookies.kt (${cookieUsers.join(", ")})`);
// The session request header is built only for the pinned DELETE /api/session.
t.ok(/"Cookie"/.test(sources["HostClient.kt"] ?? ""), "HostClient sends the session only on its own request");
// No trust-all TLS: every custom trust manager either records or compares a fingerprint.
for (const [file, code] of Object.entries(sources)) {
  const managers = (stripComments(code).match(/object\s*:\s*X509TrustManager/g) || []).length;
  if (!managers) continue;
  t.ok(/Fingerprint\.of\(/.test(code), `${file}: its trust managers compute the presented fingerprint`);
  t.ok(!/getDefault\(\)|ALLOW_ALL|setDefaultSSLSocketFactory|setDefaultHostnameVerifier/.test(code),
    `${file}: no process-wide TLS overrides`);
}
// Positive control: the stripper must not simply blank the source, or the
// assertions above would pass for any file at all.
t.ok(kotlinCode.includes("DatagramSocket"), "positive control: real code survives comment stripping");
t.ok(!stripComments("// pin\nval x = 1").includes("pin"), "positive control: the stripper removes comments");
t.ok(
  /\bcookie\b/i.test(stripComments('val c = "cookie"')),
  "positive control: the detector still finds the word in real code",
);

// ---- build config sanity ----
const appGradle = read("app/build.gradle");
t.ok(/namespace\s+'com\.windock\.app'/.test(appGradle), "the gradle namespace matches the package");
t.ok(/minSdk\s+(\d+)/.test(appGradle), "a minSdk is declared");
t.ok(Number(appGradle.match(/minSdk\s+(\d+)/)[1]) >= 24, "minSdk is at least 24 for modern WebView behaviour");
t.ok(read("settings.gradle").includes("include ':app'"), "the app module is included in the build");

t.done("android verification passed");
