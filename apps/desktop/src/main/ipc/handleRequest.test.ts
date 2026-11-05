import { describe, expect, it } from "vitest";
import { handleIpcRequest } from "./handleRequest.js";

describe("handleIpcRequest", () => {
  it("round-trips a valid request", async () => {
    const result = await handleIpcRequest("app:getVersion", undefined, () => ({ version: "1.2.3" }), {
      exposeErrorDetails: true,
    });

    expect(result).toEqual({ ok: true, data: { version: "1.2.3" } });
  });

  it("rejects an invalid payload with a structured error instead of throwing", async () => {
    const result = await handleIpcRequest("app:getVersion", { garbage: true }, () => ({ version: "1.2.3" }), {
      exposeErrorDetails: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues?.length).toBeGreaterThan(0);
    }
  });

  it("catches a throwing handler and returns an error envelope", async () => {
    const result = await handleIpcRequest(
      "app:getVersion",
      undefined,
      () => {
        throw new Error("boom");
      },
      { exposeErrorDetails: true },
    );

    expect(result).toEqual({ ok: false, error: { message: "Error: boom" } });
  });

  it("does not leak error details when exposeErrorDetails is false", async () => {
    const result = await handleIpcRequest(
      "app:getVersion",
      undefined,
      () => {
        throw new Error("secret stack trace detail");
      },
      { exposeErrorDetails: false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain("secret stack trace detail");
      expect(result.error.message).toBe("Internal error");
    }
  });
});
