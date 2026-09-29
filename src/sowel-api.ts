/**
 * The slice of Sowel's plugin API this plugin uses.
 *
 * Plugins do not import from the Sowel source tree: the contract is the shape
 * below, kept in sync by hand with `src/shared/plugin-api.ts` and
 * `src/integrations/integration-registry.ts` in mchacher/sowel. Extend it
 * when a new method is needed; never widen a type to make something compile.
 */

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
}

export interface EventBus {
  emit(event: unknown): void;
}

export interface SettingsManager {
  get(key: string): string | undefined;
}

export type DataType = "number" | "boolean" | "string" | "enum";

export type PowerSource = "battery" | "mains" | "dc" | "unknown";

export interface DiscoveredData {
  key: string;
  type: DataType;
  category: string;
  unit?: string;
  enumValues?: string[];
  /** Wire literals of a boolean reading, when the integration knows them. */
  valueOn?: string | number | boolean;
  valueOff?: string | number | boolean;
}

export interface DiscoveredOrder {
  key: string;
  type: DataType;
  category?: string;
  min?: number;
  max?: number;
  unit?: string;
  enumValues?: string[];
  valueOn?: string | number | boolean;
  valueOff?: string | number | boolean;
}

/** What `upsertFromDiscovery` takes. Mirrors `DiscoveredDevice` in the core. */
export interface DiscoveredDevice {
  friendlyName: string;
  ieeeAddress?: string;
  manufacturer?: string;
  model?: string;
  powerSource?: PowerSource;
  data: DiscoveredData[];
  orders: DiscoveredOrder[];
  rawExpose?: unknown;
}

export type DeviceStatus = "online" | "offline" | "unknown";

export interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: DiscoveredDevice): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
    sourceTimestamp?: number,
  ): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: DeviceStatus): void;
  removeStaleDevices(integrationId: string, activeIds: Set<string>): void;
  logSummary(): void;
}

export interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

export interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  /** Absolute path to this plugin's directory. */
  pluginDir: string;
}

export type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

export interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

export interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(device: Device, orderKey: string, value: unknown): Promise<void>;
  refresh?(): Promise<void>;
}
