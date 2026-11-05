import { describe, expect, it } from "vitest";
import { CommentOptionSchema, actionOptions, answerOptions, parseStoredCommentOptions, type CommentOption } from "./commentOptions.js";

/** A comment's options (EO-533): answers stay strings; an action opens something. */

const FIX: CommentOption = { kind: "open", label: "Fix with assistant", opens: { type: "updateConflictChat", conflictId: "c-1" } };

describe("comment options", () => {
  it("takes an answer as a plain string and an action as an object naming what it opens", () => {
    expect(CommentOptionSchema.parse("Yes")).toBe("Yes");
    expect(CommentOptionSchema.parse(FIX)).toEqual(FIX);
    expect(CommentOptionSchema.safeParse({ kind: "open", label: "Go", opens: { type: "somewhereUnknown" } }).success).toBe(false);
  });

  it("splits answers from actions", () => {
    expect(answerOptions(["Yes", FIX, "No"])).toEqual(["Yes", "No"]);
    expect(actionOptions(["Yes", FIX, "No"])).toEqual([FIX]);
    expect(answerOptions(null)).toEqual([]);
    expect(actionOptions(undefined)).toEqual([]);
  });

  it("reads a stored column without trusting it: old strings kept, unknown entries dropped", () => {
    expect(parseStoredCommentOptions(null)).toBeNull();
    expect(parseStoredCommentOptions(["Yes", FIX, { kind: "open", label: "x", opens: { type: "later" } }, 7])).toEqual(["Yes", FIX]);
  });
});
