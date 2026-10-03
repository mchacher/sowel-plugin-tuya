import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { depowV2 } from "./depow-v2.js";
import type { Dps, EnergyState } from "./profile.js";

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/depow-v2/reference.json", import.meta.url), "utf8"),
) as { charging: Dps };

const charging = (): Dps => ({ ...fixture.charging });

function metrics(fields: Record<string, unknown>): string {
  return JSON.stringify({ L1: [2270, 87, 19], L2: [0, 0, 0], L3: [0, 0, 0], t: 510, ...fields });
}

describe("depow_v2 match", () => {
  it("matches the reference snapshot, which has no DP 140", () => {
    expect(fixture.charging["140"]).toBeUndefined();
    expect(depowV2.match(charging())).toBe(true);
  });

  it.each(["101", "102", "109", "150"])("does not match without DP %s", (dp) => {
    const dps = charging();
    delete dps[dp];
    expect(depowV2.match(dps)).toBe(false);
  });
});

describe("depow_v2 decode", () => {
  it("decodes the charging reference snapshot", () => {
    const out = depowV2.decode(charging());
    expect(out.power).toBe(1975);
    expect(out.current).toBe(8.7);
    expect(out.voltage).toBe(227);
    expect(out.status).toBe("charging");
    expect(out.vehicle).toBe("charging");
    expect(out.temperature).toBe(51);
    expect(out.currentSetpoint).toBe(10);
    expect(out.maxCurrent).toBe(16);
  });

  it("zeroes power and current after a session even if DP 102 still echoes them", () => {
    const out = depowV2.decode({ ...charging(), "109": "STOP", "140": false });
    expect(out.power).toBe(0);
    expect(out.current).toBe(0);
    expect(out.voltage).toBe(227);
    expect(out.status).toBe("charged");
    expect(out.vehicle).toBe("connected");
  });

  it("derives charge from the work state when DP 140 is not reported", () => {
    expect(depowV2.decode(charging()).charge).toBe(true);
    expect(depowV2.decode({ ...charging(), "109": "PAUSE" }).charge).toBe(false);
    expect(depowV2.decode({ ...charging(), "109": "FOO" })).not.toHaveProperty("charge");
  });

  it("treats DP 140 true as an active charge whatever DP 109 says", () => {
    const out = depowV2.decode({ ...charging(), "109": "IDLEINS", "140": true });
    expect(out.power).toBe(1975);
    expect(out.charge).toBe(true);
  });

  it("reads a WORKING charger below 100 W as connected, not charging", () => {
    const out = depowV2.decode({ ...charging(), "102": metrics({ L1: [2300, 2, 0] }) });
    expect(out.power).toBe(46);
    expect(out.vehicle).toBe("connected");
  });

  it("reads IDLE as no vehicle", () => {
    const out = depowV2.decode({ ...charging(), "109": "IDLE" });
    expect(out.status).toBe("idle");
    expect(out.vehicle).toBe("disconnected");
  });

  it.each([
    ["SLEEP", "sleep"],
    ["IDLE", "idle"],
    ["IDLEINS", "plugged_in"],
    ["WORKING", "charging"],
    ["WAIT", "waiting"],
    ["ERRORPAUSE", "fault"],
    ["PAUSE", "paused"],
    ["STOP", "charged"],
    ["FOO", "unknown"],
  ])("maps raw status %s to %s", (raw, expected) => {
    expect(depowV2.decode({ ...charging(), "109": raw }).status).toBe(expected);
  });

  it("reports an unmapped status for the session to log", () => {
    expect(depowV2.unknownValues!({ ...charging(), "109": "FOO" })).toEqual(['status "FOO"']);
    expect(depowV2.unknownValues!(charging())).toEqual([]);
  });

  it("decodes the session counters", () => {
    const out = depowV2.decode({
      ...charging(),
      "102": metrics({ e: 52, d: 94200 }),
      "105": JSON.stringify({ c: 48, d: 7200 }),
    });
    expect(out.sessionEnergy).toBe(5.2);
    expect(out.sessionDuration).toBe(9420);
    expect(out.lastSessionEnergy).toBe(4.8);
  });

  it("decodes the temperature in tenths", () => {
    expect(depowV2.decode({ ...charging(), "102": metrics({ t: 312 }) }).temperature).toBe(31.2);
  });

  it.each([
    [0, "prompt"],
    [1, "charge"],
    [2, "idle"],
  ])("decodes DP 154 %s as %s", (raw, expected) => {
    expect(depowV2.decode({ ...charging(), "154": raw }).plugInAction).toBe(expected);
  });

  it.each([
    ["", ""],
    ["0", ""],
    ["E03", "E03"],
  ])("decodes alarm %j as %j", (raw, expected) => {
    expect(depowV2.decode({ ...charging(), "104": raw }).alarm).toBe(expected);
  });

  it.each([["not json"], [JSON.stringify({ L1: [2270, 87] })]])(
    "omits the measurements when DP 102 is malformed (%s)",
    (raw) => {
      const out = depowV2.decode({ ...charging(), "102": raw });
      expect(out).not.toHaveProperty("power");
      expect(out).not.toHaveProperty("current");
      expect(out).not.toHaveProperty("voltage");
      expect(out.status).toBe("charging");
      expect(out.currentSetpoint).toBe(10);
    },
  );

  it("uses L1 only, the unwired L2/L3 zeros are ignored", () => {
    expect(depowV2.decode(charging()).power).toBe(1975);
  });
});

describe("depow_v2 on the owner's charger (firmware 1.9.13)", () => {
  const owner = JSON.parse(
    readFileSync(new URL("./__fixtures__/depow-v2/owner-fw1.9.13.json", import.meta.url), "utf8"),
  ) as { unplugged: Dps; charging: Dps; paused: Dps };

  it("matches and decodes the unplugged capture", () => {
    expect(depowV2.match(owner.unplugged)).toBe(true);
    expect(depowV2.decode(owner.unplugged)).toEqual({
      status: "sleep",
      charge: false,
      vehicle: "disconnected",
      voltage: 224,
      current: 0,
      power: 0,
      temperature: 30,
      sessionEnergy: 0,
      sessionDuration: 0,
      currentSetpoint: 16,
      maxCurrent: 16,
    });
    expect(depowV2.unknownValues!(owner.unplugged)).toEqual([]);
  });

  it("decodes the charging capture (8 A setpoint, DP 140 absent)", () => {
    const out = depowV2.decode(owner.charging);
    expect(owner.charging["140"]).toBeUndefined();
    expect(out).toMatchObject({
      status: "charging",
      charge: true,
      vehicle: "charging",
      voltage: 227,
      current: 7.4,
      power: 1680,
      currentSetpoint: 8,
      sessionEnergy: 0.3,
    });
  });

  it("decodes the paused capture with no power", () => {
    expect(depowV2.decode(owner.paused)).toMatchObject({
      status: "paused",
      charge: false,
      vehicle: "connected",
      power: 0,
      current: 0,
    });
  });
});

describe("depow_v2 encode", () => {
  const dps = charging();

  it("encodes charge, confirmed by the work state since DP 140 is never echoed", () => {
    const on = depowV2.encode("charge", true, dps);
    const off = depowV2.encode("charge", false, dps);
    if (!on.ok || !off.ok) throw new Error("refused");
    expect(on.write).toEqual({ "140": true });
    expect(off.write).toEqual({ "140": false });
    expect(on.confirm!({ "109": "WORKING" })).toBe(true);
    // From WORKING (the reference snapshot) the charger is already enabled; a
    // later IDLEINS is the car stopping, not a refused order.
    expect(on.confirm!({ "109": "IDLEINS" })).toBe(true);
    expect(on.confirm!({ "109": "PAUSE" })).toBe(false);
    expect(off.confirm!({ "109": "PAUSE" })).toBe(true);
    expect(off.confirm!({ "109": "WORKING" })).toBe(false);
  });

  it("confirms a restart the car declines: the charger left PAUSE without charging", () => {
    const paused = { ...charging(), "109": "PAUSE" };
    const on = depowV2.encode("charge", true, paused);
    if (!on.ok) throw new Error("refused");
    expect(on.confirm!({ "109": "IDLEINS" })).toBe(true);
    expect(on.confirm!({ "109": "PAUSE" })).toBe(false);
  });

  it("does not confirm a start that changed nothing", () => {
    const plugged = { ...charging(), "109": "IDLEINS" };
    const on = depowV2.encode("charge", true, plugged);
    if (!on.ok) throw new Error("refused");
    expect(on.confirm!({ "109": "IDLEINS" })).toBe(false);
    expect(on.confirm!({ "109": "WORKING" })).toBe(true);
  });

  it.each([
    ["ON", true],
    ["off", false],
    ["On", true],
  ])("accepts Sowel's %s for charge", (value, on) => {
    expect(depowV2.encode("charge", value, dps)).toMatchObject({ ok: true, write: { "140": on } });
  });

  it("encodes a current within range, off the advertised shortcuts", () => {
    expect(depowV2.encode("current", 11, dps)).toEqual({ ok: true, write: { "150": 11 } });
  });

  it("rounds a fractional current", () => {
    expect(depowV2.encode("current", 10.6, dps)).toEqual({ ok: true, write: { "150": 11 } });
  });

  it.each([5, 17])("refuses %s A with DP 152 at 16", (amps) => {
    const result = depowV2.encode("current", amps, dps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("between 6 and 16 A");
  });

  it("refuses 20 A when DP 152 is absent (16 A default ceiling)", () => {
    const noMax = charging();
    delete noMax["152"];
    expect(depowV2.encode("current", 20, noMax).ok).toBe(false);
  });

  it("refuses a non-numeric current", () => {
    expect(depowV2.encode("current", "abc", dps).ok).toBe(false);
  });

  it("encodes plugInAction", () => {
    expect(depowV2.encode("plugInAction", "idle", dps)).toEqual({ ok: true, write: { "154": 2 } });
  });

  it("refuses an unknown plug-in action and an unknown order", () => {
    expect(depowV2.encode("plugInAction", "nope", dps).ok).toBe(false);
    expect(depowV2.encode("unknown", 1, dps).ok).toBe(false);
  });
});

describe("depow_v2 discovery", () => {
  it("declares the device with its 15 readings and 3 orders", () => {
    const d = depowV2.discovery("abc", charging());
    expect(d.friendlyName).toBe("abc");
    expect(d.manufacturer).toBe("dé");
    expect(d.data).toHaveLength(15);
    expect(d.orders).toHaveLength(3);
    const cat = (key: string) => d.data.find((x) => x.key === key)?.category;
    expect(cat("power")).toBe("power");
    expect(cat("energy")).toBe("energy");
    expect(cat("charge")).toBe("appliance_state");
    expect(cat("sessionEnergy")).toBe("ev_session_energy");
    expect(d.orders.find((o) => o.key === "charge")?.category).toBe("toggle_power");
  });

  it("publishes the core EV charger contract categories (spec 002)", () => {
    const d = depowV2.discovery("abc", charging());
    const cat = (key: string) => d.data.find((x) => x.key === key)?.category;
    expect(cat("vehicle")).toBe("ev_vehicle_state");
    expect(cat("currentSetpoint")).toBe("ev_charge_current");
    expect(cat("sessionEnergy")).toBe("ev_session_energy");
    // Unchanged.
    expect(cat("charge")).toBe("appliance_state");
    expect(cat("power")).toBe("power");
    expect(cat("energy")).toBe("energy");
    expect(cat("temperature")).toBe("temperature_device");
    const order = (key: string) => d.orders.find((o) => o.key === key);
    expect(order("current")).toMatchObject({ category: "set_ev_charge_current", min: 6, max: 16 });
    expect(order("charge")).toMatchObject({
      category: "toggle_power",
      valueOn: true,
      valueOff: false,
    });
  });

  it.each([
    [16, 16],
    [32, 32],
    [undefined, 16],
  ])("bounds the current order by DP 152 = %s → max %s", (dp152, max) => {
    const dps = charging();
    if (dp152 === undefined) delete dps["152"];
    else dps["152"] = dp152;
    expect(depowV2.discovery("abc", dps).orders.find((o) => o.key === "current")?.max).toBe(max);
  });

  it("declares every key decode can produce", () => {
    const declared = new Set(depowV2.discovery("abc", charging()).data.map((x) => x.key));
    const full = depowV2.decode({ ...charging(), "140": true, "154": 1, "104": "" });
    for (const key of Object.keys(full)) expect(declared.has(key)).toBe(true);
  });
});

describe("depow_v2 energyStep", () => {
  const snap = (e: number, record?: object): Dps => ({
    ...charging(),
    "102": metrics({ e }),
    ...(record ? { "105": JSON.stringify(record) } : {}),
  });
  const step = (prev: EnergyState | null, dps: Dps) => depowV2.energyStep!(prev, dps);

  it("only takes the baseline on the first read", () => {
    const r = step(null, snap(52));
    expect(r?.deltaWh).toBe(0);
    expect(r?.next.counter).toBe(52);
  });

  it("publishes the counter's increase within a session", () => {
    const a = step(null, snap(52))!;
    const b = step(a.next, snap(53))!;
    const c = step(b.next, snap(55))!;
    expect(b.deltaWh).toBe(100);
    expect(c.deltaWh).toBe(200);
    expect(step(c.next, snap(55))!.deltaWh).toBe(0);
  });

  it("counts a new session from zero when the counter drops", () => {
    const a = step(null, snap(55, { c: 13 }))!;
    expect(step(a.next, snap(3, { c: 13 }))!.deltaWh).toBe(300);
  });

  it("credits the unseen end of the previous session from DP 105", () => {
    const a = step(null, snap(55, { c: 13 }))!;
    expect(step(a.next, snap(3, { c: 58 }))!.deltaWh).toBe(600);
  });

  it("never credits a negative end of session", () => {
    const a = step(null, snap(55, { c: 13 }))!;
    expect(step(a.next, snap(3, { c: 50 }))!.deltaWh).toBe(300);
  });

  it("does not credit the same DP 105 record twice", () => {
    const a = step(null, snap(55, { c: 13 }))!;
    const b = step(a.next, snap(3, { c: 58 }))!;
    const c = step(b.next, snap(4, { c: 58 }))!;
    expect(c.deltaWh).toBe(100);
    // A second drop with the record unchanged credits nothing from it.
    expect(step(c.next, snap(1, { c: 58 }))!.deltaWh).toBe(100);
  });

  it("credits a record that arrived before the counter reset", () => {
    const a = step(null, snap(55, { c: 13 }))!;
    const early = step(a.next, snap(55, { c: 58 }))!; // record first, counter not reset yet
    expect(early.deltaWh).toBe(0);
    expect(step(early.next, snap(3, { c: 58 }))!.deltaWh).toBe(600);
  });

  it("returns null when the snapshot carries no counter", () => {
    expect(step({ counter: 5, lastRecord: null }, { "102": "not json" })).toBeNull();
  });

  it("sums to the session totals over a replayed session and a new one", () => {
    const first = [0, 3, 7, 12, 20, 26];
    const second = [1, 4, 9];
    let state = step(null, snap(0, { c: 13 }))!.next;
    let total = 0;
    for (const e of [...first.slice(1)]) {
      const r = step(state, snap(e, { c: 13 }))!;
      total += r.deltaWh;
      state = r.next;
    }
    for (const e of second) {
      const r = step(state, snap(e, { c: 26 }))!;
      total += r.deltaWh;
      state = r.next;
    }
    expect(total).toBe((26 + 9) * 100);
  });
});
