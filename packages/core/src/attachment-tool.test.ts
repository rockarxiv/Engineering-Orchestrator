import { describe, expect, it } from "vitest";
import { AttachmentAddArgsSchema, MAX_ATTACHMENT_ADD_PATHS, MAX_RUN_ATTACHMENTS } from "./attachment-tool.js";

/**
 * `attachment_add` takes paths and a caption and nothing else (EO-412).
 *
 * What it does *not* take is the point. A caption is text: it mentions
 * nobody, parks nothing and asks nothing, and the way that is held is
 * that the fields which would let it are refused rather than ignored.
 */
describe("what attachment_add takes", () => {
  it("takes paths alone, and a caption beside them", () => {
    expect(AttachmentAddArgsSchema.parse({ paths: ["shot.png"] })).toEqual({ paths: ["shot.png"] });
    expect(AttachmentAddArgsSchema.parse({ paths: ["shot.png"], caption: "The failing screen." }).caption).toBe("The failing screen.");
  });

  it.each(["mentions", "kind", "options", "blocking"])("refuses %s, which is how a caption would come to ask somebody something", (field) => {
    expect(AttachmentAddArgsSchema.safeParse({ paths: ["shot.png"], [field]: field === "blocking" ? true : ["user"] }).success).toBe(false);
  });

  it("refuses a call naming no file, and one naming more than a comment can carry", () => {
    expect(AttachmentAddArgsSchema.safeParse({ paths: [] }).success).toBe(false);
    expect(AttachmentAddArgsSchema.safeParse({ paths: [""] }).success).toBe(false);
    const paths = Array.from({ length: MAX_ATTACHMENT_ADD_PATHS + 1 }, (_unused, index) => `${index}.png`);
    expect(AttachmentAddArgsSchema.safeParse({ paths }).success).toBe(false);
    expect(AttachmentAddArgsSchema.safeParse({ paths: paths.slice(1) }).success).toBe(true);
  });

  it("allows a run two comments' worth of files", () => {
    expect(MAX_ATTACHMENT_ADD_PATHS).toBe(8);
    expect(MAX_RUN_ATTACHMENTS).toBe(16);
  });
});
