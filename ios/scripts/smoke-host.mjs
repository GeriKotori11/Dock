// Real WinDock protocol + shared UI, with no native provider or user configuration.
import { createApp } from '../../server.js';
import { createConfigStore } from '../../src/config.js';
import { createPairing } from '../../src/auth.js';
import { generateTlsIdentity } from '../../src/tls.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const dir = resolve(import.meta.dirname, '../build/fixture');
await mkdir(dir, { recursive: true });
const apps = ['Browser', 'Editor', 'Music', 'Terminal', 'Notes'].map((name, i) => ({
  id: `ios-${i + 1}`, name, target: `C:\\Fixture\\app${i + 1}.exe`, args: '', icon: '',
}));
const iconFiles = ['chrome', 'vscode', 'spotify', 'obsidian', 'notepad'];
const icons = await Promise.all(iconFiles.map(name => readFile(resolve(import.meta.dirname, `../../website/assets/${name}.png`))));
let running = [];
const events = [];
async function record(action, app) {
  events.push({ action, id: app.id });
  await writeFile(resolve(dir, 'events.json'), JSON.stringify(events, null, 2));
}
const provider = {
  id: 'ios-simulator', displayName: 'iOS simulator fixture',
  listInstalledApps: async () => apps, listRunningApps: async () => running,
  appIcon: async app => icons[apps.findIndex(candidate => candidate.id === app.id)],
  launchApp: async app => { running = [{ ...app, pid: 4242 }]; await record('launch', app); },
  focusApp: async app => record('focus', app),
  closeApp: async app => { running = []; await record('close', app); },
  control: async () => { throw new Error('PC controls disabled in simulator tests'); },
  nowPlaying: async () => null, systemStats: async () => ({}),
};
const configStore = createConfigStore({ path: resolve(dir, 'config.json') });
await configStore.save({ tiles: apps.map(app => ({ ...app, kind: 'app', label: app.name })) });
await writeFile(resolve(dir, 'events.json'), '[]');
// HTTPS and plain HTTP on 18622, as on a real host. The identity lives in memory only, so
// every fixture run presents a new certificate to the phone's trust-on-first-use pin.
const identity = { hostId: randomUUID() };
const tls = generateTlsIdentity({ commonName: `WinDock ${identity.hostId}` });
const app = await createApp({ provider, configStore, identity, tls, pairing: createPairing({ pin: '864200', nextPin: () => '864200', windowMs: 24 * 60 * 60 * 1000 }), trustLoopback: false, allowDestructive: false });
const foreignHits = [];
const servers = [
  [app.listener, 18622],
  [createServer((req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:18622/health' }); res.end(); }), 18623],
  [createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"app":"other"}'); }), 18624],
  [createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write(' '.repeat(6000)); res.end('{"ok":true,"app":"windock"}'); }), 18625],
  [createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.url === '/hits') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(foreignHits)); return; }
    foreignHits.push(req.url);
    res.end('window.foreignScriptLoaded = true;');
  }), 18626],
];
for (const [server, port] of servers) await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
console.log(`iOS simulator fixture ready on 18622 (http + https, code ${tls.code}); PIN 864200 (test provider only)`);
