import { describe, expect, it } from "vitest";
import type { Item } from "@eo/core";
import { approvalNote, createdKeysIn } from "./approvalNote.js";

const item = (key: string) => ({ key }) as Item;

describe("an approval's note", () => {
  it("reads back the keys it wrote, in order", () => {
    const note = approvalNote({ created: [item("EO-12"), item("EO-13"), item("EO-14")], changed: [] });
    expect(note).toBe("Approved. Created EO-12, EO-13, EO-14.");
    expect(createdKeysIn(note)).toEqual(["EO-12", "EO-13", "EO-14"]);
  });

  it("names no created item for an amendment, or for a sentence that is not an approval", () => {
    expect(createdKeysIn(approvalNote({ created: [], changed: [item("EO-9")] }))).toEqual([]);
    expect(createdKeysIn(approvalNote({ created: [], changed: [] }))).toEqual([]);
    expect(createdKeysIn("Not applied. Created EO-1.")).toEqual([]);
  });

  it("says what the edges were written despite after the keys, which still read back (EO-780)", () => {
    const note = approvalNote({ created: [item("EO-12"), item("EO-13")], changed: [], warnings: ["EO-12 can reach \"To Do\" without passing a step that implements."] });
    expect(note).toBe('Approved. Created EO-12, EO-13.\n\nWarning: EO-12 can reach "To Do" without passing a step that implements.');
    expect(createdKeysIn(note)).toEqual(["EO-12", "EO-13"]);
  });

  it("keeps created apart from updated", () => {
    expect(createdKeysIn(approvalNote({ created: [item("EO-1")], changed: [item("EO-2")] }))).toEqual(["EO-1"]);
  });
});
