# Spec 002 — Plan

## Steps

- [x] 1. `discovery(sourceId, dps)` in the profile interface and the session.
- [x] 2. depow_v2: categories, order range, wire values, `on`/`off` accepted.
- [x] 3. Tests, README, changelog.

## Test plan

| Module           | Scenario                                                          | Expected                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `depow-v2`       | Discovery categories                                              | `vehicle` `ev_vehicle_state`, `currentSetpoint` `ev_charge_current`, `sessionEnergy` `ev_session_energy`; order `current` `set_ev_charge_current`, order `charge` `toggle_power` with `valueOn` true / `valueOff` false |
| `depow-v2`       | Order range with DP 152 = 16 / 32 / absent                        | max 16 / 32 / 16, min 6                                                                                                                                                                                                 |
| `depow-v2`       | `encode("charge", "ON")`, `"off"`, `"On"`                         | `{ "140": true }`, `{ "140": false }`, `{ "140": true }`                                                                                                                                                                |
| `depow-v2`       | Unchanged categories (`charge`, `power`, `energy`, `temperature`) | as in v0.1.0                                                                                                                                                                                                            |
| `device-session` | Discovery receives the matched snapshot                           | `upsertFromDiscovery` declares the order `max` from the device's DP 152                                                                                                                                                 |
