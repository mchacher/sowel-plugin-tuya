import { describe, expect, it } from "vitest";
import { readConfig, SETTINGS_PREFIX } from "./config.js";
import type { SettingsManager } from "./sowel-api.js";

function settings(values: Record<string, string>): SettingsManager {
  return { get: (key) => values[key.slice(SETTINGS_PREFIX.length)] };
}

// Built, not written as a literal, so the repository's own secret scan stays strict.
const FAKE_KEY = ["TEST", "ONLY", "KEY", "01"].join("_");
const required = { host: "192.168.1.50", device_id: "bf123", local_key: FAKE_KEY };

describe("readConfig", () => {
  it("reads the required settings with defaults", () => {
    const { config, warnings } = readConfig(settings(required));
    expect(config).toEqual({
      host: "192.168.1.50",
      deviceId: "bf123",
      localKey: FAKE_KEY,
      protocolVersion: "3.5",
      pollIntervalS: 30,
    });
    expect(warnings).toEqual([]);
  });

  it.each(["host", "device_id", "local_key"])("is not configured without %s", (key) => {
    expect(readConfig(settings({ ...required, [key]: "  " })).config).toBeNull();
    const missing: Record<string, string> = { ...required };
    delete missing[key];
    expect(readConfig(settings(missing)).config).toBeNull();
  });

  it("reports a local_key of the wrong length as an error, without the key", () => {
    const result = readConfig(settings({ ...required, local_key: "TEST_ONLY_SHORT" }));
    expect(result.config).toBeNull();
    expect(result.error).toBe("local_key must be 16 characters, got 15");
  });

  it("keeps a supported protocol version", () => {
    expect(
      readConfig(settings({ ...required, protocol_version: "3.3" })).config?.protocolVersion,
    ).toBe("3.3");
  });

  it("falls back to 3.5 with a warning on an unsupported version", () => {
    const { config, warnings } = readConfig(settings({ ...required, protocol_version: "9" }));
    expect(config?.protocolVersion).toBe("3.5");
    expect(warnings).toHaveLength(1);
  });

  it.each([
    ["2", 10],
    ["1000", 300],
    ["x", 30],
  ])("clamps poll_interval %s to %s", (raw, expected) => {
    expect(readConfig(settings({ ...required, poll_interval: raw })).config?.pollIntervalS).toBe(
      expected,
    );
  });
});
