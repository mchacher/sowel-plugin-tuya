import { describe, expect, it, vi } from "vitest";
import { createPlugin, INTEGRATION_ID } from "./index.js";
import type { Logger, PluginDeps } from "./sowel-api.js";

function fakeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return logger;
}

function fakeDeps(): PluginDeps {
  return {
    logger: fakeLogger(),
    eventBus: { emit: vi.fn() },
    settingsManager: { get: () => undefined },
    deviceManager: {
      upsertFromDiscovery: vi.fn(),
      updateDeviceData: vi.fn(),
      updateDeviceStatus: vi.fn(),
      removeStaleDevices: vi.fn(),
      logSummary: vi.fn(),
    },
    pluginDir: "/tmp/plugin",
  };
}

describe("createPlugin", () => {
  it("declares the tuya identity", () => {
    const plugin = createPlugin(fakeDeps());
    expect(plugin.id).toBe(INTEGRATION_ID);
    expect(plugin.apiVersion).toBe(2);
    expect(plugin.getSettingsSchema()).toEqual([]);
  });

  it("stays not configured until a device can be declared", async () => {
    const plugin = createPlugin(fakeDeps());
    expect(plugin.isConfigured()).toBe(false);
    await plugin.start();
    expect(plugin.getStatus()).toBe("not_configured");
    await plugin.stop();
    expect(plugin.getStatus()).toBe("disconnected");
  });

  it("never throws on an order it does not handle yet", async () => {
    const plugin = createPlugin(fakeDeps());
    const device = {
      id: "d1",
      integrationId: INTEGRATION_ID,
      sourceDeviceId: "charger-1",
      name: "Charger",
    };
    await expect(plugin.executeOrder(device, "charge", true)).resolves.toBeUndefined();
  });
});
