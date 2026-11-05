import { describe, expect, it, vi } from "vitest";
import { bridgePushChannels, emitPush, type PushTransport } from "./push.js";

function createFakeTransport(): { transport: PushTransport; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return { transport: { send }, send };
}

describe("push", () => {
  it("forwards emitPush payloads to a bridged transport on the wire channel", () => {
    const { transport, send } = createFakeTransport();
    const dispose = bridgePushChannels(transport);

    emitPush("runs:changed", { runId: "run-1", itemId: "item-1", status: "running" });

    expect(send).toHaveBeenCalledWith("push:runs:changed", { runId: "run-1", itemId: "item-1", status: "running" });
    dispose();
  });

  it("stops forwarding after dispose", () => {
    const { transport, send } = createFakeTransport();
    const dispose = bridgePushChannels(transport);
    dispose();

    emitPush("runs:changed", { runId: "run-1", itemId: "item-1", status: "running" });

    expect(send).not.toHaveBeenCalled();
  });

  it("fans one push out to every bridged transport", () => {
    // What a second window is, now that a transport rather than a window
    // is what gets bridged (KAN-127): the same push reaches both, and
    // disposing one leaves the other listening.
    const first = createFakeTransport();
    const second = createFakeTransport();
    const disposeFirst = bridgePushChannels(first.transport);
    const disposeSecond = bridgePushChannels(second.transport);

    emitPush("runs:changed", { runId: "run-1", itemId: "item-1", status: "running" });
    disposeFirst();
    emitPush("runs:changed", { ...{ runId: "run-1", itemId: "item-1", status: "running" }, status: "succeeded" });
    disposeSecond();

    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(2);
  });

  it("rejects a payload that fails its own schema", () => {
    expect(() => emitPush("runs:changed", { runId: "run-1", itemId: "item-1", status: 1 as unknown as string })).toThrow();
  });
});
