import { describe, expect, it } from "vitest";
import { asksToRerun, extractMentionTokens, normalizeMentionToken } from "./mentions.js";

describe("extractMentionTokens", () => {
  it("extracts every @token in order, duplicates included", () => {
    expect(extractMentionTokens("hey @user, can @system-agent take a look? @user?")).toEqual([
      "user",
      "system-agent",
      "user",
    ]);
  });

  it("returns an empty array when there are no mentions", () => {
    expect(extractMentionTokens("no mentions here")).toEqual([]);
  });

  it("does not match an email address as a mention", () => {
    expect(extractMentionTokens("contact me at foo@example.com")).toEqual(["example"]);
  });
});

describe("normalizeMentionToken", () => {
  it("lowercases and strips punctuation so different spellings compare equal", () => {
    expect(normalizeMentionToken("system-agent")).toBe("systemagent");
    expect(normalizeMentionToken("System_Agent")).toBe("systemagent");
    expect(normalizeMentionToken("System Agent")).toBe("systemagent");
  });
});

describe("asksToRerun", () => {
  it("reads the bare request the reported session used", () => {
    // rockarxiv/Engineering-Orchestrator#142, verbatim.
    expect(asksToRerun("@reviewer rerun")).toBe(true);
  });

  it("reads it through politeness and scaffolding", () => {
    expect(asksToRerun("@reviewer please rerun")).toBe(true);
    expect(asksToRerun("@reviewer can you re-run this step?")).toBe(true);
    expect(asksToRerun("@reviewer run it again")).toBe(true);
    expect(asksToRerun("@reviewer try again please")).toBe(true);
    expect(asksToRerun("@reviewer retry this")).toBe(true);
  });

  it("does not read a sentence that merely mentions rerunning as a request to rerun", () => {
    // The direction it has to be wrong in: handing the step back starts
    // a real run, so anything carrying its own question stays a reply.
    expect(asksToRerun("@reviewer why did the rerun fail?")).toBe(false);
    expect(asksToRerun("@reviewer rerun the tests and tell me what broke")).toBe(false);
    expect(asksToRerun("@reviewer should we restart the release?")).toBe(false);
    expect(asksToRerun("@reviewer looks good to me")).toBe(false);
  });

  it("does not count the agent's own name as content", () => {
    // An agent called "rerun-bot" would otherwise be asking for a rerun
    // every time somebody said hello to it.
    expect(asksToRerun("@rerun-bot hello")).toBe(false);
    expect(asksToRerun("@rerun-bot rerun")).toBe(true);
  });

  it("is not a request when there are no words at all", () => {
    expect(asksToRerun("@reviewer")).toBe(false);
    expect(asksToRerun("")).toBe(false);
  });
});
