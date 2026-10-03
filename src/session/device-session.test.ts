import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { depowV2 } from "../profiles/depow-v2.js";
import type { Dps } from "../profiles/profile.js";
import type { DeviceManager, Logger } from "../sowel-api.js";
import { FakeTransport } from "../transport/fake-transport.testing.js";
import { DeviceSession } from "./device-session.js";

const reference = (
  JSON.parse(
    readFileSync(
      new URL("../profiles/__fixtures__/depow-v2/reference.json", import.meta.url),
      "utf8",
    ),
  ) as { charging: Dps }
).charging;

function metrics(e: number, l1: number[] = [2270, 87, 19]): string {
  return JSON.stringify({ L1: l1, L2: [0, 0, 0], L3: [0, 0, 0], t: 510, e, d: 1000 });
}

interface Harness {
  session: DeviceSession;
  transport: FakeTransport;
  dm: { [K in keyof DeviceManager]: ReturnType<typeof vi.fn> };
  logger: { [K in keyof Logger]: ReturnType<typeof vi.fn> };
}

function harness(state: Dps = reference, pollIntervalS = 30): Harness {
  const transport = new FakeTransport(state);
  const dm = {
    upsertFromDiscovery: vi.fn(),
    updateDeviceData: vi.fn(),
    updateDeviceStatus: vi.fn(),
    removeStaleDevices: vi.fn(),
    logSummary: vi.fn(),
  };
  const logger = {} as Harness["logger"];
  Object.assign(logger, {
    child: vi.fn(() => logger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
  const session = new DeviceSession({
    integrationId: "tuya",
    sourceId: "dev1",
    host: "192.168.1.50",
    pollIntervalS,
    transport,
    profile: depowV2,
    deviceManager: dm as unknown as DeviceManager,
    logger: logger as unknown as Logger,
    secret: "TEST_ONLY_SENTINEL",
  });
  return { session, transport, dm, logger };
}

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

/** Last `updateDeviceData` payload. */
function lastData(h: Harness): Record<string, unknown> {
  const calls = h.dm.updateDeviceData.mock.calls;
  return calls[calls.length - 1][2] as Record<string, unknown>;
}

function statuses(h: Harness): string[] {
  return h.dm.updateDeviceStatus.mock.calls.map((c) => c[2] as string);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DeviceSession — start and publish", () => {
  it("discovers once, publishes everything, goes online", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.dm.upsertFromDiscovery).toHaveBeenCalledTimes(1);
    expect(h.dm.upsertFromDiscovery.mock.calls[0][1]).toBe("tuya");
    expect(h.dm.updateDeviceData).toHaveBeenCalledTimes(1);
    expect(lastData(h)).toMatchObject({ power: 1975, status: "charging", vehicle: "charging" });
    expect(lastData(h)).not.toHaveProperty("energy");
    expect(statuses(h)).toEqual(["online"]);
    expect(h.session.health()).toBe("online");
    h.session.stop();
  });

  it("refuses a device that does not match the profile", async () => {
    const state = { ...reference };
    delete state["150"];
    const h = harness(state);
    h.session.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.dm.upsertFromDiscovery).not.toHaveBeenCalled();
    expect(h.dm.updateDeviceData).not.toHaveBeenCalled();
    expect(h.session.health()).toBe("mismatch");
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const context = h.logger.error.mock.calls[0][0] as { reported: string[] };
    expect(context.reported).toContain("101:number");
    expect(JSON.stringify(context)).not.toContain("2270");
    expect(h.transport.connect).toHaveBeenCalledTimes(1);
  });

  it("confirms a mismatch on a second read before refusing", async () => {
    const partial = { ...reference };
    delete partial["150"];
    const h = harness(partial);
    h.transport.getAll.mockImplementationOnce(async () => ({ ...partial }));
    h.transport.state = { ...reference }; // the second read is complete
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.getAll).toHaveBeenCalledTimes(2);
    expect(h.dm.upsertFromDiscovery).toHaveBeenCalledTimes(1);
    expect(h.session.health()).toBe("online");
    h.session.stop();
  });

  it("merges a partial push and publishes only what changed", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.push({ "102": metrics(52, [2300, 87, 19]) });
    // Only DP 102 moved: voltage, power and its session duration, plus the
    // unchanged live current republished with them; nothing else.
    expect(lastData(h)).toEqual({ voltage: 230, power: 2001, sessionDuration: 100, current: 8.7 });
    h.session.stop();
  });

  it("republishes the live measurements with any real update", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    // Steady charge: same L1, only the session duration moved.
    h.transport.push({
      "102": JSON.stringify({
        L1: [2270, 87, 19],
        L2: [0, 0, 0],
        L3: [0, 0, 0],
        t: 510,
        e: 52,
        d: 95190,
      }),
    });
    expect(lastData(h)).toEqual({ sessionDuration: 9519, power: 1975, current: 8.7, voltage: 227 });
    h.session.stop();
  });

  it("does not refresh the live measurements on an unrelated change", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.push({ "150": 12 });
    expect(lastData(h)).toEqual({ currentSetpoint: 12 });
    h.session.stop();
  });

  it("publishes nothing on a push with no change", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.push({ "150": 10 });
    expect(h.dm.updateDeviceData).toHaveBeenCalledTimes(1);
    h.session.stop();
  });

  it("publishes two equal energy increments", async () => {
    const h = harness({ ...reference, "102": metrics(10) });
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.push({ "102": metrics(11) });
    expect(lastData(h)).toMatchObject({ sessionEnergy: 1.1, energy: 100 });
    h.transport.push({ "102": metrics(12) });
    expect(lastData(h)).toMatchObject({ sessionEnergy: 1.2, energy: 100 });
    h.session.stop();
  });

  it("logs an unmapped status once", async () => {
    const h = harness({ ...reference, "109": "FOO" });
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.push({ "150": 12 });
    const unmapped = h.logger.warn.mock.calls.filter(
      (c) => c[1] === "Unmapped value reported by the device",
    );
    expect(unmapped).toHaveLength(1);
    h.session.stop();
  });
});

describe("DeviceSession — poll, reconnect, offline", () => {
  it("polls every poll_interval", async () => {
    const h = harness(reference, 30);
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.getAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.transport.getAll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.transport.getAll).toHaveBeenCalledTimes(3);
    h.session.stop();
  });

  it("retries a refused connection with backoff and logs it once", async () => {
    const h = harness();
    h.transport.connectFailures = [refused(), refused(), refused()];
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.transport.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.transport.connect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.transport.connect).toHaveBeenCalledTimes(4);
    const refusedLogs = h.logger.warn.mock.calls.filter(
      (c) => (c[0] as { kind?: string }).kind === "refused",
    );
    expect(refusedLogs).toHaveLength(1);
    expect(h.session.health()).toBe("online");
    h.session.stop();
  });

  it("caps the backoff at 5 min and resets it after success", async () => {
    const h = harness();
    h.transport.connectFailures = Array.from({ length: 10 }, refused);
    h.session.start();
    // 5+10+20+40+80+160+300+300+300+300 s
    await vi.advanceTimersByTimeAsync((5 + 10 + 20 + 40 + 80 + 160 + 300 + 300 + 300) * 1000);
    expect(h.transport.connect).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(h.transport.connect).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.transport.connect).toHaveBeenCalledTimes(11);
    expect(h.session.health()).toBe("online");
    // Reset: the next drop reconnects after 5 s again.
    h.transport.dropConnection();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.transport.connect).toHaveBeenCalledTimes(12);
    h.session.stop();
  });

  it("goes offline once, 60 s after a drop that does not recover", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.connectFailures = Array.from({ length: 5 }, refused);
    h.transport.dropConnection();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(statuses(h)).toEqual(["online"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statuses(h)).toEqual(["online", "offline"]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(statuses(h)).toEqual(["online", "offline"]);
    h.session.stop();
  });

  it("goes offline after two failed polls", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.getFailures = [new Error("Timeout waiting"), new Error("Timeout waiting")];
    h.transport.connectFailures = [refused()];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statuses(h)).toEqual(["online"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statuses(h)).toEqual(["online", "offline"]);
    h.session.stop();
  });

  it("recovers online and republishes on the next read", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.connectFailures = Array.from({ length: 4 }, refused);
    h.transport.dropConnection();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.session.health()).toBe("offline");
    h.transport.state = { ...h.transport.state, "150": 12 };
    await vi.advanceTimersByTimeAsync(300_000);
    expect(statuses(h)).toEqual(["online", "offline", "online"]);
    expect(lastData(h)).toEqual({ currentSetpoint: 12 });
    h.session.stop();
  });

  it("catches up energy on reconnect mid-charge", async () => {
    const h = harness({ ...reference, "102": metrics(10) });
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.dropConnection();
    h.transport.state = { ...h.transport.state, "102": metrics(13) };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lastData(h)).toMatchObject({ energy: 300 });
    h.session.stop();
  });

  it("does not publish energy on the first read after a restart", async () => {
    const first = harness({ ...reference, "102": metrics(40) });
    first.session.start();
    await vi.advanceTimersByTimeAsync(0);
    first.session.stop();
    const h = harness({ ...reference, "102": metrics(44) });
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastData(h)).not.toHaveProperty("energy");
    h.transport.push({ "102": metrics(45) });
    expect(lastData(h)).toMatchObject({ energy: 100 });
    h.session.stop();
  });

  it("does not wedge on a read that never settles", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.transport.getGate = new Promise(() => undefined); // the next reads hang forever
    await vi.advanceTimersByTimeAsync(30_000 + 20_000);
    h.transport.getGate = null;
    // The hung poll was abandoned: the next poll runs and succeeds.
    h.transport.state = { ...h.transport.state, "150": 13 };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lastData(h)).toEqual({ currentSetpoint: 13 });
    h.session.stop();
  });

  it("retries a connection that never settles", async () => {
    const h = harness();
    h.transport.connect.mockImplementationOnce(() => new Promise(() => undefined));
    h.session.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.session.health()).toBe("connecting");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.transport.connect).toHaveBeenCalledTimes(2);
    expect(h.session.health()).toBe("online");
    h.session.stop();
  });

  it("keeps an undecryptable diagnosis and logs each failure kind once", async () => {
    const h = harness();
    const decrypt = () => new Error("Decrypt failed");
    const silent = () => new Error("Session negotiation timed out");
    h.transport.connectFailures = [decrypt(), silent(), decrypt(), silent()];
    h.session.start();
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000);
    expect(h.transport.connect).toHaveBeenCalledTimes(4);
    expect(h.session.health()).toBe("undecryptable");
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const timeouts = h.logger.warn.mock.calls.filter(
      (c) => (c[0] as { kind?: string }).kind === "timeout",
    );
    expect(timeouts).toHaveLength(1);
    h.session.stop();
  });

  it("reports undecryptable replies", async () => {
    const h = harness();
    h.transport.connectFailures = [new Error("Decrypt failed")];
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.health()).toBe("undecryptable");
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    h.session.stop();
  });
});

describe("DeviceSession — orders", () => {
  async function online(state: Dps = reference): Promise<Harness> {
    const h = harness(state);
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    return h;
  }

  it("resolves once the device reflects the order", async () => {
    const h = await online();
    h.transport.echo = false;
    const done = h.session.executeOrder("current", 12);
    await vi.advanceTimersByTimeAsync(1_000);
    h.transport.state = { ...h.transport.state, "150": 12 };
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
    expect(lastData(h)).toMatchObject({ currentSetpoint: 12 });
    h.session.stop();
  });

  it("confirms a stop by the work state, as the device never echoes DP 140", async () => {
    const h = await online();
    h.transport.echo = false; // DP 140 never comes back, like on the real charger
    const done = h.session.executeOrder("charge", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.set).toHaveBeenCalledWith({ "140": false });
    h.transport.push({ "109": "PAUSE", "101": 204 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
    expect(lastData(h)).toMatchObject({ status: "paused", charge: false, power: 0 });
    h.session.stop();
  });

  it("resolves from a push even when every read-back fails", async () => {
    const h = await online();
    h.transport.echo = false;
    h.transport.getFailures = Array.from({ length: 8 }, () => new Error("Timeout waiting"));
    const done = h.session.executeOrder("current", 8);
    await vi.advanceTimersByTimeAsync(0);
    h.transport.push({ "150": 8 }); // the device reports the new value on its own
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
    expect(h.transport.getAll).toHaveBeenCalledTimes(1); // no read-back was needed
    h.session.stop();
  });

  it("rejects when the order is never reflected, and stays online", async () => {
    const h = await online();
    h.transport.echo = false;
    const done = h.session.executeOrder("current", 12);
    const assertion = expect(done).rejects.toThrow("not reflected");
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
    expect(h.transport.getAll).toHaveBeenCalledTimes(1 + 8);
    expect(h.session.health()).toBe("online");
    h.session.stop();
  });

  it("rejects an order interrupted by stop, without a not-reflected warning", async () => {
    const h = await online();
    h.transport.echo = false;
    const done = h.session.executeOrder("charge", true);
    const assertion = expect(done).rejects.toThrow("plugin stopped");
    await vi.advanceTimersByTimeAsync(500);
    h.session.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    const notReflected = h.logger.warn.mock.calls.filter(
      (c) => c[1] === "Order not reflected by the device",
    );
    expect(notReflected).toHaveLength(0);
  });

  it("rejects while offline without writing", async () => {
    const h = harness();
    h.transport.connectFailures = [refused()];
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(h.session.executeOrder("charge", true)).rejects.toThrow("offline");
    expect(h.transport.set).not.toHaveBeenCalled();
    h.session.stop();
  });

  it("rejects an order the profile refuses, without writing", async () => {
    const h = await online();
    await expect(h.session.executeOrder("current", 40)).rejects.toThrow("between 6 and 16 A");
    expect(h.transport.set).not.toHaveBeenCalled();
    h.session.stop();
  });

  it("queues an order behind a poll in flight", async () => {
    const h = await online();
    let release: () => void = () => undefined;
    h.transport.getGate = new Promise((r) => (release = r));
    await vi.advanceTimersByTimeAsync(30_000); // poll starts, held
    const done = h.session.executeOrder("current", 12);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.set).not.toHaveBeenCalled();
    h.transport.getGate = null;
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    const order = h.transport.calls;
    const setAt = order.findIndex((c) => c.startsWith("set:"));
    expect(order.slice(0, setAt)).toContain("getAll:end");
    expect(order.lastIndexOf("getAll:start", setAt)).toBeLessThan(
      order.lastIndexOf("getAll:end", setAt),
    );
    h.session.stop();
  });
});

describe("DeviceSession — stop and robustness", () => {
  it("stops timers, disconnects and ignores later pushes", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.session.stop();
    expect(h.transport.disconnect).toHaveBeenCalled();
    h.transport.push({ "150": 12 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.dm.updateDeviceData).toHaveBeenCalledTimes(1);
    expect(h.transport.getAll).toHaveBeenCalledTimes(1);
    expect(h.session.health()).toBe("stopped");
    await expect(h.session.executeOrder("charge", true)).rejects.toThrow("offline");
  });

  it("contains a failure in the push handling path", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    h.dm.updateDeviceData.mockImplementation(() => {
      throw new Error("core exploded");
    });
    expect(() => h.transport.push({ "150": 12 })).not.toThrow();
    expect(h.logger.error).toHaveBeenCalledWith(
      { error: "core exploded" },
      "Failed to handle a pushed update",
    );
    h.session.stop();
  });

  it("contains a transport error event", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => h.transport.emitError(new Error("boom"))).not.toThrow();
    h.session.stop();
  });
});
