import { describe, expect, it } from "vitest";
import { liveMessageOf } from "./live-output.js";

describe("what the chat shows while an agent is still writing", () => {
  it("reads the message out of a finished result, through the outcome wrapper", () => {
    // The bug this exists to close: the reader looked for a top-level
    // `message`, and every constrained result nests one level down — so
    // the person watching saw the whole JSON object on screen.
    const raw = '{"outcome":{"message":"I\'ll first trace how discussions are stored.","questions":[],"proposals":[]}}';

    expect(liveMessageOf([raw])).toBe("I'll first trace how discussions are stored.");
  });

  it("reads it from an unwrapped result too", () => {
    expect(liveMessageOf(['{"message":"Already unwrapped.","proposals":[]}'])).toBe("Already unwrapped.");
  });

  it("glues the chunks before reading, since no single chunk is JSON", () => {
    const chunks = ['{"outcome":{"mess', 'age":"Tracing the sched', 'uler now.","questions":[]}}'];

    expect(liveMessageOf(chunks)).toBe("Tracing the scheduler now.");
  });

  it("shows as much of the message as has arrived", () => {
    expect(liveMessageOf(['{"outcome":{"message":"Tracing the sched'])).toBe("Tracing the sched");
  });

  it("shows nothing while only the wrapper has arrived", () => {
    // Braces are not a status update. Better an empty line than a
    // half-written object presented as though the agent said it.
    for (const partial of ['{', '{"outcome":', '{"outcome":{"mess']) {
      expect(liveMessageOf([partial]), partial).toBe("");
    }
  });

  it("decodes escapes, and waits for one that is still arriving", () => {
    expect(liveMessageOf(['{"outcome":{"message":"Two things.\\n\\nFirst, the \\"limiter\\"'])).toBe('Two things.\n\nFirst, the "limiter"');
    // A lone backslash is the first half of an escape whose second half
    // is in the next chunk; it is dropped rather than shown raw.
    expect(liveMessageOf(['{"outcome":{"message":"Almost\\'])).toBe("Almost");
    expect(liveMessageOf(['{"outcome":{"message":"Half an escape \\u00'])).toBe("Half an escape ");
  });

  it("keeps a quote inside the message from ending it early", () => {
    expect(liveMessageOf(['{"outcome":{"message":"It is \\"per key\\" today.","questions":[]}}'])).toBe('It is "per key" today.');
  });

  it("reads through a fence, closed or not", () => {
    expect(liveMessageOf(['```json\n{"outcome":{"message":"Fenced."}}\n```'])).toBe("Fenced.");
    expect(liveMessageOf(['```json\n{"outcome":{"message":"Still fenc'])).toBe("Still fenc");
  });

  it("shows plain prose as written, for a provider with no structured output", () => {
    expect(liveMessageOf(["Looking at the limiter", "and its tests."])).toBe("Looking at the limiter\n\nand its tests.");
  });

  it("shows nothing for a result that carries no message at all", () => {
    // A clarification, or any shape this does not know. Not something to
    // put on screen half-read.
    expect(liveMessageOf(['{"outcome":{"status":"clarification_required","questions":[]}}'])).toBe("");
  });

  it("says nothing when nothing has been said", () => {
    expect(liveMessageOf([])).toBe("");
  });
});
