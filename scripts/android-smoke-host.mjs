// Isolated emulator fixture. No Windows provider and no user configuration.
import { createApp } from '../server.js';
import { createConfigStore } from '../src/config.js';
import { createPairing } from '../src/auth.js';
import { generateTlsIdentity } from '../src/tls.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const dir = resolve(import.meta.dirname, '../artifacts/android-smoke');
await mkdir(dir, { recursive: true });
const apps = ['Browser', 'Editor', 'Music', 'Terminal', 'Notes'].map((name, i) => ({
  id: `smoke-${i + 1}`, name, target: `C:\\Smoke\\app${i + 1}.exe`, args: '', icon: '',
}));
const events = [];
let running = [];
async function record(action, app) {
  events.push({ action, id: app.id, pid: app.pid });
  await writeFile(resolve(dir, 'events.json'), JSON.stringify(events, null, 2));
}
const provider = {
  id: 'android-smoke', displayName: 'Android smoke fixture',
  listInstalledApps: async () => apps,
  listRunningApps: async () => running,
  launchApp: async app => { running = [{ ...app, pid: 4242 }]; await record('launch', app); },
  focusApp: async app => record('focus', app),
  closeApp: async app => { running = []; await record('close', app); },
  control: async () => { throw new Error('Control actions disabled in the emulator fixture'); },
  nowPlaying: async () => null,
  systemStats: async () => ({}),
};
const configStore = createConfigStore({ path: resolve(dir, 'config.json') });
await configStore.save({ tiles: apps.map(app => ({ ...app, kind: 'app', label: app.name })) });
await writeFile(resolve(dir, 'events.json'), '[]');
// HTTPS shares the port with HTTP, as on a real host. The certificate is fresh
// for every run, so the app asks to confirm its security code each time.
const identity = { hostId: '5a0c7e0e-7d1b-4c2a-9f3e-a11d0e5c0de1' };
const tls = generateTlsIdentity({ commonName: `WinDock ${identity.hostId}` });
const app = await createApp({ provider, configStore, identity, tls, pairing: createPairing({ pin: '864200', nextPin: () => '864200', windowMs: 24 * 60 * 60 * 1000 }), trustLoopback: false, allowDestructive: false });
// ANDROID_SMOKE_PORT moves the fixture when 18622 is taken; pass the same port
// to the instrumented tests with -Pandroid.testInstrumentationRunnerArguments.smokePort=PORT.
const port = Number(process.env.ANDROID_SMOKE_PORT || 18622);
app.listener.listen(port, '127.0.0.1', () => console.log(`Android emulator fixture ready on ${port} (http + https, secure: ${tls.code})`));
