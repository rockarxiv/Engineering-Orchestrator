import { describe, expect, it } from "vitest";
import { activeMentionQuery, extractMentions } from "./composer";

describe("the composer's mention handling", () => {
  it("detects the token being typed at the caret", () => {
    expect(activeMentionQuery("hello @rev", 10)).toBe("rev");
    expect(activeMentionQuery("hello @", 7)).toBe("");
    expect(activeMentionQuery("hello there", 11)).toBeNull();
    expect(activeMentionQuery("@user said hi", 13)).toBeNull(); // caret has moved past it
  });

  it("sends only mentions that name something real", () => {
    expect(extractMentions("@user and @implementer and @nobody", ["user", "implementer"])).toEqual(["user", "implementer"]);
  });

  it("does not repeat a name mentioned twice", () => {
    expect(extractMentions("@user @user", ["user"])).toEqual(["user"]);
  });
});
