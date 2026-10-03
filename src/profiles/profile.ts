/**
 * A product profile: everything product-specific about a Tuya device.
 *
 * Profiles are pure — no I/O, no timers, no logger. The session holds one and
 * never names a DP id itself, so supporting a new product is a new profile
 * file and its fixtures (spec 001, architecture "Profile interface").
 */

import type { DiscoveredDevice } from "../sowel-api.js";

/** A DP snapshot as the device reports it: DP id (string) → raw value. */
export type Dps = Record<string, unknown>;

export type EncodeResult =
  | {
      ok: true;
      write: Dps;
      /**
       * How to tell the order took effect, when the written DP is not echoed
       * back (the dé charger never reports DP 140). Absent: the written DPs
       * must read back with the written values.
       */
      confirm?: (dps: Dps) => boolean;
    }
  | { ok: false; reason: string };

/** Memory the energy reducer carries from one snapshot to the next. */
export interface EnergyState {
  /** Session counter, in the device's own unit (tenths of kWh for depow_v2). */
  counter: number;
  /** Raw completed-session record last seen, to never credit it twice. */
  lastRecord: string | null;
}

export interface EnergyStep {
  deltaWh: number;
  next: EnergyState;
}

export interface ProductProfile {
  readonly id: string;
  readonly manufacturer: string;
  readonly model: string;
  /** True when the snapshot carries every DP this profile needs. */
  match(dps: Dps): boolean;
  /**
   * Live measurements republished with every real update even when unchanged,
   * so their consumers see them as fresh: the core's arbiter ignores a load's
   * draw older than 120 s, and a steady charge keeps the same wattage.
   */
  readonly liveKeys?: readonly string[];
  /** The DPs carrying them: the live keys are republished when one of these changed. */
  readonly liveDps?: readonly string[];
  /** DP ids this profile requires, for the mismatch log line. */
  readonly requiredDps: readonly string[];
  discovery(sourceId: string): DiscoveredDevice;
  /** Readings decoded from one snapshot. Keys whose DP is absent or malformed are omitted. */
  decode(dps: Dps): Record<string, unknown>;
  /**
   * Raw values the profile could not map (e.g. `status "FOO"`), for the session
   * to log once per distinct value.
   */
  unknownValues?(dps: Dps): string[];
  /** The DPs to write for an order, or why it is refused. */
  encode(orderKey: string, value: unknown, dps: Dps): EncodeResult;
  /**
   * Energy increment since the previous snapshot, from the device's own counter.
   * `null` when the snapshot carries no counter (state unchanged).
   */
  energyStep?(prev: EnergyState | null, dps: Dps): EnergyStep | null;
}
