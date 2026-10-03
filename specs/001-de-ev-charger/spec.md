# Spec 001 — Local Tuya transport and the dé EV charger profile

- **Status**: Implemented — v0.1.0
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
- **Energy from power.** The plugin does not integrate power into energy: the charger has its own meter, and its counter is what the plugin turns into energy increments (FR-19). Instantaneous power is published for the live view and the arbiter.
- **Any automation**: surplus following, off-peak charging, target energy. That is the recipe, a later step.
- **The `ev_charger` equipment type.** A core issue, argued on its own merits (see Dependencies).

## Functional requirements

### Configuration

- **FR-1** The plugin settings are: `host` (IP address, required), `device_id` (Tuya device id, required), `local_key` (password, required), `protocol_version` (default `3.5`, accepted `3.3`, `3.4`, `3.5`), `poll_interval` (seconds, default 30, clamped to 10-300). The plugin is configured when the three required settings are non-empty.
- **FR-2** `local_key` must be 16 characters; any other length is a settings error (plugin status `error`, the log gives the length, never the key). It is never written to any log line, at any level, in whole or in part, nor to any published reading, nor to an error message returned by `executeOrder`.

### Connection

- **FR-3** On start, the plugin opens one persistent local connection to the device and reads all its DPs. The connection is held for the plugin's lifetime; Tuya devices push DP changes on it, and a full read is repeated every `poll_interval` seconds as a safety net.
- **FR-4** All reads and writes to one device go through a single queue. Two operations are never in flight on the same connection.
- **FR-5** On disconnection or read failure, the plugin reconnects with exponential backoff (5 s, doubled, capped at 5 min, reset on success). It never throws out of a timer or event handler.
- **FR-6** The device is `online` from its first successful read, and goes `offline` when the connection is lost and not re-established within 60 s, or when two consecutive polls fail. It goes back `online` on the next successful read. The last readings stay as they are; `offline` is the signal.
- **FR-7** Failures are told apart in the log, once per transition, not per retry: unreachable host (timeout), connection refused (another client holds the device's single local slot — the Smart Life app on the same network or another integration), and undecryptable payload (wrong `local_key`, or the device was re-paired). The plugin status is `error` for the last one, `disconnected` for the first two, `connected` when the device is online.

### Product profile

- **FR-8** On the first successful reads, the plugin checks the DP set against the `depow_v2` profile: DPs 101, 102, 109 and 150 must be present. DP 140 is not required: the reference capture of this very model does not report it in a full read (nor DP 154), so its reading and the `charge` echo only appear once the device reports it — to confirm on the hardware walk. If two consecutive full reads lack one of them (a single read may omit DPs), the device is not published, the plugin status is `error`, and one `error` log line lists the DP ids the device did report (ids and value types, not values), so the user can open an issue with it.
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

### Energy

- **FR-19** The plugin publishes `energy`, in Wh, as **increments** — the core's `energy` category is additive: each value is added to the history, which is how other metering plugins already report. The increment is computed from the charger's own session counter (DP 102 `e`, tenths of kWh), so the history does not depend on how often power is sampled, and a connection loss during a charge is caught up on reconnect:
  - same session, counter up: increment = new − previous;
  - counter lower than before (a new session started): increment = the new counter value, plus the unseen end of the previous session when the completed-session record (DP 105) changed since last seen: `max(0, DP 105 c − previous)`;
  - first read after the plugin starts: no increment, the counter is only taken as the baseline (the session so far may already be in the history);
  - an increment is never negative, never published when zero, and DP 105 is never credited twice. The record is taken at the baseline and at each drop only, so a record that arrives before the counter resets is still recognised as new at the reset.
- **FR-20** Each increment is published even when equal to the previous one: `energy` bypasses the "publish only what changed" rule of FR-10.
- **FR-21** `power` (W) stays published for the live view and the arbiter. The core does not also integrate it: an equipment with an `energy` binding is not a power-only submeter (`power-submeter-integrator.ts`), so there is no double count.
- Known limit, to confirm on the hardware walk: the counter's resolution is 0.1 kWh, so the history moves in 100 Wh steps (about one every 3 min at 2 kW) — exact in hourly and daily totals, stepped at minute scale. And if a connection loss spans the end of one session and a new session that has already passed the old counter value, no drop is seen; the capture will show whether DP 105 alone can tell it apart. Conversely, a momentary counter glitch to 0 mid-session would read as a new session and credit the climb back a second time; the walk checks the counter never does that before any guard is added.

## Dependencies

- **Core issue to open: an `ev_charger` equipment type.** Deferrable by default for the arbiter (spec 140's class table already lists "EV" as deferrable), a card with state, power, current setpoint and a start/stop control, and a binding convention for `power`, `charge` and `current`. Until it exists, the charger can be bound to a `switch` equipment for tests; it is not a blocker for this spec.
- **Runtime dependency: `tuyapi` 7.7.x** (MIT, typed, protocol 3.5 support, maintained). See the architecture for why not an in-house implementation.

## Acceptance criteria

- [ ] With the three required settings, the plugin connects, publishes one device with the readings and orders of the DP map, and marks it `online`.
- [ ] With a missing required setting, the status is `not_configured` and no connection is attempted.
- [ ] `energy` increments sum to the charger's counter across a session, a new session, a reconnection mid-charge and a plugin restart (test plan).
- [ ] Every scenario of the plan's test plan passes, against a fake transport; no test opens a socket.
- [ ] A payload from a device lacking a required DP (101, 102, 109, 150) publishes nothing, sets `error`, and logs the DP ids.
- [ ] After a charge ends (DP 109 leaves `WORKING`, DP 140 false), `power` and `current` read 0 even if DP 102 still carries the last measurement.
- [ ] `charge`, `current` and `plugInAction` orders resolve when reflected, reject when not, when offline, or when invalid.
- [ ] No log line, reading or error message contains the `local_key` (tested by running the scenarios with a sentinel key and scanning every logged argument).
- [ ] Connection loss sets the device `offline` after 60 s and reconnects with backoff; recovery sets it `online`.
- [ ] `npm run validate` is green; CI is green.
- [x] Before v0.1.0: the owner's charger walked end to end (connect, plug, start, set 8 A then 16 A, stop, unplug), its captures added as fixtures, outcome recorded in the PR.

## Edge cases

- **The Smart Life app is open on the same network.** The app may take the device's single local slot; the plugin sees refused connections, logs it once with the explanation, and keeps retrying with backoff. When the app lets go, the plugin reconnects on its own.
- **The IP changes** (no DHCP reservation). The device goes `offline`; the log says the host is unreachable and recommends a reservation. Updating the `host` setting and restarting the plugin recovers it.
- **The device is re-paired.** Its `local_key` changes; payloads no longer decrypt; the status is `error` with the explanation. A new key in the settings recovers it.
- **A partial push** (the device pushes only DP 102, for instance). Merged into the last full state before decoding, so readings that depend on two DPs (power needs DP 102 and DP 109) stay coherent.
- **DP 102 malformed** (not JSON, or a phase array shorter than three). The measurement readings keep their previous value, logged at `debug`; the other readings are published.
- **An order while a poll is running.** Queued behind it (FR-4), never interleaved.
- **`current` written above DP 152.** Refused before any write.
- **The charger reboots** (power cut). The connection drops, the backoff reconnects, and the first read republishes everything.

## Hardware findings

Recorded on the owner's charger as the walk progresses (spec FR-18).

**2026-10-03 — unplugged, firmware 1.9.13.** Product id `gxrtu5vljdthtd3g`, the reference product; protocol 3.5; the local connection works with no cloud. The profile matches and decodes the capture (fixture `owner-fw1.9.13.json`). Differences from the reference capture: DP 101 reads `101` at rest; DP 102 carries an extra `wt` field; DP 106 carries `cp` — the IEC 61851 pilot voltage (12.6 V with no vehicle), a candidate signal for `vehicle` once the plugged and charging captures confirm 9 V / 6 V; new DP 153, a text log of state and setpoint changes (`"aset: 10A->8A (app)"`); new DP 190 (boolean, meaning unknown). DPs 104, 105, 140 and 154 are absent with no vehicle. None is published until its meaning is established.

**Writes.** `current` 16 → 8 → 10 → 8 A applied and confirmed by read-back in 1.6 s. Two transport defects found and fixed: on 3.5, tuyapi stops resolving `get()` after a `set()` (the reply arrives, its sequence number no longer matches), so the transport takes the status reply from the `data` event (command 16, or 10 on 3.3); and a verification now also accepts the value the device pushes on its own. One anomaly, not reproduced: the very first write was logged by the charger as `aset: 16A->807566790A` and not applied — the verified write rejected it as not reflected, which is the behaviour FR-16 asks for. Watched during the rest of the walk.

**2026-10-03 — vehicle plugged and charging.** The charger starts on its own when the cable is plugged (plug-in action left at its default). At 8 A: 227 V × 7.4 A, about 1.68 kW; DP 101 `300` charging, `204` paused, `200` ready; the pilot voltage in DP 106 reads 6.5 V while charging (12.6 V unplugged), the IEC 61851 C and A states. Fixtures: `charging` and `paused` in `owner-fw1.9.13.json`.

- **DP 140 is write-only on this firmware.** Writing it stops (PAUSE, relay off, power to 0 within 0.3 s) and restarts the charge, but the DP is never reported. An order may therefore carry its own proof of effect: `charge` is confirmed by the work state (DP 109 `WORKING` for on, anything else for off), and the `charge` reading is derived from the work state whenever DP 140 is absent. Walked: stop confirmed in 1.2 s, restart in 2.3 s (through a transient `IDLEINS`), 8 → 10 → 8 A in 1.3 s each.
- **DP 102 is pushed, not polled.** A full read returns the last pushed metrics unchanged; the device pushes DP 102 about every 60 s in a steady charge and more often around a state change, and ignores a DP_REFRESH request. The arbiter treats a load's draw older than 120 s as unknown, and a steady charge keeps the same wattage, so the profile declares its live keys (`power`, `current`, `voltage`) and the DP carrying them: they are republished whenever DP 102 changes, unchanged or not, and never on a stale full read. Walked: four minutes of charging, power republished every 60 s.
- **Energy.** First increment observed: `energy: 100` Wh when the session counter moved from 0.2 to 0.3 kWh.

**2026-10-03 — unplug and replug.** Unplugging: `WORKING → IDLEINS` (the car stops drawing, power and current published as 0), then `IDLE`, with a 0.2 s `IDLE ↔ IDLEINS` bounce as the plug comes out. On `IDLE` the charger writes the completed-session record (DP 105: `c` 5, 0.5 kWh over 1 217 s) and resets the session counter to 0. The plugin published `lastSessionEnergy` 0.5 and no energy increment, which is right: every 100 Wh of that session had already been counted. Replugging: `IDLE → IDLEINS → WORKING` in 1.5 s (auto-start), session duration from 0, and the new session's first increment, `energy: 100` Wh at 0.1 kWh, four minutes in. The momentary counter glitch the spec feared was not seen: the counter only reset at the end of a session.
