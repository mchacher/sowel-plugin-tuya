/**
 * Test double for `TuyaTransport` (excluded from the build).
 *
 * Holds a device state that `getAll` returns, applies writes to it when
 * `echo` is on, and lets a test script failures, pushes and disconnections.
 */

import { vi } from "vitest";
import type { Dps } from "../profiles/profile.js";
import type { TuyaTransport } from "./transport.js";

export class FakeTransport implements TuyaTransport {
  state: Dps;
  /** Apply writes to `state` (the device reflects them). */
  echo = true;
  /** Errors thrown by the next `connect` calls, in order. */
  connectFailures: unknown[] = [];
  /** Errors thrown by the next `getAll` calls, in order. */
  getFailures: unknown[] = [];
  /** When set, `getAll` waits on it (to hold a poll in flight). */
  getGate: Promise<void> | null = null;
  readonly calls: string[] = [];

  private dpsCb: ((dps: Dps) => void) | null = null;
  private disconnectedCb: (() => void) | null = null;
  private errorCb: ((err: unknown) => void) | null = null;

  readonly connect = vi.fn(async () => {
    this.calls.push("connect");
    const failure = this.connectFailures.shift();
    if (failure !== undefined) throw failure;
  });

  readonly disconnect = vi.fn(() => {
    this.calls.push("disconnect");
  });

  readonly getAll = vi.fn(async (): Promise<Dps> => {
    this.calls.push("getAll:start");
    if (this.getGate) await this.getGate;
    this.calls.push("getAll:end");
    const failure = this.getFailures.shift();
    if (failure !== undefined) throw failure;
    return { ...this.state };
  });

  readonly set = vi.fn(async (dps: Dps) => {
    this.calls.push(`set:${JSON.stringify(dps)}`);
    if (this.echo) this.state = { ...this.state, ...dps };
  });

  constructor(state: Dps) {
    this.state = { ...state };
  }

  onDps(cb: (dps: Dps) => void): void {
    this.dpsCb = cb;
  }

  onDisconnected(cb: () => void): void {
    this.disconnectedCb = cb;
  }

  onError(cb: (err: unknown) => void): void {
    this.errorCb = cb;
  }

  push(dps: Dps): void {
    this.state = { ...this.state, ...dps };
    this.dpsCb?.(dps);
  }

  dropConnection(): void {
    this.disconnectedCb?.();
  }

  emitError(err: unknown): void {
    this.errorCb?.(err);
  }
}
