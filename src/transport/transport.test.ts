import { describe, expect, it } from "vitest";
import { classifyError, describeError } from "./transport.js";

function sockErr(code: string): Error {
  return Object.assign(new Error(`connect ${code} 192.168.1.50:6668`), { code });
}

describe("classifyError", () => {
  it("reads ECONNREFUSED as refused", () => {
    expect(classifyError(sockErr("ECONNREFUSED"))).toBe("refused");
    expect(classifyError(new Error("Error from socket: connect ECONNREFUSED 1.2.3.4:6668"))).toBe(
      "refused",
    );
  });

  it.each([sockErr("ETIMEDOUT"), sockErr("EHOSTUNREACH"), new Error("connection timed out")])(
    "reads %s as unreachable",
    (err) => {
      expect(classifyError(err)).toBe("unreachable");
    },
  );

  it.each([
    new Error("Decrypt failed"),
    new Error("HMAC mismatch(keys): expected aa, was bb. 0000"),
    new Error("Unsupported state or unable to authenticate data"),
    new SyntaxError("Unexpected token in JSON at position 0"),
  ])("reads %s as undecryptable", (err) => {
    expect(classifyError(err)).toBe("undecryptable");
  });

  it("reads a response timeout as timeout", () => {
    expect(classifyError(new Error("Timeout waiting for status response from device id: x"))).toBe(
      "timeout",
    );
  });

  it("reads anything else as other", () => {
    expect(classifyError(new Error("boom"))).toBe("other");
    expect(classifyError(undefined)).toBe("other");
  });
});

describe("describeError", () => {
  it("truncates long messages", () => {
    expect(describeError(new Error("x".repeat(500))).length).toBeLessThanOrEqual(161);
  });

  it("strips a secret if one ever appears", () => {
    expect(describeError(new Error("key=TEST_ONLY_SENTINEL failed"), "TEST_ONLY_SENTINEL")).toBe(
      "key=<redacted> failed",
    );
  });
});
