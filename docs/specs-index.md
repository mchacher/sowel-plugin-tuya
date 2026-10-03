# Specs index — sowel-plugin-tuya

Every feature ever specified in this repository, one row each, newest last. A
CI check (`scripts/check-specs-index.sh`) fails a pull request that creates a
`specs/NNN-name/` folder without its row here.

Status: 📝 Draft · 🚧 In progress · ✅ Shipped

| #   | Title                                      | Status | Summary                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | Local Tuya transport and the dé EV charger | ✅     | One Tuya device over the local network (protocol 3.5, `tuyapi`), no cloud at runtime, and the `depow_v2` profile: the dé 3.7 kW charger published as a device with status, live power, energy increments from its own counter and verified orders (start/stop, current 6-16 A, plug-in action).                        |
| 002 | Publish the core EV charger contract       | 🚧     | The dé charger's vehicle state, charging current and session energy published under core spec 182's categories (`ev_vehicle_state`, `ev_charge_current`, `ev_session_energy`, order `set_ev_charge_current` bounded by DP 152), and wire values on start/stop so Sowel's `ON`/`OFF` reach the charger. Keys unchanged. |
