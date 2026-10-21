/**
 * WebSocket state sync.
 *
 * The host owns dock state; every paired client receives a full snapshot on
 * connect and a broadcast on each change. Clients never mutate state over the
 * socket — mutations go through the authenticated HTTP API, and the resulting
 * broadcast is what updates every device. That keeps one authorization path
 * instead of two.
 */

import { WebSocketServer } from "ws";

export const HEARTBEAT_MS = 30_000;

export function snapshotMessage(state) {
  return JSON.stringify({ type: "snapshot", ...state });
}

/**
 * Only same-origin browsers, or native clients that send no Origin at all.
 * A browser on a hostile page always sends Origin, so this blocks cross-site
 * WebSocket hijacking of a paired session cookie.
 */
export function originAllowed(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true;
  const host = req?.headers?.host;
  if (!host) return false;
  try {
    const scheme = req.socket?.encrypted ? "https:" : "http:";
    return new URL(origin).origin === new URL(`${scheme}//${host}`).origin;
  } catch {
    return false;
  }
}

/**
 * Attach a sync hub to an HTTP server, or to several (`servers`) when the host
 * answers plain HTTP and HTTPS on one port; every server gets the same
 * upgrade handler.
 * @param {object} opts
 * @param {import('node:http').Server} [opts.server]
 * @param {import('node:http').Server[]} [opts.servers]
 * @param {(req:import('node:http').IncomingMessage)=>boolean} opts.isAuthorized
 * @param {()=>Promise<object>} opts.getState
 * @param {(req:import('node:http').IncomingMessage)=>string|null} [opts.sessionOf]
 *   the session hash a socket is opened under (null for loopback trust), so a
 *   revoked session's sockets can be closed with disconnect()/disconnectAll().
 * @param {()=>void} [opts.onSessionsChange] called whenever a socket opened
 *   under a session connects or closes (the host page's "Connected now").
 * @param {()=>void} [opts.onClientsChange] called whenever any dock socket
 *   connects or closes, so the host can poll only while someone is watching.
 */
export function createSyncHub({ server, servers = [server], isAuthorized, getState, sessionOf = () => null, heartbeatMs = HEARTBEAT_MS, onSessionsChange = () => {}, onClientsChange = () => {} }) {
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap();
  /** ws -> session hash, for sockets opened under a session. */
  const sessionsBySocket = new Map();

  const onUpgrade = (req, socket, head) => {
    if (req.url?.split("?")[0] === "/input") return; // Separate bounded input channel.
    if (!originAllowed(req) || !isAuthorized(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const hash = sessionOf(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (hash) {
        sessionsBySocket.set(ws, hash);
        ws.once("close", () => {
          sessionsBySocket.delete(ws);
          onSessionsChange();
        });
        onSessionsChange();
      }
      wss.emit("connection", ws, req);
    });
  };
  for (const target of servers) target.on("upgrade", onUpgrade);

  wss.on("connection", async (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("error", () => {});
    // ws removes a closed client from wss.clients before this listener runs.
    ws.once("close", () => onClientsChange());
    onClientsChange();
    try {
      ws.send(snapshotMessage(await getState()));
    } catch {
      /* a client that vanished mid-handshake needs no snapshot */
    }
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, heartbeatMs);
  if (typeof timer.unref === "function") timer.unref();

  /** Close every socket whose session matches; returns how many. */
  function disconnectWhere(match) {
    let closed = 0;
    for (const [ws, hash] of sessionsBySocket) {
      if (!match(hash)) continue;
      sessionsBySocket.delete(ws);
      try {
        ws.close(1008, "session revoked");
      } catch {
        ws.terminate();
      }
      closed += 1;
    }
    return closed;
  }

  return {
    wss,
    disconnect: (hash) => disconnectWhere((h) => h === hash),
    disconnectAll: () => disconnectWhere(() => true),
    /** Session hashes that have at least one open sync socket. */
    connectedSessions() {
      const hashes = new Set();
      for (const [ws, hash] of sessionsBySocket) if (ws.readyState === ws.OPEN) hashes.add(hash);
      return hashes;
    },
    get clientCount() {
      return wss.clients.size;
    },
    /** Send a snapshot to every client: `state` when given, else a fresh getState(). */
    async broadcast(state) {
      if (wss.clients.size === 0) return 0;
      const payload = snapshotMessage(state ?? await getState());
      let sent = 0;
      for (const ws of wss.clients) {
        if (ws.readyState !== ws.OPEN) continue;
        try {
          ws.send(payload);
          sent += 1;
        } catch {
          /* drop; heartbeat will reap it */
        }
      }
      return sent;
    },
    close() {
      clearInterval(timer);
      return new Promise((resolve) => wss.close(resolve));
    },
  };
}
