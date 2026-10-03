/**
 * Profile `depow_v2`: the dé portable EV charger, 3.7 kW, two buttons.
 *
 * DP map and scales from lachand/EV_charger@3fd6c18 (const.py,
 * tuya_ev_charger.py), measured there on this model; see spec 001,
 * architecture "DP map — depow_v2". DPs whose meaning is not established are
 * deliberately not decoded.
 */

import type { DiscoveredDevice } from "../sowel-api.js";
import type { Dps, EncodeResult, EnergyState, EnergyStep, ProductProfile } from "./profile.js";

const DP = {
  workState: "101",
  metrics: "102",
  alarm: "104",
  lastSession: "105",
  chargerInfo: "106",
  status: "109",
  charge: "140",
  currentSetpoint: "150",
  maxCurrent: "152",
  plugInAction: "154",
} as const;

const REQUIRED_DPS = [DP.workState, DP.metrics, DP.status, DP.currentSetpoint] as const;

/** Raw DP 109 → published status (tuya_local's map for product gxrtu5vljdthtd3g). */
const STATUS_MAP: Record<string, string> = {
  SLEEP: "sleep",
  IDLE: "idle",
  IDLEINS: "plugged_in",
  WORKING: "charging",
  WAIT: "waiting",
  ERRORPAUSE: "fault",
  PAUSE: "paused",
  STOP: "charged",
};
const STATUS_VALUES = [...Object.values(STATUS_MAP), "unknown"];

/** Statuses meaning a vehicle is plugged in but not drawing (IEC 61851 state B). */
const CONNECTED_STATUSES = new Set(["plugged_in", "waiting", "paused", "charged", "fault"]);
/** Above this the charger is really delivering: WORKING can linger after a full charge. */
const CHARGING_POWER_W = 100;

const PLUG_IN_ACTIONS = ["prompt", "charge", "idle"] as const;

/** IEC 61851 minimum; the pilot signal defines nothing below. */
const MIN_CURRENT_A = 6;
/** Ceiling when the device does not report DP 152. */
const DEFAULT_MAX_CURRENT_A = 16;

export const VEHICLE_VALUES = ["disconnected", "connected", "charging"] as const;

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (raw === 1 || raw === 0) return raw === 1;
  if (typeof raw === "string") {
    // Sowel's on/off surfaces send "ON"/"OFF" (spec 002 FR5).
    const s = raw.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "on") return true;
    if (s === "0" || s === "false" || s === "off") return false;
  }
  return null;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function maxCurrentOf(dps: Dps): number {
  const max = toNumber(dps[DP.maxCurrent]);
  return max !== null && max >= MIN_CURRENT_A ? max : DEFAULT_MAX_CURRENT_A;
}

function rawStatusOf(dps: Dps): string {
  const raw = dps[DP.status];
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

function isWorking(dps: Dps): boolean {
  const raw = dps[DP.status];
  return typeof raw === "string" && raw.trim().toUpperCase() === "WORKING";
}

/** A charge is active when DP 109 says WORKING or DP 140 says true (spec FR-11). */
function isCharging(dps: Dps): boolean {
  const raw = dps[DP.status];
  const status = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return status === "WORKING" || toBoolean(dps[DP.charge]) === true;
}

function decodeStatus(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return STATUS_MAP[raw.trim().toUpperCase()] ?? "unknown";
}

function decodeVehicle(status: string | undefined, powerW: number | undefined): string {
  if ((powerW ?? 0) >= CHARGING_POWER_W) return "charging";
  if (status === "charging" || (status !== undefined && CONNECTED_STATUSES.has(status))) {
    return "connected";
  }
  return "disconnected";
}

export const depowV2: ProductProfile = {
  id: "depow_v2",
  manufacturer: "dé",
  model: "Portable EV charger 3.7 kW",
  requiredDps: REQUIRED_DPS,
  liveKeys: ["power", "current", "voltage"],
  liveDps: [DP.metrics],

  match(dps: Dps): boolean {
    return REQUIRED_DPS.every((id) => dps[id] !== undefined && dps[id] !== null);
  },

  discovery(sourceId: string, dps: Dps): DiscoveredDevice {
    return {
      friendlyName: sourceId,
      manufacturer: this.manufacturer,
      model: this.model,
      powerSource: "mains",
      data: [
        { key: "status", type: "enum", category: "generic", enumValues: STATUS_VALUES },
        // Core spec 182 — the EV charger contract categories (spec 002).
        {
          key: "vehicle",
          type: "enum",
          category: "ev_vehicle_state",
          enumValues: [...VEHICLE_VALUES],
        },
        { key: "charge", type: "boolean", category: "appliance_state" },
        { key: "power", type: "number", category: "power", unit: "W" },
        { key: "energy", type: "number", category: "energy", unit: "Wh" },
        { key: "current", type: "number", category: "current", unit: "A" },
        { key: "voltage", type: "number", category: "voltage", unit: "V" },
        { key: "temperature", type: "number", category: "temperature_device", unit: "°C" },
        { key: "currentSetpoint", type: "number", category: "ev_charge_current", unit: "A" },
        { key: "maxCurrent", type: "number", category: "generic", unit: "A" },
        {
          key: "plugInAction",
          type: "enum",
          category: "generic",
          enumValues: [...PLUG_IN_ACTIONS],
        },
        { key: "sessionEnergy", type: "number", category: "ev_session_energy", unit: "kWh" },
        { key: "sessionDuration", type: "number", category: "generic", unit: "s" },
        { key: "lastSessionEnergy", type: "number", category: "generic", unit: "kWh" },
        { key: "alarm", type: "string", category: "generic" },
      ],
      orders: [
        // Wire values let the core map the "ON"/"OFF" its surfaces send.
        {
          key: "charge",
          type: "boolean",
          category: "toggle_power",
          valueOn: true,
          valueOff: false,
        },
        {
          key: "current",
          type: "number",
          category: "set_ev_charge_current",
          min: MIN_CURRENT_A,
          max: maxCurrentOf(dps),
          unit: "A",
        },
        { key: "plugInAction", type: "enum", enumValues: [...PLUG_IN_ACTIONS] },
      ],
    };
  },

  decode(dps: Dps): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    const status = decodeStatus(dps[DP.status]);
    if (status !== undefined) out.status = status;

    // DP 140 when the device reports it; otherwise the work state, since
    // firmware 1.9.13 accepts DP 140 writes but never reports the DP.
    const charge = toBoolean(dps[DP.charge]);
    if (charge !== null) out.charge = charge;
    else if (status !== undefined && status !== "unknown") out.charge = status === "charging";

    let powerW: number | undefined;
    const metrics = parseJsonObject(dps[DP.metrics]);
    if (metrics) {
      const l1 = metrics.L1;
      if (Array.isArray(l1) && l1.length >= 3) {
        const volts = toNumber(l1[0]);
        const amps = toNumber(l1[1]);
        if (volts !== null && amps !== null) {
          const charging = isCharging(dps);
          const voltage = round(volts / 10, 1);
          const current = charging ? round(amps / 10, 1) : 0;
          powerW = Math.round(voltage * current);
          out.voltage = voltage;
          out.current = current;
          out.power = powerW;
        }
      }
      const t = toNumber(metrics.t);
      if (t !== null) out.temperature = round(t / 10, 1);
      const e = toNumber(metrics.e);
      if (e !== null) out.sessionEnergy = round(e / 10, 1);
      const d = toNumber(metrics.d);
      if (d !== null) out.sessionDuration = Math.trunc(d / 10);
    }

    out.vehicle = decodeVehicle(status, powerW);

    const setpoint = toNumber(dps[DP.currentSetpoint]);
    if (setpoint !== null) out.currentSetpoint = setpoint;
    const max = toNumber(dps[DP.maxCurrent]);
    if (max !== null) out.maxCurrent = max;

    const action = toNumber(dps[DP.plugInAction]);
    if (action !== null && PLUG_IN_ACTIONS[action] !== undefined) {
      out.plugInAction = PLUG_IN_ACTIONS[action];
    }

    const last = parseJsonObject(dps[DP.lastSession]);
    const c = last ? toNumber(last.c) : null;
    if (c !== null) out.lastSessionEnergy = round(c / 10, 1);

    const alarm = dps[DP.alarm];
    if (alarm !== undefined && alarm !== null) {
      const text = String(alarm).trim();
      out.alarm = text === "0" ? "" : text;
    }

    return out;
  },

  liveIsDerived(dps: Dps): boolean {
    return !isCharging(dps);
  },

  whyNotReflected(orderKey: string, value: unknown, dps: Dps): string | null {
    if (orderKey !== "charge" || toBoolean(value) !== true) return null;
    // IEC 61851 state B (pilot about 9 V): a vehicle is there and is not asking
    // for current. The charger cannot make it draw.
    const info = parseJsonObject(dps[DP.chargerInfo]);
    const cp = info ? toNumber(info.cp) : null;
    if (cp !== null && cp >= 8 && cp <= 10.5) {
      return "the vehicle is not asking for current (battery full, or charging scheduled on the vehicle)";
    }
    if (rawStatusOf(dps) === "IDLE" || rawStatusOf(dps) === "SLEEP")
      return "no vehicle is plugged in";
    return null;
  },

  unknownValues(dps: Dps): string[] {
    const raw = dps[DP.status];
    if (typeof raw !== "string" || STATUS_MAP[raw.trim().toUpperCase()] !== undefined) return [];
    return [`status ${JSON.stringify(raw.trim())}`];
  },

  encode(orderKey: string, value: unknown, dps: Dps): EncodeResult {
    switch (orderKey) {
      case "charge": {
        const on = toBoolean(value);
        if (on === null)
          return { ok: false, reason: `charge expects a boolean, got ${String(value)}` };
        // DP 140 is write-only on firmware 1.9.13: the proof is the work state.
        // Off: the charger no longer delivers. On: it delivers, or it left the
        // state it was in without pausing — the charger obeyed even when the car
        // declines to draw (full, or its own schedule), seen on the hardware.
        const before = rawStatusOf(dps);
        return {
          ok: true,
          write: { [DP.charge]: on },
          confirm: (state: Dps) => {
            if (!on) return !isWorking(state);
            const now = rawStatusOf(state);
            return isWorking(state) || (now !== before && now !== "PAUSE");
          },
        };
      }
      case "current": {
        const n = toNumber(value);
        const max = maxCurrentOf(dps);
        if (n === null)
          return { ok: false, reason: `current expects a number, got ${String(value)}` };
        const amps = Math.round(n);
        if (amps < MIN_CURRENT_A || amps > max) {
          return { ok: false, reason: `current must be between ${MIN_CURRENT_A} and ${max} A` };
        }
        return { ok: true, write: { [DP.currentSetpoint]: amps } };
      }
      case "plugInAction": {
        const index = PLUG_IN_ACTIONS.indexOf(value as (typeof PLUG_IN_ACTIONS)[number]);
        if (index < 0) {
          return {
            ok: false,
            reason: `plugInAction must be one of ${PLUG_IN_ACTIONS.join(", ")}`,
          };
        }
        return { ok: true, write: { [DP.plugInAction]: index } };
      }
      default:
        return { ok: false, reason: `unknown order ${orderKey}` };
    }
  },

  energyStep(prev: EnergyState | null, dps: Dps): EnergyStep | null {
    const metrics = parseJsonObject(dps[DP.metrics]);
    const counter = metrics ? toNumber(metrics.e) : null;
    if (counter === null) return null;

    const rawRecord = dps[DP.lastSession];
    const record = typeof rawRecord === "string" ? rawRecord : null;

    // First read after start: the session so far may already be in the history.
    if (prev === null) return { deltaWh: 0, next: { counter, lastRecord: record } };

    // The record is only taken at the baseline and at a drop: a record that
    // arrives before the counter resets must still be seen as new at the drop.
    let tenths: number;
    let lastRecord = prev.lastRecord;
    if (counter >= prev.counter) {
      tenths = counter - prev.counter;
    } else {
      lastRecord = record ?? prev.lastRecord;
      // A new session started. Credit the unseen end of the previous one when
      // its completed-session record changed since last seen.
      tenths = counter;
      if (record !== null && record !== prev.lastRecord) {
        const closed = parseJsonObject(record);
        const c = closed ? toNumber(closed.c) : null;
        if (c !== null) tenths += Math.max(0, c - prev.counter);
      }
    }
    return {
      deltaWh: Math.max(0, Math.round(tenths * 100)),
      next: { counter, lastRecord },
    };
  },
};
