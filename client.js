/**
 * dsh-cloud-sync — browser half.
 *
 * Adds a "Cloud Sync" page to Settings (settings.section). The page reads and
 * writes the Host plugin through same-origin HTTP routes the Host registers on
 * the browser carrier (`/cloud-sync/*`), so it stays version-stable and needs
 * no remote-RPC surface. All visible text is routed through the Client locale
 * service; colours use `--dsw-alias-*` theme tokens with safe fallbacks.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloud-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const API = '/cloud-sync';

    async function api(path, init) {
      const res = await fetch(API + path, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    }
    const post = (path, body) =>
      api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px', minWidth: 0 },
      card: {
        border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,.25))',
        borderRadius: 10,
        padding: 14,
        background: 'var(--dsw-alias-bg-secondary, transparent)',
        minWidth: 0,
      },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      label: { fontSize: 12, opacity: 0.72, marginBottom: 4, display: 'block' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 9px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'inherit',
        font: 'inherit',
      },
      btn: {
        padding: '7px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      btnDanger: {
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid rgba(210,80,80,.5)',
        background: 'transparent',
        color: '#d05050',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        whiteSpace: 'nowrap',
      },
      dot: (ok) => ({ width: 8, height: 8, borderRadius: 4, background: ok ? '#2e9e5b' : '#c94a4a', display: 'inline-block', marginRight: 6 }),
      muted: { fontSize: 12, opacity: 0.7 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      msg: (ok) => ({ fontSize: 12, color: ok ? '#2e9e5b' : '#c94a4a' }),
      list: { display: 'flex', flexDirection: 'column', gap: 6 },
      item: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '6px 8px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-primary, rgba(128,128,128,.06))',
        minWidth: 0,
      },
      ellipsis: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    };

    function Field(props) {
      return h(
        'label',
        { style: { display: 'block', flex: '1 1 200px', minWidth: 0 } },
        h('span', { style: styles.label }, props.label),
        h('input', {
          style: styles.input,
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder,
          onChange: (e) => props.onChange(e.target.value),
        }),
      );
    }

    function CloudSyncPanel(props) {
      const t = props.t;
      const [status, setStatus] = useState(null);
      const [local, setLocal] = useState([]);
      const [remote, setRemote] = useState(null);
      const [form, setForm] = useState({ server: '', token: '', deviceId: '', resume: true });
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);

      const refresh = useCallback(async () => {
        try {
          const s = await api('/status');
          setStatus(s);
          setForm((f) => ({
            ...f,
            server: f.server || s.server || '',
            deviceId: f.deviceId || s.deviceId || '',
            resume: s.resume !== false,
          }));
          const l = await api('/sessions');
          setLocal(Array.isArray(l.sessions) ? l.sessions : []);
        } catch (e) {
          setNote({ ok: false, text: String((e && e.message) || e) });
        }
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 4000);
        return () => clearInterval(timer);
      }, [refresh]);

      const run = async (fn) => {
        setBusy(true);
        setNote(null);
        try {
          await fn();
        } catch (e) {
          setNote({ ok: false, text: String((e && e.message) || e) });
        } finally {
          setBusy(false);
        }
      };

      const save = () =>
        run(async () => {
          const body = { server: form.server, deviceId: form.deviceId, resume: !!form.resume };
          if (form.token) body.token = form.token;
          const s = await post('/config', body);
          setStatus(s);
          setForm((f) => ({ ...f, token: '' }));
          setNote({ ok: true, text: t('saved') });
        });

      const resync = () =>
        run(async () => {
          await post('/resync', {});
          setNote({ ok: true, text: t('resynced') });
          await refresh();
        });

      const loadRemote = () =>
        run(async () => {
          const r = await api('/remote');
          setRemote(Array.isArray(r.sessions) ? r.sessions : []);
        });

      const delLocal = (id) =>
        run(async () => {
          await post('/delete', { sessionId: id });
          setNote({ ok: true, text: t('deleted') });
          await refresh();
        });

      const delRemote = (s) =>
        run(async () => {
          await post('/delete', { sessionId: s.sessionId, deviceId: s.deviceId });
          setNote({ ok: true, text: t('deleted') });
          await loadRemote();
        });

      const connected = !!(status && status.connected);
      return h(
        'div',
        { style: styles.wrap },
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: { ...styles.row, justifyContent: 'space-between' } },
            h(
              'div',
              null,
              h('div', { style: { fontWeight: 600, fontSize: 14 } }, t('title')),
              h('div', { style: styles.muted }, t('subtitle')),
            ),
            h(
              'div',
              { style: { ...styles.mono, display: 'flex', alignItems: 'center' } },
              h('span', { style: styles.dot(connected) }),
              connected ? t('connected') : t('disconnected'),
            ),
          ),
          h(
            'div',
            { style: { ...styles.muted, marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 14 } },
            h('span', null, `${t('server')}: ${(status && status.server) || '—'}`),
            h('span', null, `${t('device')}: ${(status && status.deviceId) || '—'}`),
            h('span', null, `${t('localSessions')}: ${(status && status.localSessionCount) ?? '—'}`),
            h('span', null, `${t('token')}: ${status && status.tokenSet ? t('tokenSet') : t('tokenUnset')}`),
          ),
          status && status.lastError
            ? h('div', { style: { ...styles.msg(false), marginTop: 8 } }, status.lastError)
            : null,
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('connection')),
          h(
            'div',
            { style: styles.row },
            h(Field, {
              label: t('server'),
              value: form.server,
              placeholder: 'ws://127.0.0.1:8080/ws',
              onChange: (v) => setForm((f) => ({ ...f, server: v })),
            }),
            h(Field, {
              label: t('device'),
              value: form.deviceId,
              placeholder: t('devicePlaceholder'),
              onChange: (v) => setForm((f) => ({ ...f, deviceId: v })),
            }),
          ),
          h(
            'div',
            { style: { marginTop: 10 } },
            h(Field, {
              label: t('tokenHint'),
              type: 'password',
              value: form.token,
              placeholder: status && status.tokenSet ? t('tokenSetPlaceholder') : t('tokenUnsetPlaceholder'),
              onChange: (v) => setForm((f) => ({ ...f, token: v })),
            }),
          ),
          h(
            'div',
            { style: { ...styles.row, marginTop: 12 } },
            h(
              'label',
              { style: { ...styles.row, gap: 6, fontSize: 13, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: !!form.resume,
                onChange: (e) => setForm((f) => ({ ...f, resume: e.target.checked })),
              }),
              t('resume'),
            ),
            h('div', { style: { flex: 1 } }),
            h('button', { style: styles.btn, disabled: busy, onClick: save }, t('save')),
            h('button', { style: styles.btn, disabled: busy, onClick: resync }, t('resync')),
          ),
        ),
        note ? h('div', { style: styles.msg(note.ok) }, note.text) : null,
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: { ...styles.row, justifyContent: 'space-between', marginBottom: 8 } },
            h('div', { style: { fontWeight: 600 } }, `${t('localList')} (${local.length})`),
            h('button', { style: styles.btn, disabled: busy, onClick: refresh }, t('refresh')),
          ),
          local.length === 0
            ? h('div', { style: styles.muted }, t('noLocal'))
            : h(
                'div',
                { style: styles.list },
                local.map((s) =>
                  h(
                    'div',
                    { key: s.id, style: styles.item },
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h('div', { style: { ...styles.mono, ...styles.ellipsis } }, s.id),
                      h(
                        'div',
                        { style: styles.muted },
                        `${s.seq} ${t('events')}${s.agentPreset ? ` · ${s.agentPreset}` : ''}`,
                      ),
                    ),
                    h('button', { style: styles.btnDanger, disabled: busy, onClick: () => delLocal(s.id) }, t('deleteCloud')),
                  ),
                ),
              ),
        ),
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: { ...styles.row, justifyContent: 'space-between', marginBottom: 8 } },
            h('div', { style: { fontWeight: 600 } }, t('remoteList')),
            h('button', { style: styles.btn, disabled: busy, onClick: loadRemote }, t('loadRemote')),
          ),
          remote === null
            ? h('div', { style: styles.muted }, t('remoteHint'))
            : remote.length === 0
              ? h('div', { style: styles.muted }, t('noRemote'))
              : h(
                  'div',
                  { style: styles.list },
                  remote.map((s) =>
                    h(
                      'div',
                      { key: `${s.deviceId}/${s.sessionId}`, style: styles.item },
                      h(
                        'div',
                        { style: { minWidth: 0 } },
                        h('div', { style: { ...styles.mono, ...styles.ellipsis } }, s.sessionId),
                        h(
                          'div',
                          { style: styles.muted },
                          `${s.deviceId} · ${s.seq} ${t('events')}${s.closed ? ` · ${t('closed')}` : ''}`,
                        ),
                      ),
                      h('button', { style: styles.btnDanger, disabled: busy, onClick: () => delRemote(s) }, t('delete')),
                    ),
                  ),
                ),
        ),
      );
    }

    const DICTS = {
      en: {
        title: 'Cloud Sync',
        subtitle: 'Multi-device session sync and cross-device resume',
        connected: 'Connected',
        disconnected: 'Disconnected',
        server: 'Relay',
        device: 'Device',
        localSessions: 'Local sessions',
        token: 'Token',
        tokenSet: 'set',
        tokenUnset: 'unset',
        connection: 'Connection',
        devicePlaceholder: 'default: host name',
        tokenHint: 'Token (leave blank to keep current)',
        tokenSetPlaceholder: 'already set — leave blank to keep',
        tokenUnsetPlaceholder: 'not set',
        resume: 'Pull and rebuild other devices\u2019 sessions automatically',
        save: 'Save & reconnect',
        resync: 'Re-sync now',
        refresh: 'Refresh',
        localList: 'Local sessions',
        remoteList: 'Sessions on other devices',
        loadRemote: 'Load from cloud',
        remoteHint: 'Click "Load from cloud" to list sessions held for other devices.',
        noLocal: 'No local sessions yet.',
        noRemote: 'No sessions on other devices.',
        events: 'events',
        closed: 'closed',
        delete: 'Delete',
        deleteCloud: 'Delete cloud copy',
        saved: 'Saved — reconnected.',
        resynced: 'Re-sync requested.',
        deleted: 'Deleted from cloud.',
      },
      zh: {
        title: '云端同步',
        subtitle: '多设备会话同步与跨设备续接',
        connected: '已连接',
        disconnected: '未连接',
        server: '中继',
        device: '设备',
        localSessions: '本地会话',
        token: '凭据',
        tokenSet: '已设置',
        tokenUnset: '未设置',
        connection: '连接设置',
        devicePlaceholder: '默认：主机名',
        tokenHint: 'Token（留空表示不修改）',
        tokenSetPlaceholder: '已设置，留空不改',
        tokenUnsetPlaceholder: '未设置',
        resume: '自动拉取并重建其他设备的会话',
        save: '保存并重连',
        resync: '立即重同步',
        refresh: '刷新',
        localList: '本地会话',
        remoteList: '其他设备的会话',
        loadRemote: '从云端拉取',
        remoteHint: '点击「从云端拉取」查看其他设备的会话。',
        noLocal: '暂无本地会话。',
        noRemote: '没有其他设备的会话。',
        events: '条事件',
        closed: '已关闭',
        delete: '删除',
        deleteCloud: '删除云端副本',
        saved: '已保存并重连。',
        resynced: '已触发重同步。',
        deleted: '已从云端删除。',
      },
    };

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale;
        try {
          locale.register('dsh-cloud-sync', 'en', DICTS.en);
          locale.register('dsh-cloud-sync', 'zh', DICTS.zh);
        } catch {
          /* dictionaries may already be registered on hot reload */
        }
        const t = locale.bind('dsh-cloud-sync');
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'cloud-sync',
              order: 35,
              label: () => t('title'),
            },
            (ownerProps) => h(CloudSyncPanel, { ...ownerProps, t }),
          ),
        );
      },
    };
  },
});
