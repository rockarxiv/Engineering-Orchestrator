import { describe, expect, it } from "vitest";
import { namesAnOwner, saysWhatIsChecked, verificationLine, type StepVerification, type VerifiableStep } from "./verification.js";

/**
 * The two decisions a column head is made of (EO-312, ARCHITECTURE.md, "What 'EO checks' means on a
 * step").
 *
 * Whether the board explains itself at all, and what one head then says.
 * They are separate on purpose — the first is about the pipeline and the
 * second about one step — and the tests here are about the seams between
 * them, which the main process's own tests cannot reach: a client that
 * was told nothing, and a step nobody answered for.
 */
function entry(overrides: Partial<StepVerification> & { stepId: string }): StepVerification {
  return { checks: [], verifiesAction: false, kindVerifies: false, waitsOn: null, ...overrides };
}

const IMPLEMENT: VerifiableStep = { id: "implement", type: "agent" };
const APPROVE: VerifiableStep = { id: "approve", type: "user" };

describe("whether a board says what is checked", () => {
  it("says nothing when every step that runs stands on a workspace that vouches for something", () => {
    expect(saysWhatIsChecked([IMPLEMENT, APPROVE], [entry({ stepId: "implement", kindVerifies: true }), entry({ stepId: "approve" })])).toBe(false);
  });

  it("says something as soon as one step that runs stands on a workspace that vouches for nothing", () => {
    expect(saysWhatIsChecked([IMPLEMENT, APPROVE], [entry({ stepId: "implement" }), entry({ stepId: "approve" })])).toBe(true);
  });

  it("is never made to speak by a human step, which nothing runs on", () => {
    expect(saysWhatIsChecked([APPROVE], [entry({ stepId: "approve" })])).toBe(false);
  });

  it("stays quiet when it has not been told, rather than reading silence as 'nothing is checked'", () => {
    // What a client one release behind sends, and what a fixture that
    // predates the field holds. The absence of an answer is not an
    // answer, and a board that read it as one would tell every developer
    // their work is unverified.
    expect(saysWhatIsChecked([IMPLEMENT], [])).toBe(false);
  });
});

describe("whether a head names somebody at all (EO-323)", () => {
  it("is true of a human step naming a person or a group, whatever the board is otherwise saying", () => {
    // `saysWhatIsChecked` answers no for a developer's pipeline, and
    // rightly: every step that runs stands on a workspace EO can speak
    // for. "Support team · anyone claims" is not a claim about checking,
    // which is why it is a separate question.
    expect(namesAnOwner(APPROVE, [entry({ stepId: "approve", waitsOn: "Support team", waitsOnKind: "group" })])).toBe(true);
    expect(namesAnOwner(APPROVE, [entry({ stepId: "approve", waitsOn: "Anna Ruiz" })])).toBe(true);
  });

  it("is false of an unowned step, and of an agent step whatever it says", () => {
    expect(namesAnOwner(APPROVE, [entry({ stepId: "approve" })])).toBe(false);
    expect(namesAnOwner(APPROVE, [])).toBe(false);
    expect(namesAnOwner(IMPLEMENT, [entry({ stepId: "implement", waitsOn: "Anna Ruiz" })])).toBe(false);
  });
});

describe("what one head says", () => {
  it("joins the verifier's own words", () => {
    expect(verificationLine(IMPLEMENT, [entry({ stepId: "implement", checks: ["commits", "tests ran"], verifiesAction: true, kindVerifies: true })])).toBe(
      "EO checks: commits, tests ran",
    );
  });

  it("says what happens instead where nothing is checked", () => {
    expect(verificationLine(IMPLEMENT, [entry({ stepId: "implement", kindVerifies: true })])).toBe("Not checked until Approve");
  });

  it("names the person on a human step, and you when it names nobody", () => {
    expect(verificationLine(APPROVE, [entry({ stepId: "approve", waitsOn: "Anna Ruiz" })])).toBe("Anna Ruiz · approves here");
    expect(verificationLine(APPROVE, [entry({ stepId: "approve" })])).toBe("You approve here");
  });

  it("names the group on a step a team waits at, and says anybody in it may claim (EO-323, §8.2)", () => {
    // The story's second acceptance criterion, and the reason
    // `waitsOnKind` exists: "Anna Ruiz · approves here" and "Support
    // team · anyone claims" are different promises about who is expected
    // to act, and a name with no kind beside it could only be rendered
    // as one of the two.
    expect(verificationLine(APPROVE, [entry({ stepId: "approve", waitsOn: "Support team", waitsOnKind: "group" })])).toBe(
      "Support team · anyone claims",
    );
  });

  it("reads a name with nothing said about its kind as a person, which is what every board meant before groups", () => {
    expect(verificationLine(APPROVE, [entry({ stepId: "approve", waitsOn: "Anna Ruiz", waitsOnKind: "person" })])).toBe(
      "Anna Ruiz · approves here",
    );
    expect(verificationLine(APPROVE, [entry({ stepId: "approve", waitsOn: "Anna Ruiz" })])).toBe("Anna Ruiz · approves here");
  });

  it("does not claim a step nobody answered for is checked", () => {
    expect(verificationLine(IMPLEMENT, [])).toBe("Not checked until Approve");
  });
});
