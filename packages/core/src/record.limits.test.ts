import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BASE64_CHARS, RecordAdoptPageSchema, RecordCommentCommandSchema } from "./index.js";

/**
 * The one number this package holds twice (EO-325).
 *
 * `record.ts` bounds the `dataBase64` a moved file may arrive as, and
 * `ipc.ts` bounds the same thing for the ordinary attachment command
 * and derives the whole request limit from it. The two cannot import
 * each other — `ipc.ts` imports `record.ts`, and a cycle would be
 * worse than a literal — so the literal is written on both sides and
 * held to the exported one here.
 *
 * What drift would cost: a file within the contract's own limit
 * refused by one channel and accepted by the other, which reads to
 * whoever meets it as "EO lost my attachment" rather than as a bound
 * anybody chose.
 */
describe("a moved file and a posted file are bounded alike", () => {
  it("refuses exactly at the attachment limit the contract publishes", () => {
    const file = {
      id: "a1",
      itemId: "i1",
      commentId: "c1",
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 1,
      createdAt: 1,
    };

    expect(RecordAdoptPageSchema.safeParse({ attachments: [{ ...file, dataBase64: "x".repeat(MAX_ATTACHMENT_BASE64_CHARS) }] }).success).toBe(
      true,
    );
    expect(
      RecordAdoptPageSchema.safeParse({ attachments: [{ ...file, dataBase64: "x".repeat(MAX_ATTACHMENT_BASE64_CHARS + 1) }] }).success,
    ).toBe(false);
  });

  it("carries one file at a time, because one fills a request", () => {
    const file = { id: "a", itemId: "i", commentId: "c", name: "n", mimeType: "m", size: 1, createdAt: 1, dataBase64: "" };

    expect(RecordAdoptPageSchema.safeParse({ attachments: [file] }).success).toBe(true);
    expect(RecordAdoptPageSchema.safeParse({ attachments: [file, { ...file, id: "b" }] }).success).toBe(false);
  });
});

describe("a comment's options on the wire", () => {
  const command = { kind: "comment" as const, id: "command-1", itemId: "item-1", commentId: "c1", authorType: "engine" as const, body: "A question.", createdAt: 1 };

  it("drops a target this build does not know, keeping the rest of the comment", () => {
    const options = ["Discard", { kind: "open", label: "Gone", opens: { type: "notABuiltTarget", id: "x" } }];
    const parsed = RecordCommentCommandSchema.safeParse({ ...command, options });
    expect(parsed.success && parsed.data.options).toEqual(["Discard"]);
  });

  it("reads no options as null, whether sent as null or left out", () => {
    expect(RecordCommentCommandSchema.parse({ ...command, options: null }).options).toBeNull();
    expect(RecordCommentCommandSchema.parse(command).options).toBeNull();
  });
});
