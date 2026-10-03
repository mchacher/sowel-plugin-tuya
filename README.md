# Sowel plugin: tuya

Tuya devices for [Sowel](https://docs.sowel.org), over the **local network**: the plugin talks to each device's local socket with its `local_key`, with no cloud at runtime, and publishes it as an ordinary Sowel device — readings and orders you bind to equipments.

A Tuya device's data points are product-specific, so support grows **one product profile at a time**, each specified and tested against the real device.

## Supported products

| Product                                              | Profile    | Status                                        |
| ---------------------------------------------------- | ---------- | --------------------------------------------- |
| dé portable EV charger 3.7 kW, 6-16 A, LCD 2 buttons | `depow_v2` | Implemented (spec 001), hardware walk pending |

Not supported: the round single-button dé model and the 11 kW three-phase model (different or unconfirmed DP layouts). A device that does not match its profile is refused with a log line listing the DP ids it reports — open an issue with it.

The DP map of the dé charger comes from the reverse-engineering work in [lachand/EV_charger](https://github.com/lachand/EV_charger) (Home Assistant). Thanks to its author.

## Setup

One device per installation for now; several devices are the next spec.

You need three things per device: its **IP address**, its **device id** and its **local key**.

1. **Pair the device** with the Smart Life (or Tuya) app, as usual, on your Wi-Fi.
2. **Reserve its IP** on your router (DHCP reservation). The plugin connects to that address; Tuya's discovery broadcast does not reach a Sowel container on Docker's default network.
3. **Get the device id and local key**, either:
   - on [iot.tuya.com](https://iot.tuya.com): create a Cloud project (Smart Home, your region's data centre), link your app account under _Devices → Link Tuya App Account_, then read the device's id and local key in the device list; or
   - with [tinytuya](https://github.com/jasonacox/tinytuya): `python -m tinytuya wizard`, which writes them to `devices.json`.

   The local key **changes when the device is re-paired**: update the setting then.

4. In Sowel, **Settings → Integrations → Tuya (local)**: fill in `host`, `device_id`, `local_key` (protocol `3.5` by default), save, start.

The device appears under the integration; bind its readings and orders to an equipment.

**One local client at a time.** A Tuya device accepts a single local connection. If the Smart Life app is open on the same network, or another integration (Home Assistant, tinytuya) talks to the device, the plugin logs _connection refused_ and retries until the slot frees. The app still works through the cloud.

**Never set `DEBUG=TuyAPI*` in production**: the underlying library then prints raw payloads.

## What the dé charger exposes

| Reading                                                 | Unit   | Notes                                                                       |
| ------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| `status`                                                |        | sleep, idle, plugged_in, charging, waiting, paused, charged, fault, unknown |
| `vehicle`                                               |        | disconnected, connected, charging — is a car there, is it drawing           |
| `charge`                                                |        | charging enabled (the order's echo)                                         |
| `power`                                                 | W      | live; 0 outside a charge (the charger echoes its last value otherwise)      |
| `energy`                                                | Wh     | increments from the charger's own counter, for the energy history           |
| `current`, `voltage`                                    | A, V   | live                                                                        |
| `temperature`                                           | °C     | charger's internal temperature                                              |
| `currentSetpoint`, `maxCurrent`                         | A      |                                                                             |
| `plugInAction`                                          |        | prompt, charge, idle — what happens when a cable is plugged in              |
| `sessionEnergy`, `sessionDuration`, `lastSessionEnergy` | kWh, s | information, not history                                                    |
| `alarm`                                                 |        | raw alarm text, empty when none                                             |

Orders: `charge` (start / stop), `current` (6 A to the charger's maximum, 1 A steps), `plugInAction`. An order completes when the charger reads the value back (up to 8 s), and fails with a message otherwise.

Since v0.2.0 the vehicle state, the charging current (reading and order) and the session energy are published under the categories of Sowel's **EV charger** equipment type (core spec 182: `ev_vehicle_state`, `ev_charge_current`, `set_ev_charge_current`, `ev_session_energy`), so the charger is offered and bound as an `ev_charger` on a Sowel release that has the type. On an older Sowel it binds as before.

The plugin decides nothing: charging from solar surplus or off-peak is a recipe's job, through Sowel's energy arbiter.

## Capturing a device's payloads

To add a product, or to pin a profile on your own device:

```bash
npm run build
TUYA_LOCAL_KEY=<key> node dist/tools/capture.js --host <ip> --id <device_id> --label plugged > capture.jsonl
```

Stop the plugin first (single local client). The key is read from the environment so it stays out of your shell history. Review the file before sharing it.

## Development

```bash
npm install
npm run validate        # typecheck, lint, format, tests, build, specs index — what CI runs
npm run dev             # tsc --watch
```

Install on a Sowel instance through a personal source (core spec 136), or copy `manifest.json`, `package.json`, `dist/` and `node_modules/` into `plugins/tuya/`.

Releases: tag `vX.Y.Z` on main; the workflow publishes `sowel-plugin-tuya-X.Y.Z.tar.gz`. The registry in `mchacher/sowel` must then be bumped with the tarball's SHA256 (spec 089).

## License

AGPL-3.0, like Sowel.
