/**
 * Sowel plugin: Tuya (local)
 *
 * Talks to Tuya devices over the local network — no cloud at runtime — and
 * publishes each one as an ordinary Sowel device. What a device exposes is
 * decided by its product profile (a data-point map); the first profile is the
 * dé EV charger (spec 001).
 */

import { hasRequiredSettings, readConfig, SETTINGS_SCHEMA, type DeviceConfig } from "./config.js";
import { depowV2 } from "./profiles/depow-v2.js";
import { DeviceSession } from "./session/device-session.js";
import type {
  Device,
  IntegrationPlugin,
  IntegrationSettingDef,
  IntegrationStatus,
  Logger,
  PluginDeps,
} from "./sowel-api.js";
import type { TuyaTransport } from "./transport/transport.js";
import { TuyapiTransport } from "./transport/tuyapi-transport.js";

export const INTEGRATION_ID = "tuya";

export type TransportFactory = (config: DeviceConfig) => TuyaTransport;

const defaultTransport: TransportFactory = (config) =>
  new TuyapiTransport({
    host: config.host,
    deviceId: config.deviceId,
    localKey: config.localKey,
    protocolVersion: config.protocolVersion,
  });

class TuyaPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Tuya (local)";
  readonly description =
    "Tuya devices over the local network, no cloud at runtime. First supported product: the dé EV charger";
  readonly icon = "PlugZap";
  readonly apiVersion = 2;

  private readonly logger: Logger;
  private session: DeviceSession | null = null;
  private sourceId: string | null = null;
  private stopped = true;
  private configError = false;

  constructor(
    private readonly deps: PluginDeps,
    private readonly createTransport: TransportFactory,
  ) {
    this.logger = deps.logger.child({ module: "tuya" });
  }

  getStatus(): IntegrationStatus {
    if (this.configError) return "error";
    if (!this.session) return this.idleStatus();
    switch (this.session.health()) {
      case "online":
        return "connected";
      case "undecryptable":
      case "mismatch":
        return "error";
      default:
        return "disconnected";
    }
  }

  isConfigured(): boolean {
    return hasRequiredSettings(this.deps.settingsManager);
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return SETTINGS_SCHEMA;
  }

  async start(): Promise<void> {
    this.stopSession();
    this.stopped = false;
    const { config, warnings, error } = readConfig(this.deps.settingsManager);
    for (const warning of warnings) this.logger.warn(warning);
    this.configError = error !== undefined;
    if (error) {
      this.logger.error({ reason: error }, "Tuya plugin settings are invalid");
      return;
    }
    if (!config) {
      this.logger.info("Tuya plugin not configured (host, device_id and local_key are required)");
      return;
    }
    this.sourceId = config.deviceId;
    this.session = new DeviceSession({
      integrationId: INTEGRATION_ID,
      sourceId: config.deviceId,
      host: config.host,
      pollIntervalS: config.pollIntervalS,
      transport: this.createTransport(config),
      profile: depowV2,
      deviceManager: this.deps.deviceManager,
      logger: this.logger,
      secret: config.localKey,
    });
    this.session.start();
    this.logger.info(
      { host: config.host, protocolVersion: config.protocolVersion, profile: depowV2.id },
      "Tuya plugin started",
    );
  }

  async stop(): Promise<void> {
    this.stopSession();
    this.configError = false;
    this.stopped = true;
    this.logger.info("Tuya plugin stopped");
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    if (!this.session || device.sourceDeviceId !== this.sourceId) {
      throw new Error(`Unknown Tuya device ${device.sourceDeviceId}`);
    }
    await this.session.executeOrder(orderKey, value);
  }

  private idleStatus(): IntegrationStatus {
    return this.isConfigured() ? "disconnected" : "not_configured";
  }

  private stopSession(): void {
    this.session?.stop();
    this.session = null;
    this.sourceId = null;
  }
}

export function createPlugin(
  deps: PluginDeps,
  createTransport: TransportFactory = defaultTransport,
): IntegrationPlugin {
  return new TuyaPlugin(deps, createTransport);
}
