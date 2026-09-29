/**
 * Sowel plugin: Tuya (local)
 *
 * Talks to Tuya devices over the local network — no cloud at runtime — and
 * publishes each one as an ordinary Sowel device. What a device exposes is
 * decided by its product profile (a data-point map); the first profile is the
 * dé EV charger.
 *
 * This is the skeleton: it starts, stops and reports its status. The
 * transport and the first profile arrive with spec 001.
 */

import type {
  Device,
  IntegrationPlugin,
  IntegrationSettingDef,
  IntegrationStatus,
  Logger,
  PluginDeps,
} from "./sowel-api.js";

export const INTEGRATION_ID = "tuya";

class TuyaPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Tuya (local)";
  readonly description =
    "Tuya devices over the local network, no cloud at runtime. First supported product: the dé EV charger";
  readonly icon = "PlugZap";
  readonly apiVersion = 2;

  private readonly logger: Logger;
  private status: IntegrationStatus = "not_configured";

  constructor(private readonly deps: PluginDeps) {
    this.logger = deps.logger.child({ module: "tuya" });
  }

  getStatus(): IntegrationStatus {
    return this.status;
  }

  /** No device can be declared yet: the settings arrive with spec 001. */
  isConfigured(): boolean {
    return false;
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [];
  }

  async start(): Promise<void> {
    this.status = "not_configured";
    this.logger.info({ pluginDir: this.deps.pluginDir }, "Tuya plugin started (no device yet)");
  }

  async stop(): Promise<void> {
    this.status = "disconnected";
    this.logger.info("Tuya plugin stopped");
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    this.logger.debug(
      { deviceId: device.id, orderKey, value },
      "Order received (no transport yet, ignored)",
    );
  }
}

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new TuyaPlugin(deps);
}
