## Add `robinliang0829-lgtm/dsh-cloud-sync`

### What it is

One DSH bundle that ships two capabilities:

1. **OpenTelemetry GenAI observability** — reuses [`@loongsuite/dsh-plugin`](https://www.npmjs.com/package/@loongsuite/dsh-plugin) (declared as an npm dependency; the patch inserts the `loongsuite-observability` row) to export session / agent-loop / LLM / tool lifecycle events as OTel GenAI traces and metrics.
2. **Cloud state sync** — a new host plugin (`index.js`, zero third-party runtime deps) that connects outbound over WebSocket to a relay, pushes full session event logs (header + `snapshotEvents()`), and on connect pulls + rebuilds other devices' sessions via `sessions.create(id, { seed })` (cross-device resume).

### Manifest requirements

- `package.json` declares `dsh.bundle.patch: "./cordis.patch.yml"` and the repo root contains `cordis.patch.yml`:
  ```yaml
  - insert:
      - id: loongsuite-observability
        name: '@loongsuite/dsh-plugin'
      - id: dsh-cloud-sync
        name: 'dsh-cloud-sync'
        config: {}
  ```
- Real, runnable code (`index.js`, ~15 KB): WebSocket client, JSON-safe event serialization, incremental push, reconnect/backoff, heartbeat, `sync.list` / `sync.pull` resume, and a `/cloud-sync` slash command (`status` / `delete <sessionId>` / `resync`).
- The relay (`cloud-server/`) is a small Node.js WebSocket + REST server with optional token / multi-tenant isolation, included for end-to-end testing; it is not needed to use the plugin.

### Verification

- Plugin installed into a live DSH profile; both rows active (`include:loongsuite-observability`, `include:dsh-cloud-sync`).
- Cloud relay synced 8 real sessions; cross-device resume verified end-to-end (injected a session from a second device, restarted the relay, plugin pulled and rebuilt it with `isSeeded: true`).
- Relay multi-tenant + delete paths smoke-tested (11/11 assertions).

### Notes

- `category: session` (multi-device session state sync).
- The repo is brand new, so it may be under the 24-hour age guideline; happy to wait if needed before merge.
