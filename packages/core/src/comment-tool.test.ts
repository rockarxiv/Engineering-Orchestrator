import { describe, expect, it } from "vitest";
import { CommentToolArgsSchema, COMMENT_TOOL_NAME, commentToolDef } from "./comment-tool.js";

/**
 * The `comment` tool is the only channel an agent has (invariant #4), and
 * every field it may omit is filled in by a default here. Those defaults
 * are behaviour, not formatting: the supervisor branches on `blocking` to
 * decide whether a run continues or stops and waits for a reply.
 *
 * Mutation testing found the whole set unguarded — flipping `blocking`'s
 * default to `true` left all 2017 tests passing, while meaning that every
 * agent comment that did not mention `blocking` would end its run.
 */
describe("what the comment tool assumes when an agent leaves a field out", () => {
  it("does not block the run", () => {
    // The one that matters most. `runSupervisor` reads `parsed.data.blocking`
    // to decide between "post and keep consuming the stream" and "end the
    // run here". Defaulted the other way, an agent posting a routine note
    // would park its own item.
    expect(CommentToolArgsSchema.parse({ body: "Rate limiter added." }).blocking).toBe(false);
  });

  it("mentions nobody", () => {
    // An empty array rather than undefined, so `resolveMentions` has
    // something to iterate. Defaulted to anything else, a comment would
    // address someone the agent never named.
    expect(CommentToolArgsSchema.parse({ body: "Done." }).mentions).toEqual([]);
  });

  it("is a note, which is the kind that asks nothing of anyone", () => {
    // `question` and `approval` both mean somebody is waiting; `note` is
    // the only kind that is safe to assume.
    expect(CommentToolArgsSchema.parse({ body: "Done." }).kind).toBe("note");
  });

  it("offers no options", () => {
    expect(CommentToolArgsSchema.parse({ body: "Done." }).options).toBeUndefined();
  });

  it("still requires a body, because a comment with nothing in it says nothing", () => {
    expect(CommentToolArgsSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a kind EO has no handling for", () => {
    expect(CommentToolArgsSchema.safeParse({ body: "x", kind: "escalation" }).success).toBe(false);
    // Nor a rejection: that is the engine's verdict on a run, not a
    // thing a run may declare about itself (invariant 1).
    expect(CommentToolArgsSchema.safeParse({ body: "x", kind: "rejection" }).success).toBe(false);
  });

  it("takes an output, which is how a run with no workspace produces one (EO-298)", () => {
    // `artifacts` gathers a run's output off the disk it worked on, and
    // a `none` run has no disk to gather from — so an agent that drafted
    // a reply or a report says so itself, through the same comment, of
    // the same kind, derived the same way.
    expect(CommentToolArgsSchema.parse({ body: "Your refund was issued this morning.", kind: "output" }).kind).toBe("output");
  });

  it("shows the agent the same schema its call is checked against", () => {
    // A-02: the tool definition is derived from the validator rather than
    // hand-mirrored, so the two cannot drift. `io: "input"` means a field
    // with a default is advertised as optional — asking a model for a
    // value EO would have defaulted anyway is a needless way to fail.
    const properties = (commentToolDef.parameters as { properties?: Record<string, unknown>; required?: string[] }).properties ?? {};
    const required = (commentToolDef.parameters as { required?: string[] }).required ?? [];

    expect(commentToolDef.name).toBe(COMMENT_TOOL_NAME);
    expect(Object.keys(properties).sort()).toEqual(["blocking", "body", "kind", "mentions", "options"]);
    expect(required).toEqual(["body"]);
  });
});
