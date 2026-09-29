# Spec 001 — Plan

## Steps

- [x] 1. `src/profiles/profile.ts`: `ProductProfile` interface.
- [x] 2. `src/profiles/depow-v2.ts`: status map, DP 102/105 parsing, `match`, `discovery`, `decode`, `encode`. Fixtures from the reference test suite in `src/profiles/__fixtures__/depow-v2/reference.json`, source and commit in a `_source` field.
- [x] 3. `src/config.ts`: settings → `DeviceConfig` (required keys, protocol version, poll interval clamp).
- [x] 4. `src/transport/transport.ts`: interface, `TransportError`, `classifyError`. `src/transport/fake-transport.ts`: scripted snapshots, pushes, failures, write echo on or off.
- [x] 5. `src/session/backoff.ts` and `src/session/device-session.ts`: queue, cache, poll, reconnect, online/offline, match, publish diff, verified write.
- [x] 6. `src/index.ts`: settings schema, one session, status, `executeOrder`.
- [x] 7. `npm install tuyapi@^7.7.1`; `src/transport/tuyapi-transport.ts`.
- [x] 8. `src/tools/capture.ts`, ESLint override for `src/tools/**`.
- [x] 9. `manifest.json` settings; README (setup, getting the `local_key`, DHCP reservation, the app's local slot, `DEBUG` warning, supported products); CLAUDE.md `executeOrder` rule.
- [ ] 10. Open the core issue for the `ev_charger` equipment type and link it from this spec.
- [ ] 11. Hardware walk and real captures (before v0.1.0, may land in a follow-up PR against this spec).

Timers in session tests use Vitest fake timers. The transport adapter (step 7) is the only module without unit tests beyond its error classifier: it is exercised by the hardware walk.

## Test plan

### `src/profiles/depow-v2.test.ts`

| Scenario                                                                    | Expected                                                                                  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `match` on the reference snapshot (no DP 140 in it)                         | `true`                                                                                    |
| `match` on a snapshot missing DP 101, 102, 109 or 150                       | `false`                                                                                   |
| `decode` charging snapshot (109 `WORKING`, L1 `[2270,87,19]`)               | `power` 1975, `current` 8.7, `voltage` 227, `status` `charging`, `vehicle` `charging`     |
| `decode` after session (109 `STOP`, 140 false, DP 102 still `[2270,87,19]`) | `power` 0, `current` 0, `voltage` 227, `status` `charged`, `vehicle` `connected`          |
| `decode` 140 `true` with 109 `IDLEINS`                                      | treated as active: `power` from DP 102                                                    |
| `decode` `WORKING` below 100 W                                              | `vehicle` `connected`                                                                     |
| `decode` 109 `IDLE`                                                         | `status` `idle`, `vehicle` `disconnected`                                                 |
| `decode` each raw status of the map                                         | the mapped value                                                                          |
| `decode` unknown 109 `FOO`                                                  | `status` `unknown`                                                                        |
| `decode` session counters (`e` 52, `d` 94200; DP 105 `{"c":48,"d":7200}`)   | `sessionEnergy` 5.2, `sessionDuration` 9420, `lastSessionEnergy` 4.8                      |
| `decode` temperature `t` 312                                                | `temperature` 31.2                                                                        |
| `decode` DP 154 0 / 1 / 2                                                   | `prompt` / `charge` / `idle`                                                              |
| `decode` DP 104 `""`, `"0"`, `"E03"`                                        | `""`, `""`, `"E03"`                                                                       |
| `decode` DP 102 not JSON, or L1 shorter than 3                              | measurement keys absent from the result; other keys present                               |
| `decode` three-phase-looking L2/L3 all zero                                 | ignored, L1 only                                                                          |
| `encode("charge", true)`                                                    | `{ "140": true }`                                                                         |
| `encode("current", 11)` with DP 152 16                                      | `{ "150": 11 }`                                                                           |
| `encode("current", 10.6)`                                                   | `{ "150": 11 }`                                                                           |
| `encode("current", 5)`, `encode("current", 17)` with DP 152 16              | refused, reason names the range                                                           |
| `encode("current", 20)` with DP 152 absent                                  | refused (16 A default ceiling)                                                            |
| `encode("current", "abc")`                                                  | refused                                                                                   |
| `encode("plugInAction", "idle")`                                            | `{ "154": 2 }`                                                                            |
| `encode("plugInAction", "nope")`, `encode("unknown", 1)`                    | refused                                                                                   |
| `discovery("abc")`                                                          | friendlyName `abc`, manufacturer `dé`, the 15 readings and 3 orders with their categories |

### `src/profiles/depow-v2.test.ts` — `energyStep`

| Scenario                                                                  | Expected                                    |
| ------------------------------------------------------------------------- | ------------------------------------------- |
| First read, counter 52                                                    | `deltaWh` 0, baseline 52                    |
| 52 → 53 → 55                                                              | 100, then 200                               |
| 55 → 55                                                                   | 0                                           |
| 55 → 3, DP 105 unchanged                                                  | 300                                         |
| 55 → 3, DP 105 changed to `c` 58 (end of session unseen during an outage) | 300 + 300 = 600                             |
| DP 105 changed to `c` 50, below the last counter 55                       | no credit for it (`max(0, …)`), no negative |
| Same DP 105 seen again on the next snapshot                               | not credited twice                          |
| Snapshot without `e`                                                      | `null`, state unchanged                     |
| A full session replayed from fixtures, then a new one                     | sum of increments = sum of session totals   |

### `src/config.test.ts`

| Scenario                         | Expected                        |
| -------------------------------- | ------------------------------- |
| All required set                 | config, protocol `3.5`, poll 30 |
| One required empty or missing    | `null` (not configured)         |
| `protocol_version` `3.3`         | kept                            |
| `protocol_version` `9`           | `3.5`, one warning returned     |
| `poll_interval` 2 / 1000 / `"x"` | 10 / 300 / 30                   |

### `src/transport/transport.test.ts`

| Scenario                                            | Expected        |
| --------------------------------------------------- | --------------- |
| error with code `ECONNREFUSED`                      | `refused`       |
| `ETIMEDOUT`, `EHOSTUNREACH`, "connection timed out" | `unreachable`   |
| GCM authentication failure, JSON parse of a frame   | `undecryptable` |
| anything else                                       | `other`         |

### `src/session/device-session.test.ts` (fake transport, fake timers)

| Scenario                                      | Expected                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Start, reference snapshot                     | one `upsertFromDiscovery`, one full `updateDeviceData`, status `online`           |
| Snapshot missing DP 150                       | no discovery, no data, state `mismatch`, one `error` log naming DP ids, no values |
| Push of DP 102 only                           | merged; only changed keys published                                               |
| Push with no change                           | nothing published                                                                 |
| Poll every `poll_interval`                    | `getAll` called on schedule                                                       |
| Connect refused, then accepted                | retries at 5 s, 10 s…; one `warn` for refused (not one per retry); online after   |
| Backoff cap                                   | never above 5 min; reset after success                                            |
| Disconnect, no reconnect within 60 s          | `offline` once at 60 s                                                            |
| Two consecutive failed polls while connected  | `offline`                                                                         |
| Recovery                                      | `online` once, full republish                                                     |
| Undecryptable                                 | state reflects it; plugin status `error`                                          |
| Order `charge` true, echo on second read-back | resolves; `charge` published true                                                 |
| Order never reflected                         | rejects after 8 read-backs, "not reflected"; session still online                 |
| Order while offline                           | rejects "offline" without writing                                                 |
| Order refused by profile                      | rejects with the reason, no write                                                 |
| Order during a poll                           | the `set` starts only after the poll's `getAll` settles                           |
| Stop                                          | timers cleared, disconnect called, later pushes ignored                           |
| Transport throws from an event handler path   | caught, logged with `err`, no unhandled rejection                                 |

### `src/index.test.ts`

| Scenario                                                                                                             | Expected                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Identity and settings schema                                                                                         | id `tuya`, 5 settings, `local_key` type `password`                                 |
| Missing required setting                                                                                             | `not_configured`, no transport created                                             |
| Configured, device online                                                                                            | `connected`                                                                        |
| `executeOrder` on a device of another source id                                                                      | rejects                                                                            |
| Stop                                                                                                                 | `disconnected`, session stopped                                                    |
| **Secret never logged**: run start, mismatch, refused, undecryptable, order rejections with `local_key` = a sentinel | no logger argument, no published value, no rejection message contains the sentinel |
