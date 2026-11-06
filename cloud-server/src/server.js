/**
 * dsh-cloud-sync-server — reference cloud relay.
 *
 * A single Node.js process that:
 *   - accepts outbound WebSocket connections from the dsh-cloud-sync plugin
 *     (protocol in ../PROTOCOL.md), storing each device's full session event log;
 *   - persists state to a JSON file with debounced writes;
 *   - exposes a REST API to list devices/sessions and fetch (replay) event logs;
 *   - partitions devices into tenants by access token, so a device can only
 *     pull (sync.list / sync.pull) sessions owned by devices that share its
 *     token, and supports deleting a session from the cloud.
 *
 * Configuration (environment variables):
 *   PORT         HTTP/WS listen port            (default 8080)
 *   HOST         bind address                    (default 0.0.0.0)
 *   DATA_DIR     state directory                 (default ./data)
 *   AUTH_TOKEN   single shared secret (tenant)   (empty = no auth)
 *   AUTH_TOKENS  comma-separated secrets; each one is a distinct tenant
 *
 * Usage:
 *   npm install && npm start
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AUTH_TOKENS = new Set(
  [
    process.env.AUTH_TOKEN,
    ...(process.env.AUTH_TOKENS || '').split(',').map((s) => s.trim()),
  ].filter(Boolean),
);
const AUTH_ENABLED = AUTH_TOKENS.size > 0;
const SERVER_VERSION = '0.2.0';
const STARTED_AT = Date.now();
const STATE_FILE = path.join(DATA_DIR, 'store.json');

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
};

/** Token identity, never the raw secret: a token names a tenant. */
function tenantOf(token) {
  if (!AUTH_ENABLED) return '';
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function validToken(token) {
  if (!AUTH_ENABLED) return true;
  return typeof token === 'string' && AUTH_TOKENS.has(token);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let store = loadStore();

function loadStore() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (error) {
    console.error('[dsh-cloud-sync-server] failed to load store:', error.message);
  }
  return { devices: {} };
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStore();
  }, 250);
}

function saveStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    console.error('[dsh-cloud-sync-server] failed to save store:', error.message);
  }
}

function ensureDevice(deviceId) {
  let device = store.devices[deviceId];
  if (!device) {
    device = { deviceId, connected: false, sessions: {} };
    store.devices[deviceId] = device;
  }
  return device;
}

function sortEvents(events) {
  return events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

function upsertSession(deviceId, session) {
  const device = ensureDevice(deviceId);
  const header = session?.header ?? {};
  const id = header.id ?? session?.sessionId ?? `session-${Date.now()}`;
  const events = sortEvents(Array.isArray(session?.events) ? session.events.slice() : []);
  const lastSeq = events.length ? events[events.length - 1].seq ?? 0 : -1;
  device.sessions[id] = {
    id,
    header,
    seq: Math.max(session?.seq ?? 0, lastSeq + 1),
    closed: false,
    events,
    updatedAt: Date.now(),
  };
  device.updatedAt = Date.now();
  scheduleSave();
  return id;
}

function appendEvent(deviceId, sessionId, event) {
  const device = ensureDevice(deviceId);
  let s = device.sessions[sessionId];
  if (!s) {
    s = {
      id: sessionId,
      header: { id: sessionId },
      seq: (event?.seq ?? 0) + 1,
      closed: false,
      events: [],
      updatedAt: Date.now(),
    };
    device.sessions[sessionId] = s;
  }
  const seq = event?.seq ?? s.events.length;
  const idx = s.events.findIndex((e) => (e.seq ?? -1) === seq);
  if (idx >= 0) s.events[idx] = event;
  else s.events.push(event);
  sortEvents(s.events);
  s.seq = Math.max(s.seq ?? 0, seq + 1);
  s.updatedAt = Date.now();
  device.updatedAt = Date.now();
  scheduleSave();
}

function closeSession(deviceId, sessionId, finalSeq) {
  const device = ensureDevice(deviceId);
  const s = device.sessions[sessionId];
  if (s) {
    s.closed = true;
    if (typeof finalSeq === 'number') s.seq = Math.max(s.seq ?? 0, finalSeq);
    s.updatedAt = Date.now();
    device.updatedAt = Date.now();
    scheduleSave();
  }
}

function deleteSession(deviceId, sessionId) {
  const device = store.devices[deviceId];
  if (device?.sessions?.[sessionId]) {
    delete device.sessions[sessionId];
    device.updatedAt = Date.now();
    scheduleSave();
  }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function summarizeDevice(deviceId) {
  const d = store.devices[deviceId];
  if (!d) return null;
  return {
    deviceId,
    connected: !!d.connected,
    hostname: d.hostname ?? null,
    profile: d.profile ?? null,
    clientVersion: d.clientVersion ?? null,
    instanceId: d.instanceId ?? null,
    lastSeen: d.lastSeen ?? null,
    updatedAt: d.updatedAt ?? null,
    sessionCount: Object.keys(d.sessions ?? {}).length,
  };
}

function listDevices(tenant = '') {
  return Object.keys(store.devices)
    .filter((id) => store.devices[id].tenant === tenant)
    .map(summarizeDevice)
    .filter(Boolean);
}

function listDeviceSessions(deviceId) {
  const d = store.devices[deviceId];
  if (!d) return [];
  return Object.values(d.sessions).map(summarizeSession);
}

function summarizeSession(s) {
  return {
    id: s.id,
    seq: s.seq,
    closed: !!s.closed,
    eventCount: s.events.length,
    updatedAt: s.updatedAt,
    header: s.header,
  };
}

function listAllSessions(tenant = '') {
  const out = [];
  for (const deviceId of Object.keys(store.devices)) {
    if (store.devices[deviceId].tenant !== tenant) continue;
    for (const s of Object.values(store.devices[deviceId].sessions)) {
      out.push({ deviceId, ...summarizeSession(s) });
    }
  }
  return out;
}

function countSessions() {
  let n = 0;
  for (const d of Object.values(store.devices)) n += Object.keys(d.sessions ?? {}).length;
  return n;
}

// ---------------------------------------------------------------------------
// HTTP / REST
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(body));
}

/** Returns the caller's tenant key, or null when the request is not authorized. */
function authenticate(req, url) {
  if (!AUTH_ENABLED) return '';
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : (url.searchParams.get('token') || '');
  return AUTH_TOKENS.has(token) ? tenantOf(token) : null;
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const pathname = `/${parts.join('/')}`;

  // Health is an unauthenticated liveness check (aggregate counts only).
  if (pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      serverVersion: SERVER_VERSION,
      auth: AUTH_ENABLED ? 'enabled' : 'disabled',
      uptimeMs: Date.now() - STARTED_AT,
      devices: Object.keys(store.devices).length,
      sessions: countSessions(),
    });
  }

  const tenant = authenticate(req, url);
  if (tenant === null) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  if (pathname === '/devices') {
    return sendJson(res, 200, { devices: listDevices(tenant) });
  }

  if (pathname === '/sessions') {
    return sendJson(res, 200, { sessions: listAllSessions(tenant) });
  }

  if (parts[0] === 'devices' && parts.length >= 2) {
    const deviceId = decodeURIComponent(parts[1]);
    const device = store.devices[deviceId];
    if (!device || device.tenant !== tenant) {
      return sendJson(res, 404, { error: 'device not found' });
    }

    if (parts.length === 2) {
      return sendJson(res, 200, { device: summarizeDevice(deviceId) });
    }

    if (parts[2] === 'sessions' && parts.length === 3) {
      return sendJson(res, 200, { sessions: listDeviceSessions(deviceId) });
    }

    if (parts[2] === 'sessions' && parts.length === 4) {
      const sid = decodeURIComponent(parts[3]);
      if (req.method === 'DELETE') {
        if (!device.sessions[sid]) return sendJson(res, 404, { error: 'session not found' });
        deleteSession(deviceId, sid);
        return sendJson(res, 200, { ok: true, deleted: sid });
      }
      const s = device.sessions[sid];
      if (!s) return sendJson(res, 404, { error: 'session not found' });
      return sendJson(res, 200, { session: summarizeSession(s) });
    }

    if (parts[2] === 'sessions' && parts.length === 5 && parts[4] === 'events') {
      const sid = decodeURIComponent(parts[3]);
      const s = device.sessions[sid];
      if (!s) return sendJson(res, 404, { error: 'session not found' });
      const from = Number(url.searchParams.get('from') || 0);
      const toParam = url.searchParams.get('to');
      const to = toParam === null ? undefined : Number(toParam);
      const events = s.events.filter(
        (e) => (e.seq ?? 0) >= from && (to === undefined || (e.seq ?? 0) < to),
      );
      if (url.searchParams.get('format') === 'ndjson') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', ...CORS_HEADERS });
        res.end(events.map((e) => JSON.stringify(e)).join('\n'));
        return;
      }
      return sendJson(res, 200, {
        sessionId: sid,
        deviceId,
        seq: s.seq,
        closed: s.closed,
        count: events.length,
        events,
      });
    }
  }

  sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer(handleRequest);

function wsSend(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function handleWsMessage(ws, msg, ctx) {
  switch (msg.type) {
    case 'hello': {
      if (!validToken(msg.token)) {
        wsSend(ws, { type: 'welcome', ok: false, error: 'unauthorized' });
        ws.close(1008, 'unauthorized');
        return;
      }
      const deviceId = String(msg.deviceId || 'unknown');
      ctx.deviceId = deviceId;
      ctx.tenant = tenantOf(msg.token);
      const d = ensureDevice(deviceId);
      d.connected = true;
      d.lastSeen = Date.now();
      d.tenant = ctx.tenant;
      d.instanceId = msg.instanceId;
      d.clientVersion = msg.clientVersion;
      d.hostname = msg.hostname;
      d.profile = msg.profile;
      scheduleSave();
      wsSend(ws, { type: 'welcome', ok: true, serverVersion: SERVER_VERSION, deviceId });
      break;
    }
    case 'session.upsert': {
      if (!ctx.deviceId) return wsSend(ws, { type: 'ack', ok: false, error: 'hello-required' });
      const id = upsertSession(ctx.deviceId, msg.session);
      wsSend(ws, { type: 'ack', ok: true, sessionId: id });
      break;
    }
    case 'session.append': {
      if (!ctx.deviceId) return wsSend(ws, { type: 'ack', ok: false, error: 'hello-required' });
      if (!msg.sessionId) return wsSend(ws, { type: 'ack', ok: false, error: 'missing-sessionId' });
      appendEvent(ctx.deviceId, msg.sessionId, msg.event);
      wsSend(ws, { type: 'ack', ok: true });
      break;
    }
    case 'session.close': {
      if (!ctx.deviceId) return wsSend(ws, { type: 'ack', ok: false, error: 'hello-required' });
      closeSession(ctx.deviceId, msg.sessionId, msg.finalSeq);
      wsSend(ws, { type: 'ack', ok: true });
      break;
    }
    case 'session.delete': {
      if (!ctx.deviceId) return wsSend(ws, { type: 'ack', ok: false, error: 'hello-required' });
      deleteSession(ctx.deviceId, msg.sessionId);
      wsSend(ws, { type: 'ack', ok: true });
      break;
    }
    case 'sync.list': {
      if (!ctx.deviceId) return wsSend(ws, { type: 'ack', ok: false, error: 'hello-required' });
      const sessions = [];
      for (const deviceId of Object.keys(store.devices)) {
        if (deviceId === ctx.deviceId) continue; // exclude the requester's own device
        if (store.devices[deviceId].tenant !== ctx.tenant) continue; // tenant isolation
        for (const s of Object.values(store.devices[deviceId].sessions ?? {})) {
          sessions.push({
            deviceId,
            sessionId: s.id,
            seq: s.seq,
            closed: s.closed,
            updatedAt: s.updatedAt,
          });
        }
      }
      wsSend(ws, { type: 'sync.list', sessions });
      break;
    }
    case 'sync.pull': {
      if (!ctx.deviceId) return wsSend(ws, { type: 'ack', ok: false, error: 'hello-required' });
      const owner = store.devices[msg.deviceId];
      const s = owner?.tenant === ctx.tenant ? owner.sessions?.[msg.sessionId] : undefined;
      wsSend(ws, {
        type: 'sync.session',
        deviceId: msg.deviceId,
        sessionId: msg.sessionId,
        session: s ? { header: s.header, seq: s.seq, events: s.events } : null,
      });
      break;
    }
    case 'ping': {
      wsSend(ws, { type: 'pong', time: Date.now() });
      break;
    }
    default:
      wsSend(ws, { type: 'ack', ok: false, error: 'unknown-type' });
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const ctx = { deviceId: null, tenant: '' };
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      wsSend(ws, { type: 'ack', ok: false, error: 'invalid-json' });
      return;
    }
    try {
      handleWsMessage(ws, msg, ctx);
    } catch (error) {
      wsSend(ws, { type: 'ack', ok: false, error: String(error?.message ?? error) });
    }
  });
  ws.on('close', () => {
    if (ctx.deviceId) {
      const d = store.devices[ctx.deviceId];
      if (d) {
        d.connected = false;
        d.lastSeen = Date.now();
        scheduleSave();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  console.log(`[dsh-cloud-sync-server] listening on http://${HOST}:${PORT} (ws /ws)`);
  console.log(`[dsh-cloud-sync-server] data dir: ${DATA_DIR}`);
  console.log(`[dsh-cloud-sync-server] auth: ${AUTH_ENABLED ? `enabled (${AUTH_TOKENS.size} tenant(s))` : 'disabled'}`);
});

function shutdown() {
  saveStore();
  wss?.clients.forEach((ws) => ws.close(1001, 'server shutdown'));
  wss?.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
