# Spec 002 — Publish the core EV charger contract

- **Status**: Implemented
- **Date**: 2026-10-03
- **Related**: core spec 182 (EV charger equipment type, `src/shared/ev-charger-contract.ts` in mchacher/sowel), spec 001 (this plugin's charger profile)

## Context

Core spec 182 made `ev_charger` a first-class equipment type. Its contract identifies each point by its **category**: the vehicle state, the charging current and the session energy each got a category of their own, and Sowel offers a device for an EV charger only when it declares them. v0.1.0 publishes those three points as `generic`, so the core does not recognise the dé charger as a charger, and its start/stop order declares no wire values, so the `"ON"` / `"OFF"` Sowel's on/off surfaces send reaches the plugin unmapped and is refused.

The equipment defines the contract; this plugin adapts to it.

## Goals

1. Publish the three points under the core categories, so the dé charger is offered and auto-bound as an `ev_charger`.
2. Make start/stop work from every Sowel surface.
3. Give the charging-current order the charger's real range.

## Non-goals

- Renaming device keys. The contract is carried by categories; keys stay as in v0.1.0 so nothing already bound breaks.
- Any other change to the profile or the transport.

## Functional requirements

- **FR1** `vehicle` is published with category `ev_vehicle_state` (values unchanged: `disconnected`, `connected`, `charging`).
- **FR2** `currentSetpoint` is published with category `ev_charge_current`.
- **FR3** `sessionEnergy` is published with category `ev_session_energy`.
- **FR4** The `current` order carries category `set_ev_charge_current`; its `min` is 6 A and its `max` is the charger's own maximum (DP 152) read at discovery, 16 A when the charger does not report it.
- **FR5** The `charge` order declares `valueOn: true` / `valueOff: false`, so the core maps `"ON"` / `"OFF"` to the boolean the plugin writes. The profile also accepts `"ON"` / `"OFF"` itself, for a core that does not map them.
- **FR6** Unchanged: `charge` (`appliance_state` / `toggle_power`), `power`, `energy`, `current`, `voltage`, `temperature` (`temperature_device`, which the core aliases `charger_temperature`). Every other point stays `generic`.

## Acceptance criteria

- [x] Discovery declares the categories of FR1-FR5, and the order range from DP 152.
- [x] `encode("charge", "ON")` and `encode("charge", "off")` give `{ "140": true }` / `{ "140": false }`.
- [ ] On a core ≥ the release carrying spec 182, the dé charger appears in the `ev_charger` device picker and auto-binds the contract aliases (checked against the core's binding tests, which use this plugin's shape).
- [x] `npm run validate` and CI green.

## Hardware findings (2026-10-03)

Walked on the owner's charger with v0.2.0: discovery declares the `current` order 6–16 A from DP 152 and the `charge` order with its wire values; `"OFF"` / `"ON"` reach the charger as booleans.

Two behaviours of the charger changed the implementation:

- **No reply to a write that changes nothing.** Writing DP 140 = false on a charger already stopped gets no answer, and tuyapi's `set()` waited for one until its timeout, so the order failed. Writes no longer wait for a reply; the session's read-back verification (spec 001 FR-16) is the proof.
- **The car may decline to draw.** Restarting a paused charge took the charger PAUSE → WORKING → IDLEINS: it obeyed, the car (full, or on its own schedule) did not draw. Start is now confirmed when the charger delivers, or when it left the state it was in without pausing; a start that changes nothing (already IDLEINS, car not drawing) is still reported as not reflected, which is true.
