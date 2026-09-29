/**
 * The transport boundary (spec 001, architecture "Transport contract").
 *
 * The session talks to this interface only; `tuyapi-transport.ts` is the one
 * file that imports `tuyapi`, and tests use `FakeTransport`.
 */

import type { Dps } from "../profiles/profile.js";

export type TransportErrorKind = "unreachable" | "refused" | "undecryptable" | "timeout" | "other";

export interface TuyaTransport {
  /** Resolves once the session with the device is negotiated. */
  connect(): Promise<void>;
  disconnect(): void;
  /** Full DP snapshot. */
  getAll(): Promise<Dps>;
  set(dps: Dps): Promise<void>;
  onDps(cb: (dps: Dps) => void): void;
  onDisconnected(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
}

export interface TransportOptions {
  host: string;
  deviceId: string;
  localKey: string;
  protocolVersion: string;
}

const MESSAGE_MAX = 160;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "";
}

function codeOf(err: unknown): string {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

/**
 * Classify a transport failure from the shapes `tuyapi` and Node sockets
 * produce. Pure, so it is tested without a socket.
 */
export function classifyError(err: unknown): TransportErrorKind {
  const code = codeOf(err);
  const message = messageOf(err);
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(message)) return "refused";
  if (
    ["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN"].includes(code) ||
    /ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|connection timed out/i.test(message)
  ) {
    return "unreachable";
  }
  if (
    /Decrypt failed|HMAC mismatch|unable to authenticate data|Incorrect key|Unexpected token|JSON/i.test(
      message,
    )
  ) {
    return "undecryptable";
  }
  if (/timeout|timed out/i.test(message)) return "timeout";
  return "other";
}

/**
 * A short, log-safe description of a failure. `tuyapi` messages can carry a
 * whole packet in hex; the key itself never appears in them, but a line
 * stays short and a caller may pass the key to strip, as a belt and braces.
 */
export function describeError(err: unknown, secret?: string): string {
  let message = messageOf(err) || codeOf(err) || "unknown error";
  if (secret) message = message.split(secret).join("<redacted>");
  return message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX)}…` : message;
}
