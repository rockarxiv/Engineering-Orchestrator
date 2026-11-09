import { eoToolName, type Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import {
  assembleContext,
  assembleSeedContext,
  type AssembleContextInput,
  type AssembleSeedContextInput,
  type AttributedAttachment,
  type AttributedComment,
  type ContextItemInput,
} from "./context.js";

/**
 * The item's own files in an agent's context (EO-703): listed beside the
 * description with `attachment_read` named, absent when there are none,
 * and never what truncation takes.
 */

const READ = `\`${eoToolName("attachment_read")}\``;

function file(id: string, name: string, mimeType: string, size: number): AttributedAttachment {
  return { id: id as Uuid, name, mimeType, size, origin: "eo", synchronizationState: "local" };
}

const MOCK = file("019a0000-0000-7000-8000-0000000000a1", "mock.png", "image/png", 2048);
const SPEC = file("019a0000-0000-7000-8000-0000000000a2", "spec.pdf", "application/pdf", 90_000);

function item(files?: AttributedAttachment[]): ContextItemInput {
  return {
    key: "EO-1",
    title: "A story",
    body: "Do the thing.",
    acceptanceCriteria: ["It does the thing."],
    actionOverrides: new Map(),
    workspaceKind: "none",
    ...(files ? { files } : {}),
  };
}

function chatter(count: number): AttributedComment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `c-${String(i)}` as Uuid,
    authorType: "agent" as const,
    authorName: "Implementer",
    authorRole: "implementer",
    parentId: null,
    body: `chatter ${String(i)} `.repeat(40),
    kind: "note" as const,
    attachments: [],
    pinned: false,
    createdAt: i,
  }));
}

function full(overrides: Partial<AssembleContextInput> = {}): AssembleContextInput {
  return { action: "implement", item: item(), sectionRenderers: [], parentFeature: null, commentThread: [], dependencies: [], maxTokens: 10_000, ...overrides };
}

function seed(overrides: Partial<AssembleSeedContextInput> = {}): AssembleSeedContextInput {
  return {
    action: "implement",
    item: item(),
    sectionRenderers: [],
    dependencyKeys: [],
    stepComments: [],
    humanComments: [],
    omitted: { total: 0, byAuthorAndKind: [], attachments: [] },
    ...overrides,
  };
}

const lineOf = (attachment: AttributedAttachment) =>
  `- ID: ${attachment.id}; name: ${attachment.name}; MIME type: ${attachment.mimeType}; size: ${String(attachment.size)} bytes; origin: eo; synchronization state: local`;

describe("the item's own files in the full assembly", () => {
  it("lists each file beside the description, under a line naming attachment_read", () => {
    const result = assembleContext(full({ item: item([MOCK, SPEC]) }));

    expect(result.itemFilesSection).toContain(READ);
    expect(result.itemFilesSection).toContain(lineOf(MOCK));
    expect(result.itemFilesSection).toContain(lineOf(SPEC));
    // Right after the item, before the thread.
    const text = result.fullText;
    expect(text.indexOf("Do the thing.")).toBeLessThan(text.indexOf(lineOf(MOCK)));
    expect(text.indexOf(lineOf(SPEC))).toBeLessThan(text.indexOf("## Comments"));
  });

  it("adds nothing for an item with no files", () => {
    const without = assembleContext(full());
    const empty = assembleContext(full({ item: item([]) }));

    expect(without.itemFilesSection).toBeNull();
    expect(empty.itemFilesSection).toBeNull();
    expect(empty.fullText).toBe(without.fullText);
    expect(without.fullText).not.toContain("own files");
  });

  it("keeps every file however long the thread, while the thread itself is trimmed", () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`019a0000-0000-7000-8000-${String(i).padStart(12, "0")}`, `shot-${String(i)}.png`, "image/png", 100 + i));
    const result = assembleContext(full({ item: item(files), commentThread: chatter(200), maxTokens: 50 }));

    expect(result.droppedCommentCount).toBeGreaterThan(0);
    for (const attachment of files) expect(result.fullText).toContain(lineOf(attachment));
  });
});

describe("the item's own files in the seed", () => {
  it("lists each file beside the description, under a line naming attachment_read", () => {
    const text = assembleSeedContext(seed({ item: item([MOCK, SPEC]) })).fullText;

    expect(text).toContain(READ);
    expect(text).toContain(lineOf(MOCK));
    expect(text).toContain(lineOf(SPEC));
    expect(text.indexOf("Do the thing.")).toBeLessThan(text.indexOf(lineOf(MOCK)));
    expect(text.indexOf(lineOf(SPEC))).toBeLessThan(text.indexOf("## Dependencies"));
  });

  it("adds nothing for an item with no files", () => {
    expect(assembleSeedContext(seed({ item: item([]) })).fullText).toBe(assembleSeedContext(seed()).fullText);
    expect(assembleSeedContext(seed()).fullText).not.toContain("own files");
  });

  it("keeps every file however many comments the census leaves out", () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`019a0000-0000-7000-8000-${String(i).padStart(12, "0")}`, `shot-${String(i)}.png`, "image/png", 100 + i));
    const text = assembleSeedContext(
      seed({ item: item(files), omitted: { total: 500, byAuthorAndKind: [{ authorName: "Implementer", kind: "note", count: 500 }], attachments: [] } }),
    ).fullText;

    for (const attachment of files) expect(text).toContain(lineOf(attachment));
  });
});
