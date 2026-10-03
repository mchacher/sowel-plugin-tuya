import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createPlugin, INTEGRATION_ID, type TransportFactory } from "./index.js";
import type { Dps } from "./profiles/profile.js";
import type { Logger, PluginDeps } from "./sowel-api.js";
import { FakeTransport } from "./transport/fake-transport.testing.js";

const reference = (
  JSON.parse(
    readFileSync(
      new URL("./profiles/__fixtures__/depow-v2/reference.json", import.meta.url),
      "utf8",
    ),
  ) as { charging: Dps }
).charging;

const SENTINEL = "TEST_ONLY_KEY_99";

function recordingLogger(sink: unknown[][]): Logger {
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      sink.push([level, ...args]);
  const logger: Logger = {
    child: (bindings) => {
      sink.push(["child", bindings]);
      return logger;
    },
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  };
  return logger;
}

function setup(
  settings: Record<string, string>,
  state: Dps = reference,
  prepare?: (t: FakeTransport) => void,
) {
  const logs: unknown[][] = [];
  const transports: FakeTransport[] = [];
  const factory: TransportFactory = vi.fn(() => {
    const t = new FakeTransport(state);
    prepare?.(t);
    transports.push(t);
    return t;
  });
  const deps: PluginDeps = {
    logger: recordingLogger(logs),
    eventBus: { emit: vi.fn() },
    settingsManager: { get: (key) => settings[key.replace("integration.tuya.", "")] },
    deviceManager: {
      upsertFromDiscovery: vi.fn(),
      updateDeviceData: vi.fn(),
      updateDeviceStatus: vi.fn(),
      removeStaleDevices: vi.fn(),
      logSummary: vi.fn(),
    },
    pluginDir: "/tmp/plugin",
  };
  return { plugin: createPlugin(deps, factory), deps, logs, transports, factory };
}

const configured = { host: "192.168.1.50", device_id: "dev1", local_key: SENTINEL };
const device = { id: "d1", integrationId: INTEGRATION_ID, sourceDeviceId: "dev1", name: "Charger" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TuyaPlugin", () => {
  it("declares its identity and settings", () => {
    const { plugin } = setup({});
    expect(plugin.id).toBe(INTEGRATION_ID);
    expect(plugin.apiVersion).toBe(2);
    const schema = plugin.getSettingsSchema();
    expect(schema.map((s) => s.key)).toEqual([
      "host",
      "device_id",
      "local_key",
      "protocol_version",
      "poll_interval",
    ]);
    expect(schema.find((s) => s.key === "local_key")?.type).toBe("password");
  });

  it("stays not configured and creates no transport without the required settings", async () => {
    const { plugin, factory } = setup({ host: "192.168.1.50" });
    expect(plugin.isConfigured()).toBe(false);
    await plugin.start();
    expect(plugin.getStatus()).toBe("not_configured");
    expect(factory).not.toHaveBeenCalled();
  });

  it("is connected once the device is online", async () => {
    const { plugin } = setup(configured);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.getStatus()).toBe("connected");
    await plugin.stop();
  });

  it("reports error on a device that does not match the profile", async () => {
    const state = { ...reference };
    delete state["101"];
    const { plugin } = setup(configured, state);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.getStatus()).toBe("error");
    await plugin.stop();
  });

  it("rejects an order for another device", async () => {
    const { plugin } = setup(configured);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      plugin.executeOrder({ ...device, sourceDeviceId: "other" }, "charge", true),
    ).rejects.toThrow("Unknown Tuya device");
    await plugin.stop();
  });

  it("stops its session", async () => {
    const { plugin, transports } = setup(configured);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    await plugin.stop();
    expect(plugin.getStatus()).toBe("disconnected");
    expect(transports[0].disconnect).toHaveBeenCalled();
  });

  it("never lets the local_key out: logs, published data, order errors", async () => {
    const outputs: unknown[] = [];
    const collect = async (
      run: (s: ReturnType<typeof setup>) => Promise<void>,
      state?: Dps,
      prepare?: (t: FakeTransport) => void,
    ) => {
      const s = setup(configured, state, prepare);
      await run(s);
      outputs.push(s.logs);
      const dm = s.deps.deviceManager as unknown as Record<string, { mock: { calls: unknown[] } }>;
      outputs.push(dm.updateDeviceData.mock.calls, dm.upsertFromDiscovery.mock.calls);
    };
    const rejection = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        outputs.push((err as Error).message);
      }
    };

    // Online, then orders refused, not reflected, offline.
    await collect(async ({ plugin, transports }) => {
      await plugin.start();
      await vi.advanceTimersByTimeAsync(0);
      await rejection(plugin.executeOrder(device, "current", 40));
      transports[0].echo = false;
      const notReflected = rejection(plugin.executeOrder(device, "charge", true));
      await vi.advanceTimersByTimeAsync(8_000);
      await notReflected;
      transports[0].emitError(new Error(`Decrypt failed with ${SENTINEL}`));
      await plugin.stop();
      await rejection(plugin.executeOrder(device, "charge", true));
    });

    // Mismatch.
    const partial = { ...reference };
    delete partial["102"];
    await collect(async ({ plugin }) => {
      await plugin.start();
      await vi.advanceTimersByTimeAsync(0);
      await plugin.stop();
    }, partial);

    // Refused, then undecryptable.
    await collect(
      async ({ plugin }) => {
        await plugin.start();
        await vi.advanceTimersByTimeAsync(20_000);
        await plugin.stop();
      },
      reference,
      (t) => {
        t.connectFailures = [
          Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
          new Error(`HMAC mismatch for key ${SENTINEL}`),
        ];
      },
    );

    const text = JSON.stringify(outputs, (_k, v: unknown) => (v instanceof Error ? v.message : v));
    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toContain(SENTINEL);
  });
});

describe("manifest", () => {
  it("declares the same settings as the plugin", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
    ) as {
      id: string;
      settings: unknown[];
    };
    expect(manifest.id).toBe(INTEGRATION_ID);
    expect(manifest.settings).toEqual(setup({}).plugin.getSettingsSchema());
  });
});
