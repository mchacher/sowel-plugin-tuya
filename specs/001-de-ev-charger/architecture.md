# Spec 001 — Architecture

## Layers

```
Sowel core (PluginDeps: settingsManager, deviceManager, logger)
        │  createPlugin(deps)
        ▼
TuyaPlugin (src/index.ts)                    settings → one DeviceSession; status aggregation; executeOrder routing
        │
        ▼
DeviceSession (src/session/device-session.ts) one per device: queue, DP cache, poll, reconnect/backoff,
        │                                     online/offline, profile match, publish, verified writes
        ├──────────────► ProductProfile (src/profiles/)      pure: match(dps), discovery, decode(dps), encode(order)
        ▼
TuyaTransport (src/transport/transport.ts)   interface: connect, disconnect, getAll, set, events
        │
        ▼
TuyapiTransport (src/transport/tuyapi-transport.ts)          the only file that imports `tuyapi`
```

Three rules hold the boundary:

- **Profiles are pure.** No I/O, no timers, no logger. `decode(dps)` is a function of a DP snapshot, `encode(key, value, dps)` returns the DPs to write or a refusal. Everything product-specific lives there, so a new product is a new profile file and its fixtures.
- **The session knows no product.** It holds a `ProductProfile` and never names a DP id.
- **Only the transport knows `tuyapi`.** Tests replace it with a `FakeTransport` driven by fixtures; swapping the library later touches one file.

## Why `tuyapi`, not an in-house protocol

Protocol 3.5 is a session-key negotiation (three-message handshake with HMAC), AES-128-GCM frames with a 6699 prefix, sequence numbers and a heartbeat — about 600 lines to get right, with no device to test against before the hardware arrives. `tuyapi` 7.7.x (MIT, bundled typings, commits as of September 2026) implements 3.1 to 3.5 and is the library the Node ecosystem uses. It has four small dependencies (`debug`, `p-queue`, `p-retry`, `p-timeout`). The risk — its 3.5 path is less exercised than tinytuya's — is contained by the transport interface and checked on the real device before v0.1.0 (spec FR-18).

`tuyapi` logs through `debug`, which prints payloads, and could print key material, when `DEBUG=TuyAPI*` is set. The plugin never sets it; the README says not to set it in production.

## Settings

| Key                | Type     | Required | Default | Notes                                                     |
| ------------------ | -------- | -------- | ------- | --------------------------------------------------------- |
| `host`             | text     | yes      | —       | IPv4. A DHCP reservation is recommended.                  |
| `device_id`        | text     | yes      | —       | Tuya device id; becomes the source id.                    |
| `local_key`        | password | yes      | —       | Never logged (spec FR-2).                                 |
| `protocol_version` | text     | no       | `3.5`   | `3.3`, `3.4` or `3.5`; anything else → 3.5 with a `warn`. |
| `poll_interval`    | number   | no       | `30`    | Seconds, clamped to 10-300.                               |

Stored by the core as `integration.tuya.<key>`, read through `settingsManager.get` (spec 111 scope). `src/config.ts` reads and validates them into a `DeviceConfig`; it is the only place that touches the key string before handing it to the transport.

## Transport contract

```ts
interface TuyaTransport {
  connect(): Promise<void>; // resolves once the session is negotiated
  disconnect(): void;
  getAll(): Promise<Record<string, unknown>>; // full DP snapshot
  set(dps: Record<string, unknown>): Promise<void>;
  on(event: "dps", cb: (dps: Record<string, unknown>) => void): void; // pushed partial updates
  on(event: "disconnected", cb: () => void): void;
  on(event: "error", cb: (err: TransportError) => void): void;
}

type TransportErrorKind = "unreachable" | "refused" | "undecryptable" | "timeout" | "other";
```

`TuyapiTransport` wraps `new TuyAPI({ id, key, ip, version, issueGetOnConnect: false })`: `getAll` is `get({ schema: true })`, `set` is `set({ multiple: true, data })`, `dps` is the union of its `data` and `dp-refresh` events (payload `.dps`). It classifies errors into `TransportErrorKind` from the socket error code (`ETIMEDOUT`/`EHOSTUNREACH` → unreachable, `ECONNREFUSED` → refused) and from decryption failures (GCM authentication or JSON parse of a decrypted frame → undecryptable). The classification is a pure function, tested on the error shapes `tuyapi` produces.

## Session

State: `connecting | online | offline | mismatch | stopped`, plus the DP cache (last full snapshot, partial pushes merged into it), the last published payload, and the backoff delay.

```
start ─► connect ─ok─► getAll ─► profile.match? ─no─► mismatch (plugin status error, log DP ids; retry never)
            │                        │ yes
            │                        ▼
            │                 upsertFromDiscovery (once) ─► publish(decode(cache)) ─► online
            │                        ▲
            │     push "dps" ────────┤ merge into cache, publish changed readings
            │     poll timer ────────┘ getAll every poll_interval (queued)
            │
            └─fail/disconnect─► schedule reconnect (5 s → ×2 → 5 min cap); offline after 60 s without a read,
                                or after 2 failed polls; transition logged once, with its TransportErrorKind
```

- **Queue**: a promise chain per session. `getAll`, each `set` and each read-back are enqueued; nothing reaches the transport outside it.
- **Publish**: `decode` returns the full payload; the session sends `updateDeviceData` with the keys whose value changed since the last publish (the first publish sends all).
- **Status**: `updateDeviceStatus(online|offline)` on transitions only.
- **Verified write**: `executeOrder` → `profile.encode` (refusal → reject) → offline? reject → enqueue `set` → then up to 8 enqueued `getAll` one second apart until every written DP equals the expected value (numbers compared as numbers, booleans as booleans) → resolve; else reject `"not reflected after 8 s"`. The read-backs also refresh the cache and publish.
- **Stop**: clears timers, disconnects, state `stopped`. Late events after stop are ignored.

## Profile interface

```ts
interface ProductProfile {
  readonly id: string; // "depow_v2"
  readonly manufacturer: string;
  readonly model: string;
  match(dps: Record<string, unknown>): boolean;
  discovery(sourceId: string): DiscoveredDevice;
  decode(dps: Record<string, unknown>): Record<string, unknown>;
  encode(
    orderKey: string,
    value: unknown,
    dps: Record<string, unknown>,
  ): { ok: true; write: Record<string, unknown> } | { ok: false; reason: string };
}
```

## DP map — `depow_v2`

Evidence: `lachand/EV_charger` at commit `3fd6c187010032d24fd2bc27a96d5f3d227313ec` (2026-09-21), files `custom_components/tuya_ev_charger/const.py` (DP ids) and `tuya_ev_charger.py` (scales, maps), cross-checked there against tuya_local's `dewall_evcharger.yaml` (product id `gxrtu5vljdthtd3g`).

### Raw DPs used

| DP  | Raw shape                                                                 | Meaning (established)                                               |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 101 | integer                                                                   | Work state code (200 ready, 204 paused, 300 charging). Match only.  |
| 102 | JSON string `{"L1":[dV,dA,dkW],"L2":[…],"L3":[…],"t":dC,"e":dkWh,"d":ds}` | Live metrics. Values in tenths. `L2`/`L3` all zero on single-phase. |
| 104 | string                                                                    | Alarm text; empty or `"0"` when none.                               |
| 105 | JSON string `{"c":dkWh,"d":s}`                                            | Last completed session: energy in tenths of kWh, duration in s.     |
| 109 | string                                                                    | Status: `SLEEP IDLE IDLEINS WORKING WAIT ERRORPAUSE PAUSE STOP`.    |
| 140 | boolean                                                                   | Charge enabled (start/stop). Writable.                              |
| 150 | integer (A)                                                               | Current setpoint. Writable.                                         |
| 152 | integer (A)                                                               | Hardware maximum current.                                           |
| 154 | integer 0/1/2                                                             | On plug-in: prompt / charge / idle. Writable.                       |

Not published (spec non-goals or meaning not established): 103 self-test, 106 charger info, 107 advertised current shortcuts, 108 countdown, 141 reset, 142 reboot, 151 schedule, 155 NFC, 156, 157 product variant, 188, 189.

### Readings

| Key                 | Type    | Category             | Unit | Decoding                                                          |
| ------------------- | ------- | -------------------- | ---- | ----------------------------------------------------------------- |
| `status`            | enum    | `generic`            | —    | DP 109 via the status map; unknown raw → `unknown` (FR-12)        |
| `vehicle`           | enum    | `generic`            | —    | Derived: `disconnected` / `connected` / `charging` (FR-13)        |
| `charge`            | boolean | `appliance_state`    | —    | DP 140                                                            |
| `power`             | number  | `power`              | W    | `round(V × A)` from DP 102 L1, 0 outside an active charge (FR-11) |
| `current`           | number  | `current`            | A    | DP 102 L1[1] / 10, 0 outside an active charge                     |
| `voltage`           | number  | `voltage`            | V    | DP 102 L1[0] / 10                                                 |
| `temperature`       | number  | `temperature_device` | °C   | DP 102 `t` / 10                                                   |
| `currentSetpoint`   | number  | `generic`            | A    | DP 150                                                            |
| `maxCurrent`        | number  | `generic`            | A    | DP 152                                                            |
| `plugInAction`      | enum    | `generic`            | —    | DP 154: 0 `prompt`, 1 `charge`, 2 `idle`                          |
| `sessionEnergy`     | number  | `generic`            | kWh  | DP 102 `e` / 10 (running session)                                 |
| `sessionDuration`   | number  | `generic`            | s    | DP 102 `d` / 10, truncated                                        |
| `lastSessionEnergy` | number  | `generic`            | kWh  | DP 105 `c` / 10                                                   |
| `alarm`             | string  | `generic`            | —    | DP 104 as text; `""` when empty or `"0"`                          |

Power is derived from voltage × current rather than read from the third array element, which is quantised to 0.1 kW (reference measurement: 227.0 V × 8.7 A reported as 19, i.e. 1.9 kW, for 1 975 W). `sessionEnergy` is `generic`, not `energy`: the core's `energy` category is an additive delta in Wh, and a per-session counter that resets would be summed into nonsense. kWh history comes from the core integrating `power`.

### Orders

| Key            | Type    | Category       | Range / values                 | Encodes to               |
| -------------- | ------- | -------------- | ------------------------------ | ------------------------ |
| `charge`       | boolean | `toggle_power` | —                              | DP 140 `true`/`false`    |
| `current`      | number  | —              | 6 … DP 152 (16 if absent), 1 A | DP 150 integer (rounded) |
| `plugInAction` | enum    | —              | `prompt`, `charge`, `idle`     | DP 154 0/1/2             |

`charge` carries `toggle_power` so the core's binding candidates see an on/off channel (`binding-candidates.ts`, `POWER_TOGGLE_CATEGORIES`), and its state reading `appliance_state`, the category core spec 176 gives an on/off run state so that category-first consumers (arbiter, submeter integration, energy panel) never mistake it for the `power` measurement. The final binding convention is settled by the core `ev_charger` issue.

## Plugin status

| Situation                                     | `getStatus()`    |
| --------------------------------------------- | ---------------- |
| a required setting is empty                   | `not_configured` |
| device online                                 | `connected`      |
| connecting, offline, unreachable, refused     | `disconnected`   |
| undecryptable (wrong key) or profile mismatch | `error`          |

## Capture tool

`src/tools/capture.ts`, built to `dist/tools/capture.js`, uses `TuyapiTransport` directly. Output is one JSON line per snapshot: `{ "at": ISO, "label": "...", "dps": {...} }`. It writes to stdout only; the owner redirects it to a file, reviews it and copies it under `src/profiles/__fixtures__/depow-v2/`. DPs carry no secret; the device id is replaced by `"<device-id>"` before a capture is committed. `console` is allowed in this file only (an ESLint override), as it is a CLI.

## File changes

| File                                          | Change                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `package.json`                                | `tuyapi` dependency                                                                     |
| `manifest.json`                               | settings schema                                                                         |
| `src/index.ts`                                | settings, one session, status, `executeOrder` routing                                   |
| `src/config.ts`                               | settings → `DeviceConfig`, validation                                                   |
| `src/transport/transport.ts`                  | interface, `TransportError`, error classifier                                           |
| `src/transport/tuyapi-transport.ts`           | `tuyapi` adapter                                                                        |
| `src/transport/fake-transport.ts`             | test double (excluded from the build)                                                   |
| `src/session/device-session.ts`, `backoff.ts` | session                                                                                 |
| `src/profiles/profile.ts`, `depow-v2.ts`      | interface and the dé profile                                                            |
| `src/profiles/__fixtures__/depow-v2/*.json`   | reference payloads, later real captures                                                 |
| `src/tools/capture.ts`                        | capture CLI                                                                             |
| `eslint.config.js`                            | `no-console` off for `src/tools/**`                                                     |
| `README.md`                                   | setup (getting `local_key`, DHCP reservation, the app's local slot), supported products |
| `CLAUDE.md`                                   | the `executeOrder` rule, aligned with FR-16 (reject on invalid, offline, not reflected) |
