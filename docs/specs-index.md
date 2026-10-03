# Specs index — sowel-plugin-tuya

Every feature ever specified in this repository, one row each, newest last. A
CI check (`scripts/check-specs-index.sh`) fails a pull request that creates a
`specs/NNN-name/` folder without its row here.

Status: 📝 Draft · 🚧 In progress · ✅ Shipped

| #   | Title                                      | Status | Summary                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | Local Tuya transport and the dé EV charger | ✅     | One Tuya device over the local network (protocol 3.5, `tuyapi`), no cloud at runtime, and the `depow_v2` profile: the dé 3.7 kW charger published as a device with status, live power, energy increments from its own counter and verified orders (start/stop, current 6-16 A, plug-in action). |
