/**
 * dsh-cloud-sync — cloud state-sync + cross-device resume client for DeepSeek Harness.
 *
 * Runs as a Host plugin. On startup it opens an outbound WebSocket to a cloud
 * relay (outbound, so it works behind NAT) and pushes the full session event
 * log — session header plus `snapshotEvents()` — incrementally on every
 * `session/event`, with a full re-sync after (re)connect. The cloud therefore
 * holds a complete, replayable record of every local DSH install's state.
 *
 * When `resume` is enabled it also pulls remote sessions back: on connect it
 * asks the cloud for sessions that other devices own, and rehydrates each one
 * locally with `sessions.create(id, { seed })`, so a conversation started on
 * device A can be seen and continued on device B.
 *
 * Ships alongside the reused LoongSuite OTel GenAI observability plugin (see
 * cordis.patch.yml), which owns the OpenTelemetry trace/metric pipeline.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-cloud-sync';
export const inject = ['sessions', 'commands'];

/**
 * Normalize the row config (a plain object) with defaults and environment
 * fallbacks. A Host-only bundle ships no dependencies (Node ESM cannot reach
 * the profile's pnpm node_modules from a linked checkout), so we hand-roll the
 * small config surface instead of using a schema library.
 */
function readConfig(raw = {}) {
  const env = process.env;
  const toBool = (v, d) => {
    if (v === undefined || v === null) return d;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return !(v === '' || v === '0' || v === 'false');
    return Boolean(v);
  };
  const toNum = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    enabled: toBool(raw.enabled, true),
    server: String(raw.server || env.DSH_CLOUD_SYNC_SERVER || 'ws://127.0.0.1:8080/ws'),
    token: String(raw.token || env.DSH_CLOUD_SYNC_TOKEN || ''),
    deviceId: String(raw.deviceId || env.DSH_CLOUD_SYNC_DEVICE || ''),
    resume: toBool(raw.resume, true),
    resumeOnlyFrom: Array.isArray(raw.resumeOnlyFrom) ? raw.resumeOnlyFrom.map(String) : [],
    resumeMaxSessions: toNum(raw.resumeMaxSessions, 20),
    reconnectMinMs: toNum(raw.reconnectMinMs, 500),
    reconnectMaxMs: toNum(raw.reconnectMaxMs, 30000),
    heartbeatMs: toNum(raw.heartbeatMs, 30000),
    debug: toBool(raw.debug, false),
  };
}

const SETTINGS_PATH = path.join(os.homedir(), '.dsh', 'cloud-sync', 'settings.json');

/** Read the UI-persisted settings file (missing/corrupt file is just "no overrides"). */
function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge a patch into the settings file and return the merged values. */
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    /* best effort — the in-memory reconfigure still applies */
  }
  return next;
}

const CLIENT_VERSION = '0.4.0';

function formatStatus(s) {
  return [
    'dsh-cloud-sync 同步状态',
    `- 设备：${s.deviceId}`,
    `- 云端：${s.server}`,
    `- 连接：${s.connected ? '已连接' : '未连接'}`,
    `- 本地会话数：${s.localSessionCount}`,
    `- 跨设备续接：${s.resume ? '开' : '关'}`,
    `- 客户端版本：${s.clientVersion}`,
  ].join('\n');
}

/**
 * Replacer that keeps DSH session/event payloads JSON-safe. Buffers and
 * ArrayBuffers become `{ __bytes: base64 }`, BigInt becomes `{ __bigint }`,
 * Error becomes `{ __error }`, and functions/symbols are dropped.
 */
function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  if (value instanceof Error) {
    return { __error: { name: value.name, message: value.message, stack: value.stack } };
  }
  if (value instanceof ArrayBuffer) {
    return { __bytes: Buffer.from(value).toString('base64') };
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { __bytes: Buffer.from(bytes).toString('base64') };
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  return value;
}

/** Inverse of {@link jsonReplacer}: turns the transport markers back into values. */
function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    if (typeof value.__bytes === 'string' && Object.keys(value).length === 1) {
      return Buffer.from(value.__bytes, 'base64');
    }
    if (typeof value.__bigint === 'string' && Object.keys(value).length === 1) {
      return BigInt(value.__bigint);
    }
    if (value.__error && typeof value.__error === 'object') {
      const err = new Error(value.__error.message);
      err.name = value.__error.name || 'Error';
      if (value.__error.stack) err.stack = value.__error.stack;
      return err;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = revive(v);
    return out;
  }
  return value;
}

class CloudSyncClient {
  constructor(opts) {
    this.opts = opts;
    this.log = opts.logger;
    this.debug = opts.debug;
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.pending = new Map();
    this.lastError = null;
    this.lastConnectedAt = null;
  }

  start() {
    if (typeof WebSocket === 'undefined') {
      this.log?.error('[dsh-cloud-sync] runtime has no WebSocket client; sync disabled');
      return;
    }
    this.connect();
  }

  connect() {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.opts.server);
    } catch (error) {
      this.log?.warn(`[dsh-cloud-sync] cannot open WebSocket to ${this.opts.server}: ${String(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => this.onOpen());
    ws.addEventListener('message', (event) => this.onMessage(event));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', (error) => this.onError(error));
  }

  onOpen() {
    this.attempt = 0;
    this.lastError = null;
    this.lastConnectedAt = Date.now();
    this.send({
      type: 'hello',
      deviceId: this.opts.deviceId,
      instanceId: this.opts.instanceId,
      token: this.opts.token || '',
      clientVersion: CLIENT_VERSION,
      hostname: os.hostname(),
      profile: process.env.DSH_PROFILE || '',
      time: Date.now(),
    });
    this.startHeartbeat();
    this.resyncAll();
    if (this.opts.resume) this.pullRemoteSessions();
  }

  onMessage(event) {
    const text = typeof event.data === 'string' ? event.data : String(event.data ?? '');
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (this.debug && msg.type !== 'pong') {
      this.log?.info(`[dsh-cloud-sync] <- ${msg.type ?? 'unknown'}`);
    }
    if (msg.reqId) {
      const pending = this.pending.get(msg.reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.reqId);
        pending.resolve(msg);
        return;
      }
    }
    switch (msg.type) {
      case 'sync.list':
        this.onSyncList(msg);
        break;
      case 'sync.session':
        this.onSyncSession(msg);
        break;
      default:
        break; // welcome / ack / pong
    }
  }

  onClose() {
    this.stopHeartbeat();
    this.ws = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('cloud connection closed'));
    }
    this.pending.clear();
    if (this.closed) return;
    this.scheduleReconnect();
  }

  onError(error) {
    this.log?.warn(`[dsh-cloud-sync] websocket error: ${String(error?.message ?? error)}`);
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(
      this.opts.reconnectMaxMs,
      this.opts.reconnectMinMs * 2 ** this.attempt,
    );
    this.attempt += 1;
    this.log?.info(`[dsh-cloud-sync] reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(
      () => this.send({ type: 'ping', time: Date.now() }),
      this.opts.heartbeatMs,
    );
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  resyncAll() {
    for (const session of this.opts.sessions.list()) this.pushSnapshot(session);
  }

  pushSnapshot(session) {
    let snapshot;
    try {
      snapshot = { header: session.header, seq: session.seq, events: session.snapshotEvents() };
    } catch (error) {
      this.log?.warn(`[dsh-cloud-sync] failed to snapshot session ${String(session.id)}: ${String(error)}`);
      return;
    }
    this.send({ type: 'session.upsert', session: snapshot });
  }

  pushEvent(session, event) {
    this.send({ type: 'session.append', sessionId: session.id, event });
  }

  closeSession(session) {
    this.send({ type: 'session.close', sessionId: session.id, finalSeq: session.seq });
  }

  /** Remove a session from the cloud store (manual or on local disposal). */
  deleteSession(sessionId) {
    this.send({ type: 'session.delete', sessionId });
  }

  getStatus() {
    let localSessionCount = 0;
    try {
      localSessionCount = this.opts.sessions.list().length;
    } catch {
      /* ignore */
    }
    return {
      connected: !!(this.ws && this.ws.readyState === 1),
      server: this.opts.server,
      deviceId: this.opts.deviceId,
      localSessionCount,
      resume: this.opts.resume,
      tokenSet: !!this.opts.token,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      clientVersion: CLIENT_VERSION,
    };
  }

  resyncRemote() {
    if (!this.ws || this.ws.readyState !== 1) {
      return { ok: false, error: 'not connected to cloud' };
    }
    this.resyncAll();
    return { ok: true };
  }

  /** Round-trip a request/response over the websocket (the relay echoes reqId). */
  request(type, payload = {}, timeoutMs = 8000) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('not connected to cloud'));
    }
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('cloud request timed out'));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.send({ type, reqId, ...payload });
    });
  }

  /** List sessions the relay holds for devices other than this one. */
  async listRemoteSessions() {
    const response = await this.request('sync.list', {});
    return Array.isArray(response?.sessions) ? response.sessions : [];
  }

  /** Delete a session from the cloud store (optionally targeting another device). */
  async deleteRemoteSession(sessionId, deviceId) {
    if (!sessionId) throw new Error('sessionId is required');
    await this.request('session.delete', deviceId ? { sessionId, deviceId } : { sessionId });
    return { ok: true, sessionId, deviceId };
  }

  // ---- cross-device resume -------------------------------------------------

  pullRemoteSessions() {
    this.send({ type: 'sync.list' });
  }

  onSyncList(msg) {
    const remote = Array.isArray(msg.sessions) ? msg.sessions : [];
    const localIds = new Set(this.opts.sessions.list().map((s) => s.id));
    const allow = this.opts.resumeOnlyFrom?.length ? new Set(this.opts.resumeOnlyFrom) : null;
    const seen = new Set();
    const wanted = [];
    const ordered = remote.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    for (const s of ordered) {
      if (!s?.sessionId) continue;
      if (allow && !allow.has(s.deviceId)) continue;
      if (localIds.has(s.sessionId)) continue;
      if (seen.has(s.sessionId)) continue;
      seen.add(s.sessionId);
      wanted.push(s);
      if (wanted.length >= this.opts.resumeMaxSessions) break;
    }
    if (this.debug) {
      this.log?.info(`[dsh-cloud-sync] resume: ${remote.length} remote, pulling ${wanted.length}`);
    }
    for (const s of wanted) {
      this.send({ type: 'sync.pull', deviceId: s.deviceId, sessionId: s.sessionId });
    }
  }

  onSyncSession(msg) {
    if (!msg?.session) return;
    try {
      this.restoreSession(msg.deviceId, msg.session);
    } catch (error) {
      this.log?.warn(`[dsh-cloud-sync] failed to restore session: ${String(error)}`);
    }
  }

  restoreSession(deviceId, session) {
    const header = session.header ?? {};
    const id = header.id ?? session.sessionId;
    if (!id) return;
    if (this.opts.sessions.get(id)) return; // already live (race guard)
    const events = (Array.isArray(session.events) ? session.events : [])
      .map(revive)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    if (events.length === 0) return;

    const meta = {};
    if (typeof header.createdAt === 'number') meta.createdAt = header.createdAt;
    if (typeof header.cwd === 'string' && header.cwd) meta.cwd = header.cwd;
    if (header.parentSession) meta.parentSession = header.parentSession;
    if (header.origin === 'subagent') meta.origin = 'subagent';
    if (typeof header.delegationDepth === 'number') meta.delegationDepth = header.delegationDepth;
    if (header.agentPreset) meta.agentPreset = header.agentPreset;
    meta.isSeeded = true;

    this.opts.sessions.create(id, {
      seed: events,
      inheritedEventCount: events.length,
      meta,
    });
    this.log?.info(`[dsh-cloud-sync] restored session "${id}" from device "${deviceId}" (${events.length} events)`);
  }

  // ---- transport -----------------------------------------------------------

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj, jsonReplacer));
      } catch (error) {
        this.log?.warn(`[dsh-cloud-sync] send failed: ${String(error)}`);
      }
    }
  }

  close() {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

export function apply(ctx, config) {
  const dsh = ctx;
  const cfg = readConfig({ ...(config || {}), ...loadSettings() });
  if (!cfg.enabled) {
    dsh.logger.info('[dsh-cloud-sync] disabled by config');
    return;
  }

  const fallbackDeviceId = () => `${process.env.DSH_PROFILE || 'desktop'}@${os.hostname()}`;

  const makeClient = (overrides = {}) => {
    const merged = { ...cfg, ...loadSettings(), ...overrides };
    return new CloudSyncClient({
      logger: dsh.logger,
      server: String(merged.server || 'ws://127.0.0.1:8080/ws'),
      token: String(merged.token ?? ''),
      deviceId: String(merged.deviceId || '').trim() || fallbackDeviceId(),
      instanceId: randomUUID(),
      sessions: dsh.sessions,
      resume: merged.resume !== false,
      resumeOnlyFrom: Array.isArray(merged.resumeOnlyFrom) ? merged.resumeOnlyFrom.map(String) : [],
      resumeMaxSessions: Number(merged.resumeMaxSessions) || 20,
      reconnectMinMs: Number(merged.reconnectMinMs) || 500,
      reconnectMaxMs: Number(merged.reconnectMaxMs) || 30000,
      heartbeatMs: Number(merged.heartbeatMs) || 30000,
      debug: !!merged.debug,
    });
  };

  let client = makeClient();
  client.start();

  const disposers = [
    dsh.on('session/created', (session) => client.pushSnapshot(session)),
    dsh.on('session/event', (session, event) => client.pushEvent(session, event)),
    dsh.on('session/disposed', (session) => client.deleteSession(session.id)),
  ];

  const reconfigure = (patch) => {
    saveSettings(patch);
    const previous = client;
    client = makeClient();
    previous.close();
    client.start();
    return client;
  };

  if (dsh.commands?.register) {
    disposers.push(
      dsh.commands.register({
        name: 'cloud-sync',
        description: '管理 dsh-cloud-sync 云端同步：status / delete <sessionId> / resync',
        input: { hint: 'status | delete <sessionId> | resync' },
        handler: async (inv) => {
          const raw = String(inv?.rawInput || '').trim();
          const [action, ...rest] = raw.split(/\s+/);
          try {
            if (!action || action === 'status') {
              return { kind: 'success', text: formatStatus(client.getStatus()) };
            }
            if (action === 'delete') {
              const sid = rest.join(' ').trim();
              if (!sid) return { kind: 'error', text: '用法：/cloud-sync delete <sessionId>' };
              await client.deleteRemoteSession(sid);
              return { kind: 'success', text: `已从云端删除会话 ${sid}` };
            }
            if (action === 'resync') {
              const r = client.resyncRemote();
              return r.ok
                ? { kind: 'success', text: `已触发全量重同步（${client.getStatus().localSessionCount} 个本地会话）` }
                : { kind: 'error', text: r.error };
            }
            return { kind: 'error', text: `未知动作 "${action}"，可用：status | delete <sessionId> | resync` };
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) };
          }
        },
      }),
    );
  }

  const webServer = typeof dsh.get === 'function' ? dsh.get('webServer') : undefined;
  if (webServer?.register) {
    disposers.push(
      webServer.register({
        kind: 'prefix',
        path: '/cloud-sync',
        handler: async (req, res) => {
          const send = (code, body) => {
            res.statusCode = code;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(body));
          };
          const readBody = () =>
            new Promise((resolve) => {
              let buf = '';
              req.on('data', (chunk) => {
                buf += chunk;
                if (buf.length > 1_000_000) req.destroy();
              });
              req.on('end', () => {
                try {
                  resolve(buf ? JSON.parse(buf) : {});
                } catch {
                  resolve({});
                }
              });
              req.on('error', () => resolve({}));
            });
          const pathname = String(req.url || '/').split('?')[0];
          const tail = pathname.slice('/cloud-sync'.length) || '/';
          try {
            if (req.method === 'GET' && tail === '/status') {
              return send(200, { ok: true, ...client.getStatus() });
            }
            if (req.method === 'GET' && tail === '/sessions') {
              const sessions = dsh.sessions.list().map((session) => ({
                id: session.id,
                createdAt: session.header?.createdAt ?? null,
                cwd: session.header?.cwd ?? null,
                agentPreset: session.header?.agentPreset ?? null,
                seq: session.seq,
              }));
              return send(200, { ok: true, sessions });
            }
            if (req.method === 'GET' && tail === '/remote') {
              return send(200, { ok: true, sessions: await client.listRemoteSessions() });
            }
            if (req.method === 'POST' && tail === '/config') {
              const body = await readBody();
              const patch = {};
              for (const key of ['server', 'token', 'deviceId']) {
                if (typeof body[key] === 'string' && body[key].trim() !== '') patch[key] = body[key].trim();
              }
              if (typeof body.resume === 'boolean') patch.resume = body.resume;
              reconfigure(patch);
              return send(200, { ok: true, ...client.getStatus() });
            }
            if (req.method === 'POST' && tail === '/resync') {
              const result = client.resyncRemote();
              return send(200, result.ok ? { ok: true } : { ok: false, error: result.error });
            }
            if (req.method === 'POST' && tail === '/delete') {
              const body = await readBody();
              await client.deleteRemoteSession(
                String(body.sessionId || ''),
                body.deviceId ? String(body.deviceId) : undefined,
              );
              return send(200, { ok: true });
            }
            return send(404, { ok: false, error: 'not found' });
          } catch (error) {
            return send(500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }),
    );
  } else {
    dsh.logger.info('[dsh-cloud-sync] webServer unavailable — settings UI routes are disabled');
  }

  dsh.effect(() => async () => {
    for (const dispose of disposers.reverse()) dispose();
    client.close();
  }, 'dsh-cloud-sync: detach listeners and close websocket');

  dsh.logger.info(
    `[dsh-cloud-sync] syncing as device "${client.getStatus().deviceId}" to ${client.getStatus().server}`,
  );
}
