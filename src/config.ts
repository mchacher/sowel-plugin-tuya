/**
 * Plugin settings → one validated device configuration (spec 001 FR-1).
 *
 * The only module that touches the `local_key` string before it reaches the
 * transport. It never logs; it returns warnings for the caller to log.
 */

import type { IntegrationSettingDef, SettingsManager } from "./sowel-api.js";

export const SETTINGS_PREFIX = "integration.tuya.";

export const PROTOCOL_VERSIONS = ["3.3", "3.4", "3.5"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];

const DEFAULT_PROTOCOL: ProtocolVersion = "3.5";
const DEFAULT_POLL_S = 30;
const MIN_POLL_S = 10;
const MAX_POLL_S = 300;

export interface DeviceConfig {
  host: string;
  deviceId: string;
  localKey: string;
  protocolVersion: ProtocolVersion;
  pollIntervalS: number;
}

export interface ConfigResult {
  config: DeviceConfig | null;
  warnings: string[];
  /** Set when the settings are filled in but unusable: the plugin reports `error`. */
  error?: string;
}

/** A Tuya local key is 16 characters; the transport refuses anything else. */
const LOCAL_KEY_LENGTH = 16;

export const SETTINGS_SCHEMA: IntegrationSettingDef[] = [
  {
    key: "host",
    label: "Adresse IP de l'appareil",
    type: "text",
    required: true,
    placeholder: "192.168.1.50",
  },
  {
    key: "device_id",
    label: "Device ID Tuya",
    type: "text",
    required: true,
  },
  {
    key: "local_key",
    label: "Local key",
    type: "password",
    required: true,
  },
  {
    key: "protocol_version",
    label: "Version du protocole (3.3, 3.4, 3.5)",
    type: "text",
    required: false,
    defaultValue: DEFAULT_PROTOCOL,
    placeholder: DEFAULT_PROTOCOL,
  },
  {
    key: "poll_interval",
    label: "Relecture complète (secondes)",
    type: "number",
    required: false,
    defaultValue: String(DEFAULT_POLL_S),
    placeholder: String(DEFAULT_POLL_S),
  },
];

function read(settings: SettingsManager, key: string): string {
  return (settings.get(SETTINGS_PREFIX + key) ?? "").trim();
}

/** The three required settings are filled in (valid or not). */
export function hasRequiredSettings(settings: SettingsManager): boolean {
  return ["host", "device_id", "local_key"].every((key) => read(settings, key) !== "");
}

export function readConfig(settings: SettingsManager): ConfigResult {
  const warnings: string[] = [];
  const host = read(settings, "host");
  const deviceId = read(settings, "device_id");
  const localKey = read(settings, "local_key");
  if (!host || !deviceId || !localKey) return { config: null, warnings };
  if (localKey.length !== LOCAL_KEY_LENGTH) {
    // The length only: never the key, nor a part of it.
    return {
      config: null,
      warnings,
      error: `local_key must be ${LOCAL_KEY_LENGTH} characters, got ${localKey.length}`,
    };
  }

  const rawVersion = read(settings, "protocol_version");
  let protocolVersion: ProtocolVersion = DEFAULT_PROTOCOL;
  if (rawVersion) {
    if ((PROTOCOL_VERSIONS as readonly string[]).includes(rawVersion)) {
      protocolVersion = rawVersion as ProtocolVersion;
    } else {
      warnings.push(`Unsupported protocol_version "${rawVersion}", using ${DEFAULT_PROTOCOL}`);
    }
  }

  const rawPoll = Number(read(settings, "poll_interval"));
  const pollIntervalS =
    read(settings, "poll_interval") === "" || !Number.isFinite(rawPoll)
      ? DEFAULT_POLL_S
      : Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, Math.round(rawPoll)));

  return { config: { host, deviceId, localKey, protocolVersion, pollIntervalS }, warnings };
}
