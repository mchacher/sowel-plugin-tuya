/**
 * One Tuya device: connection, queue, DP cache, poll, reconnect, online/offline,
 * profile match, publishing and verified writes (spec 001, architecture "Session").
 *
 * The session knows no product: every DP id lives in the profile. Nothing here
 * throws out of a timer or an event handler; `executeOrder` is the only method
 * that rejects, because its caller needs the error.
 */

import type { Dps, EnergyState, ProductProfile } from "../profiles/profile.js";
import type { DeviceManager, Logger } from "../sowel-api.js";
import {
  classifyError,
  describeError,
  type TransportErrorKind,
  type TuyaTransport,
} from "../transport/transport.js";
import { withTimeout } from "../util/timeout.js";
import { Backoff } from "./backoff.js";

export type SessionHealth =
  "connecting" | "online" | "offline" | "undecryptable" | "mismatch" | "stopped";

export interface SessionOptions {
  integrationId: string;
  sourceId: string;
  host: string;
  pollIntervalS: number;
  transport: TuyaTransport;
  profile: ProductProfile;
  deviceManager: DeviceManager;
  logger: Logger;
  /** Stripped from any error text before it is logged or returned. */
  secret: string;
}

const OFFLINE_AFTER_MS = 60_000;
const FAILED_POLLS_OFFLINE = 2;
const VERIFY_ATTEMPTS = 8;
const VERIFY_DELAY_MS = 1_000;
/**
 * Guard on every queued operation. The transport bounds its own calls; this is
 * the second belt, so a transport that never settles cannot wedge the queue.
 */
const QUEUE_OP_TIMEOUT_MS = 20_000;
/** Full reads that must agree before a device is refused (a read can omit DPs). */
const MISMATCH_READS = 2;

const HINTS: Record<TransportErrorKind, string> = {
  refused:
    "Connection refused: another client holds the device's single local connection (the Smart Life app on this network, or another integration)",
  unreachable:
    "Device unreachable: check it is powered and that its IP has not changed (a DHCP reservation keeps it stable)",
  undecryptable:
    "Cannot decrypt the device's replies: wrong local_key, or the device was re-paired and its key changed",
  timeout:
    "Device accepted the connection but did not answer in time: check the local_key and protocol version, or the device is busy",
  other: "Device communication failed",
};

function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === undefined || actual === null) return false;
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DeviceSession {
  private readonly log: Logger;
  private readonly backoff = new Backoff();

  private cache: Dps = {};
  private published: Record<string, unknown> = {};
  private energyState: EnergyState | null = null;
  private discovered = false;
  private connected = false;
  private online = false;
  private stopped = false;
  private mismatch = false;
  private sawUndecryptable = false;
  /** Failure kinds already logged since the last successful read: one line each. */
  private readonly loggedFailures = new Set<TransportErrorKind>();
  private mismatchReads = 0;
  private failedPolls = 0;
  private statusSent: "online" | "offline" | null = null;
  private readonly loggedUnknown = new Set<string>();

  private chain: Promise<unknown> = Promise.resolve();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SessionOptions) {
    this.log = opts.logger.child({ sourceId: opts.sourceId, profile: opts.profile.id });
    opts.transport.onDps((dps) => this.onPush(dps));
    opts.transport.onDisconnected(() => this.onDisconnected());
    opts.transport.onError((err) => this.onTransportError(err));
  }

  health(): SessionHealth {
    if (this.stopped) return "stopped";
    if (this.mismatch) return "mismatch";
    if (this.online) return "online";
    if (this.sawUndecryptable) return "undecryptable";
    return this.discovered ? "offline" : "connecting";
  }

  start(): void {
    this.armOfflineTimer();
    void this.attempt();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.online = false;
    this.clearTimers();
    try {
      this.opts.transport.disconnect();
    } catch (err) {
      this.log.debug({ error: this.describe(err) }, "Disconnect failed");
    }
  }

  /** Write an order and wait until the device reflects it (spec 001 FR-16). */
  async executeOrder(orderKey: string, value: unknown): Promise<void> {
    if (!this.online) throw new Error(`Device ${this.opts.sourceId} is offline`);
    const encoded = this.opts.profile.encode(orderKey, value, this.cache);
    if (!encoded.ok) throw new Error(encoded.reason);

    try {
      await this.enqueue(() => this.opts.transport.set(encoded.write));
    } catch (err) {
      // The cause is dropped on purpose: the core logs what it gets, and only
      // the sanitised description may leave the plugin (spec 001 FR-2).
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Write failed: ${this.describe(err)}`);
    }

    // Pushes update the cache too, so it is checked whether or not a read-back
    // succeeds: the device often reports the new value on its own first.
    const { confirm } = encoded;
    const reflected = (): boolean =>
      confirm
        ? confirm(this.cache)
        : Object.entries(encoded.write).every(([dp, v]) => sameValue(this.cache[dp], v));
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
      await sleep(VERIFY_DELAY_MS);
      if (this.stopped) throw new Error(`Order ${orderKey} interrupted: plugin stopped`);
      if (!reflected()) {
        try {
          await this.enqueue(() => this.readAll());
        } catch (err) {
          this.log.debug({ attempt, error: this.describe(err) }, "Read-back failed");
        }
      }
      if (reflected()) {
        this.log.info({ orderKey, value, attempt }, "Order applied");
        return;
      }
    }
    const why = this.opts.profile.whyNotReflected?.(orderKey, value, this.cache) ?? null;
    this.log.warn({ orderKey, value, why }, "Order not reflected by the device");
    throw new Error(
      why
        ? `Order ${orderKey} not reflected: ${why}`
        : `Order ${orderKey} not reflected after ${VERIFY_ATTEMPTS} s`,
    );
  }

  // ── Connection ─────────────────────────────────────────────────────

  private async attempt(): Promise<void> {
    this.reconnectTimer = null;
    if (this.stopped || this.mismatch) return;
    try {
      await withTimeout(
        this.opts.transport.connect(),
        QUEUE_OP_TIMEOUT_MS,
        "Timeout: connection did not settle",
      );
      if (this.stopped) return;
      this.connected = true;
      await this.enqueue(() => this.readAll());
      // A first read that did not match is confirmed by a second one before
      // the device is refused: a full read can omit DPs.
      while (!this.discovered && !this.mismatch && !this.stopped) {
        await this.enqueue(() => this.readAll());
      }
      if (this.stopped || this.mismatch) return;
      this.backoff.reset();
      this.failedPolls = 0;
      this.schedulePoll();
    } catch (err) {
      this.connected = false;
      this.noteFailure(err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.mismatch || this.reconnectTimer) return;
    const delay = this.backoff.next();
    this.log.debug({ delayMs: delay }, "Reconnect scheduled");
    this.reconnectTimer = setTimeout(() => void this.attempt(), delay);
  }

  private onDisconnected(): void {
    if (this.stopped || !this.connected) return;
    this.connected = false;
    this.log.debug("Connection closed by the device");
    this.clearPoll();
    this.armOfflineTimer();
    this.scheduleReconnect();
  }

  private onTransportError(err: unknown): void {
    if (this.stopped) return;
    try {
      this.noteFailure(err);
    } catch (e) {
      this.log.error({ error: this.describe(e) }, "Transport error handling failed");
    }
  }

  private noteFailure(err: unknown): void {
    const kind = classifyError(err);
    if (kind === "undecryptable") this.sawUndecryptable = true;
    if (this.loggedFailures.has(kind)) return;
    this.loggedFailures.add(kind);
    const context = { kind, host: this.opts.host, error: this.describe(err) };
    if (kind === "undecryptable") this.log.error(context, HINTS[kind]);
    else this.log.warn(context, HINTS[kind]);
  }

  // ── Poll ───────────────────────────────────────────────────────────

  private schedulePoll(): void {
    this.clearPoll();
    if (this.stopped || this.mismatch) return;
    this.pollTimer = setTimeout(() => void this.poll(), this.opts.pollIntervalS * 1000);
  }

  private async poll(): Promise<void> {
    this.pollTimer = null;
    if (this.stopped || !this.connected) return;
    try {
      await this.enqueue(() => this.readAll());
      this.failedPolls = 0;
    } catch (err) {
      this.failedPolls++;
      this.noteFailure(err);
      if (this.failedPolls >= FAILED_POLLS_OFFLINE) {
        this.setOffline();
        this.connected = false;
        try {
          this.opts.transport.disconnect();
        } catch {
          // already gone
        }
        this.scheduleReconnect();
        return;
      }
    }
    this.schedulePoll();
  }

  // ── Snapshots and publishing ───────────────────────────────────────

  private async readAll(): Promise<void> {
    const dps = await this.opts.transport.getAll();
    if (this.stopped) return;
    this.handleSnapshot(dps);
  }

  private onPush(dps: Dps): void {
    if (this.stopped || !this.discovered) return;
    try {
      this.handleSnapshot(dps);
    } catch (err) {
      // Through describe(), like every error that leaves the plugin (FR-2).
      this.log.error({ error: this.describe(err) }, "Failed to handle a pushed update");
    }
  }

  private handleSnapshot(dps: Dps): void {
    const liveChanged = (this.opts.profile.liveDps ?? []).some(
      (dp) => dp in dps && dps[dp] !== this.cache[dp],
    );
    this.cache = { ...this.cache, ...dps };
    const { profile, deviceManager, integrationId, sourceId } = this.opts;

    if (!this.discovered) {
      if (!profile.match(this.cache)) {
        this.mismatchReads++;
        if (this.mismatchReads < MISMATCH_READS) {
          this.log.debug("First read does not match the profile, reading again");
          return;
        }
        this.mismatch = true;
        this.clearTimers();
        this.log.error(
          {
            required: profile.requiredDps,
            reported: Object.entries(this.cache).map(([id, v]) => `${id}:${typeof v}`),
          },
          "Device does not match the profile: not published. Open an issue with the reported DP ids",
        );
        try {
          this.opts.transport.disconnect();
        } catch {
          // nothing to release
        }
        return;
      }
      deviceManager.upsertFromDiscovery(
        integrationId,
        integrationId,
        profile.discovery(sourceId, this.cache),
      );
      this.discovered = true;
    }

    this.sawUndecryptable = false;
    this.loggedFailures.clear();
    this.setOnline();

    for (const value of profile.unknownValues?.(this.cache) ?? []) {
      if (this.loggedUnknown.has(value)) continue;
      this.loggedUnknown.add(value);
      this.log.warn({ value }, "Unmapped value reported by the device");
    }

    const decoded = profile.decode(this.cache);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(decoded)) {
      if (!(key in this.published) || this.published[key] !== value) payload[key] = value;
    }
    // A new measurement from the device refreshes the live keys, unchanged or
    // not. A full read returning the same stale measurement refreshes nothing,
    // unless the values are known from the state (0 W when not charging).
    if (liveChanged || profile.liveIsDerived?.(this.cache)) {
      for (const key of profile.liveKeys ?? []) {
        if (key in decoded) payload[key] = decoded[key];
      }
    }
    this.published = { ...this.published, ...decoded };

    // Energy increments bypass the diff: two equal increments are two amounts (FR-20).
    const step = profile.energyStep?.(this.energyState, this.cache);
    if (step) {
      this.energyState = step.next;
      if (step.deltaWh > 0) payload.energy = step.deltaWh;
    }

    if (Object.keys(payload).length > 0) {
      deviceManager.updateDeviceData(integrationId, sourceId, payload);
    }
  }

  // ── Online / offline ───────────────────────────────────────────────

  private setOnline(): void {
    this.clearOfflineTimer();
    if (this.online) return;
    this.online = true;
    this.sendStatus("online");
    this.log.info({ host: this.opts.host }, "Device online");
  }

  private setOffline(): void {
    this.clearOfflineTimer();
    const wasOnline = this.online;
    this.online = false;
    this.sendStatus("offline");
    if (wasOnline) this.log.warn({ host: this.opts.host }, "Device offline");
  }

  /** Transitions only. Also sent before discovery: the core ignores an unknown source id. */
  private sendStatus(status: "online" | "offline"): void {
    if (this.statusSent === status) return;
    this.statusSent = status;
    this.opts.deviceManager.updateDeviceStatus(this.opts.integrationId, this.opts.sourceId, status);
  }

  private armOfflineTimer(): void {
    if (this.offlineTimer || this.stopped) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (!this.stopped && !this.mismatch) this.setOffline();
    }, OFFLINE_AFTER_MS);
  }

  // ── Plumbing ───────────────────────────────────────────────────────

  /** Serialise every transport operation (FR-4). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = (): Promise<T> =>
      this.stopped
        ? Promise.reject(new Error("Session stopped"))
        : withTimeout(fn(), QUEUE_OP_TIMEOUT_MS, "Timeout: transport operation did not settle");
    const run = this.chain.then(guarded, guarded);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private describe(err: unknown): string {
    return describeError(err, this.opts.secret);
  }

  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private clearOfflineTimer(): void {
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
  }

  private clearTimers(): void {
    this.clearPoll();
    this.clearOfflineTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
