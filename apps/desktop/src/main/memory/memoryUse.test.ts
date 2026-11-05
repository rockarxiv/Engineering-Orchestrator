import { MEMORY_USED_EVENT } from "@eo/core";
import { describe, expect, it } from "vitest";
import { heldToDelivered } from "./memoryUse.js";

/**
 * An answer's `memoryUsed`, held to what the run was given (EO-597).
 */
describe("what a run says it relied on", () => {
  const delivered = new Set(["m-1", "m-2"]);

  it("keeps the ids the run was given and records the rest as dropped", () => {
    const held = heldToDelivered({ verdict: "approve", feedback: "ok", memoryUsed: ["m-2", "m-9", "m-1"] }, delivered);
    expect(held.answer).toEqual({ verdict: "approve", feedback: "ok", memoryUsed: ["m-2", "m-1"] });
    expect(held.event).toEqual({ type: MEMORY_USED_EVENT, entryIds: ["m-2", "m-1"], droppedIds: ["m-9"] });
  });

  it("drops every id from a run that was given nothing", () => {
    const held = heldToDelivered({ summary: "s", memoryUsed: ["m-1"] }, new Set());
    expect(held.answer).toEqual({ summary: "s", memoryUsed: [] });
    expect(held.event).toEqual({ type: MEMORY_USED_EVENT, entryIds: [], droppedIds: ["m-1"] });
  });

  it("counts an id named twice once", () => {
    expect(heldToDelivered({ memoryUsed: ["m-1", "m-1"] }, delivered).event).toEqual({ type: MEMORY_USED_EVENT, entryIds: ["m-1"], droppedIds: [] });
  });

  it("records an empty list as a run that used none", () => {
    expect(heldToDelivered({ memoryUsed: [] }, delivered).event).toEqual({ type: MEMORY_USED_EVENT, entryIds: [], droppedIds: [] });
  });

  it("records nothing, and changes nothing, for an answer that says nothing about memory", () => {
    const answer = { summary: "s" };
    expect(heldToDelivered(answer, delivered)).toEqual({ answer, event: null });
    expect(heldToDelivered(null, delivered)).toEqual({ answer: null, event: null });
    expect(heldToDelivered(["m-1"], delivered)).toEqual({ answer: ["m-1"], event: null });
  });
});
