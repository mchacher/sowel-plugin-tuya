/**
 * `tuyapi` adapter — the only file that imports the library (spec 001).
 *
 * Three behaviours of tuyapi 7.7 shape this file:
 * - `get`, `set` and `connect` can wait forever (no reply, a socket closed
 *   mid-negotiation, a wrong key on 3.5), so every call is bounded here;
 * - a stuck `connect` is cached and returned to the next caller, and
 *   `disconnect()` is a no-op until the negotiation succeeded, so a failed
 *   instance cannot be reused: each `connect` starts from a fresh one;
 * - `_send` reconnects on its own, so a retired instance is neutralised —
 *   its socket destroyed and its `connect` made to fail — or it would
 *   silently take back the device's single local slot.
 *
 * Exercised by the hardware walk rather than unit tests: what it decides
 * (error classification) lives in `transport.ts` and is tested there.
 */

import TuyAPI from "tuyapi";
import type { Dps } from "../profiles/profile.js";
import { withTimeout } from "../util/timeout.js";
import type { TransportOptions, TuyaTransport } from "./transport.js";

const CONNECT_TIMEOUT_MS = 10_000;
/**
 * Command bytes of a full status reply: DP_QUERY_NEW (3.4, 3.5) and DP_QUERY
 * (3.3). Matched on the `data` event rather than through `get()`'s promise,
 * because on 3.5 tuyapi stops resolving `get()` after a `set()` — the reply
 * arrives, its sequence number no longer matches the resolver (seen on the dé
 * charger, firmware 1.9.13) — and `get()` can also resolve with an unrelated
 * partial push.
 */
const STATUS_REPLY_COMMANDS = new Set([10, 16]);
const REQUEST_TIMEOUT_MS = 8_000;

function dpsOf(payload: unknown): Dps | null {
  if (payload !== null && typeof payload === "object" && "dps" in payload) {
    const dps = (payload as { dps: unknown }).dps;
    if (dps !== null && typeof dps === "object") return dps as Dps;
  }
  return null;
}

/** The tuyapi internals a retired instance must have released. */
interface TuyAPIInternals {
  client?: { destroy(): void };
  connect: () => Promise<boolean>;
  removeAllListeners(): void;
  on(event: "error", listener: () => void): void;
}

export class TuyapiTransport implements TuyaTransport {
  private device: TuyAPI | null = null;
  private readonly dpsListeners: ((dps: Dps) => void)[] = [];
  private readonly disconnectedListeners: (() => void)[] = [];
  private readonly errorListeners: ((err: unknown) => void)[] = [];

  constructor(private readonly options: TransportOptions) {}

  async connect(): Promise<void> {
    this.retire();
    const device = new TuyAPI({
      id: this.options.deviceId,
      key: this.options.localKey,
      ip: this.options.host,
      version: this.options.protocolVersion,
      issueGetOnConnect: false,
    });
    this.device = device;
    const current = () => this.device === device;
    // An EventEmitter without an `error` listener throws: this one must exist
    // before anything else can fail.
    device.on("error", (err) => {
      if (current()) this.errorListeners.forEach((cb) => cb(err));
    });
    device.on("disconnected", () => {
      if (current()) this.disconnectedListeners.forEach((cb) => cb());
    });
    // `data` also carries the reply to our own `get`: the session then sees a
    // poll twice, which is harmless (no diff, no energy delta the second time).
    const forward = (payload: unknown): void => {
      const dps = dpsOf(payload);
      if (dps && current()) this.dpsListeners.forEach((cb) => cb(dps));
    };
    device.on("data", forward);
    device.on("dp-refresh", forward);

    try {
      await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, "Session negotiation timed out");
    } catch (err) {
      if (current()) this.retire();
      throw err;
    }
  }

  disconnect(): void {
    this.retire();
  }

  async getAll(): Promise<Dps> {
    const device = this.connected();
    let listener: ((payload: unknown, commandByte: number) => void) | undefined;
    const reply = new Promise<Dps>((resolve) => {
      listener = (payload, commandByte) => {
        const dps = dpsOf(payload);
        if (dps && STATUS_REPLY_COMMANDS.has(commandByte)) resolve(dps);
      };
      device.on("data", listener);
    });
    // The request; its own promise is not trusted (see STATUS_REPLY_COMMANDS).
    device.get({ schema: true }).catch(() => undefined);
    try {
      return await withTimeout(reply, REQUEST_TIMEOUT_MS, "Timeout waiting for the status reply");
    } finally {
      if (listener) device.removeListener("data", listener);
    }
  }

  async set(dps: Dps): Promise<void> {
    const device = this.connected();
    await withTimeout(
      device.set({ multiple: true, data: dps as Record<string, string | number | boolean> }),
      REQUEST_TIMEOUT_MS,
      "Timeout waiting for the write acknowledgement",
    );
  }

  onDps(cb: (dps: Dps) => void): void {
    this.dpsListeners.push(cb);
  }

  onDisconnected(cb: () => void): void {
    this.disconnectedListeners.push(cb);
  }

  onError(cb: (err: unknown) => void): void {
    this.errorListeners.push(cb);
  }

  private connected(): TuyAPI {
    if (!this.device || !this.device.isConnected()) throw new Error("Not connected");
    return this.device;
  }

  /** Release the current instance for good: no socket, no timer, no auto-reconnect. */
  private retire(): void {
    const device = this.device;
    if (!device) return;
    this.device = null;
    const internals = device as unknown as TuyAPIInternals;
    internals.connect = () => Promise.reject(new Error("Transport retired"));
    try {
      device.disconnect();
    } catch {
      // not connected: nothing to close through the API
    }
    try {
      internals.client?.destroy();
    } catch {
      // already destroyed
    }
    internals.removeAllListeners();
    internals.on("error", () => undefined);
  }
}
