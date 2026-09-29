# Spec 001 — Local Tuya transport and the dé EV charger profile

- **Status**: Draft
- **Date**: 2026-09-29
- **Related**: core spec 140 (energy capacity arbiter), core spec 111 (plugin soft isolation), core spec 089 (registry), core spec 136 (personal source)
- **Hardware**: dé portable EV charger, 3.7 kW, 6-16 A, Type 2, Schuko plug, LCD with two buttons (Amazon `B0DGT8PRHH`) — the reference device of [lachand/EV_charger](https://github.com/lachand/EV_charger), DP layout `depow_v2`

## Context

The owner bought a dé portable EV charger to charge the household EV, with the aim of charging from solar surplus through Sowel's energy capacity arbiter. The charger is a Tuya device: it joins the home Wi-Fi and is normally driven from the Tuya / Smart Life app through Tuya's cloud. It also answers on the local network (TCP 6668, Tuya protocol 3.5, AES-GCM with a per-device `local_key`), and its data points (DPs) have been reverse-engineered by the Home Assistant integration `lachand/EV_charger`, which confirms this exact model.

This spec is the first feature of `sowel-plugin-tuya`: a local Tuya transport that is generic, and a single product profile on top of it, the dé charger. With it, the charger appears in Sowel as an ordinary device whose readings and orders can be bound to an equipment. The surplus logic is **not** here: it will be a recipe claiming capacity from the arbiter, which needs this device to exist first.

## Goals

1. Connect to one Tuya device on the local network, with no cloud call at runtime.
2. Publish the dé charger as a Sowel device: state, measurements, session counters, configuration.
3. Accept the orders a charging recipe needs: start/stop, charging current, what happens on plug-in.
4. Keep the device honest: `online` only while it answers, readings that do not lie after a session ends, orders confirmed by read-back.
5. Lay the transport and profile boundary so the next product, or a second device, is a profile or a setting, not a rewrite.
6. Ship a small capture tool so the real device's payloads can be recorded and pinned in tests the day it arrives.

## Non-goals

- **Several devices.** One device per plugin instance in this spec. Multi-device configuration is the next spec; the code is structured for it (one session object per device).
- **Automatic discovery on the network.** Tuya devices announce themselves by UDP broadcast, which does not reach a Sowel container on Docker's default bridge network. The IP is a setting; a DHCP reservation on the router is the documented prerequisite.
- **Obtaining the `local_key`.** Documented (Tuya IoT platform, or `tinytuya wizard`), not automated. No Tuya cloud credential is stored by the plugin.
- **Other dé models.** The round single-button model and the 11 kW three-phase model have different or unconfirmed DP layouts. They are refused, not guessed.
- **The charger's own schedule (DP 151), NFC (DP 155), reboot (DP 142), self-test and history detail.** Scheduling belongs to Sowel's recipes; the others add no value to charging from Sowel. Not published.
- **Energy counting.** The plugin publishes instantaneous power; turning it into kWh history is the core's job (power-only submeter integration). The session counter is published as information, not as the `energy` category, which the core reads as additive deltas.
- **Any automation**: surplus following, off-peak charging, target energy. That is the recipe, a later step.
- **The `ev_charger` equipment type.** A core issue, argued on its own merits (see Dependencies).

## Functional requirements

### Configuration

- **FR-1** The plugin settings are: `host` (IP address, required), `device_id` (Tuya device id, required), `local_key` (password, required), `protocol_version` (default `3.5`, accepted `3.3`, `3.4`, `3.5`), `poll_interval` (seconds, default 30, clamped to 10-300). The plugin is configured when the three required settings are non-empty.
- **FR-2** `local_key` is never written to any log line, at any level, in whole or in part, nor to any published reading, nor to an error message returned by `executeOrder`.

### Connection

- **FR-3** On start, the plugin opens one persistent local connection to the device and reads all its DPs. The connection is held for the plugin's lifetime; Tuya devices push DP changes on it, and a full read is repeated every `poll_interval` seconds as a safety net.
- **FR-4** All reads and writes to one device go through a single queue. Two operations are never in flight on the same connection.
- **FR-5** On disconnection or read failure, the plugin reconnects with exponential backoff (5 s, doubled, capped at 5 min, reset on success). It never throws out of a timer or event handler.
- **FR-6** The device is `online` from its first successful read, and goes `offline` when the connection is lost and not re-established within 60 s, or when two consecutive polls fail. It goes back `online` on the next successful read. The last readings stay as they are; `offline` is the signal.
- **FR-7** Failures are told apart in the log, once per transition, not per retry: unreachable host (timeout), connection refused (another client holds the device's single local slot — the Smart Life app on the same network or another integration), and undecryptable payload (wrong `local_key`, or the device was re-paired). The plugin status is `error` for the last one, `disconnected` for the first two, `connected` when the device is online.

### Product profile

- **FR-8** On the first successful read, the plugin checks the DP set against the `depow_v2` profile: DPs 101, 102, 109, 140 and 150 must be present. If they are not, the device is not published, the plugin status is `error`, and one `error` log line lists the DP ids the device did report (ids and value types, not values), so the user can open an issue with it.
- **FR-9** A matched device is published once through discovery with the readings and orders of the architecture's DP map, `manufacturer: "dé"`, `model: "Portable EV charger 3.7 kW"`. Its source id is the Tuya `device_id`, stable across IP changes and restarts.

### Readings

- **FR-10** Readings are decoded from DPs as specified in the architecture's DP map, and published on every change. A reading whose DP is absent from a payload keeps its previous value.
- **FR-11** Outside an active charge, `power` and `current` are published as 0: the charger keeps echoing the last measurement after a session ends, which would make the arbiter believe the load is still drawing. A charge is active when DP 109 is `WORKING` or DP 140 is `true`.
- **FR-12** `status` is one of `sleep`, `idle`, `plugged_in`, `charging`, `waiting`, `paused`, `charged`, `fault`, `unknown`. A raw DP 109 value outside the known set is published as `unknown` and logged at `warn` once per distinct raw value.
- **FR-13** `vehicle` is derived and is one of `disconnected`, `connected`, `charging` (the IEC 61851 A/B/C states): `charging` when power is at least 100 W; `connected` when status is `plugged_in`, `waiting`, `paused`, `charged` or `fault`, or `charging` below 100 W; `disconnected` otherwise. This is the reading a recipe watches to know a car is there.

### Orders

- **FR-14** Orders: `charge` (boolean, start or stop charging, DP 140), `current` (integer amperes, DP 150), `plugInAction` (`prompt` | `charge` | `idle`, DP 154).
- **FR-15** `current` accepts integers from 6 A (the IEC 61851 minimum) to the charger's own maximum (DP 152, 16 A on the reference model), in 1 A steps, not only the shortcuts listed in DP 107. A non-integer is rounded; a value out of range is refused.
- **FR-16** An order is complete when the DP reads back the written value, checked once a second for up to 8 s. `executeOrder` then resolves. It rejects, with a message saying which, when the order key or value is invalid, when the device is offline, or when the value is not reflected in time. A rejection never stops the plugin or the connection.

### Capture tool

- **FR-17** `node dist/tools/capture.js --host <ip> --id <device_id> [--version 3.5]` reads the `local_key` from the `TUYA_LOCAL_KEY` environment variable (never from the command line, which lands in shell history), prints the device's DPs as JSON every 10 s with a timestamp and the state label given as `--label`, and exits on Ctrl-C. It is the tool that produces the test fixtures of FR-18.

### Evidence

- **FR-18** The profile's decoding is pinned by fixtures. Before the device is available, the fixtures are the payloads of the reference integration's test suite (source and commit named in the fixture file). A real capture of the owner's device in three states — unplugged, plugged and idle, charging — is added before the first release (v0.1.0), and any divergence from the reference is fixed in the profile and recorded in this spec.

## Dependencies

- **Core issue to open: an `ev_charger` equipment type.** Deferrable by default for the arbiter (spec 140's class table already lists "EV" as deferrable), a card with state, power, current setpoint and a start/stop control, and a binding convention for `power`, `charge` and `current`. Until it exists, the charger can be bound to a `switch` equipment for tests; it is not a blocker for this spec.
- **Runtime dependency: `tuyapi` 7.7.x** (MIT, typed, protocol 3.5 support, maintained). See the architecture for why not an in-house implementation.

## Acceptance criteria

- [ ] With the three required settings, the plugin connects, publishes one device with the readings and orders of the DP map, and marks it `online`.
- [ ] With a missing required setting, the status is `not_configured` and no connection is attempted.
- [ ] Every scenario of the plan's test plan passes, against a fake transport; no test opens a socket.
- [ ] A payload from a device lacking a required DP publishes nothing, sets `error`, and logs the DP ids.
- [ ] After a charge ends (DP 109 leaves `WORKING`, DP 140 false), `power` and `current` read 0 even if DP 102 still carries the last measurement.
- [ ] `charge`, `current` and `plugInAction` orders resolve when reflected, reject when not, when offline, or when invalid.
- [ ] No log line, reading or error message contains the `local_key` (tested by running the scenarios with a sentinel key and scanning every logged argument).
- [ ] Connection loss sets the device `offline` after 60 s and reconnects with backoff; recovery sets it `online`.
- [ ] `npm run validate` is green; CI is green.
- [ ] Before v0.1.0: the owner's charger walked end to end (connect, plug, start, set 8 A then 16 A, stop, unplug), its captures added as fixtures, outcome recorded in the PR.

## Edge cases

- **The Smart Life app is open on the same network.** The app may take the device's single local slot; the plugin sees refused connections, logs it once with the explanation, and keeps retrying with backoff. When the app lets go, the plugin reconnects on its own.
- **The IP changes** (no DHCP reservation). The device goes `offline`; the log says the host is unreachable and recommends a reservation. Updating the `host` setting and restarting the plugin recovers it.
- **The device is re-paired.** Its `local_key` changes; payloads no longer decrypt; the status is `error` with the explanation. A new key in the settings recovers it.
- **A partial push** (the device pushes only DP 102, for instance). Merged into the last full state before decoding, so readings that depend on two DPs (power needs DP 102 and DP 109) stay coherent.
- **DP 102 malformed** (not JSON, or a phase array shorter than three). The measurement readings keep their previous value, logged at `debug`; the other readings are published.
- **An order while a poll is running.** Queued behind it (FR-4), never interleaved.
- **`current` written above DP 152.** Refused before any write.
- **The charger reboots** (power cut). The connection drops, the backoff reconnects, and the first read republishes everything.
