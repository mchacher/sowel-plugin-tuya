# Spec 002 — Architecture

| File                            | Change                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/profiles/profile.ts`       | `discovery(sourceId, dps)`: the snapshot is passed so a profile can declare a range read from the device                                                                         |
| `src/profiles/depow-v2.ts`      | Categories of `vehicle`, `currentSetpoint`, `sessionEnergy`; `current` order category and `max` from DP 152; `charge` order `valueOn`/`valueOff`; `toBoolean` accepts `on`/`off` |
| `src/session/device-session.ts` | Passes the cache to `discovery`                                                                                                                                                  |
| `README.md`                     | The readings table names the categories; minimum Sowel version for the `ev_charger` type                                                                                         |

Discovery happens once, after the first read that matches the profile, so DP 152 is in the snapshot when it is reported. A later change of DP 152 is not re-declared (the hardware maximum does not change at runtime); the encode-time check still uses the live DP 152.

The categories are plain strings on the wire: a core older than spec 182 stores them and binds them as it binds any unknown category, so v0.2.0 keeps `sowelVersion >=1.71.0`.
