import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkMemoryNote, MAX_MEMORY_NOTE_CHARS, MEMORY_EXTRACTED_EVENT, MemoryExtractedEventSchema, MEMORY_NOTE_DEFINITION, MEMORY_NOTE_PROJECT_SCOPE, MemoryExtractionSchema, type MemoryNoteScope } from "./memory.js";

/**
 * The rules a `memory_note` call is held to (EO-479), which the main
 * process applies to every note handed to it over the agent write bridge
 * (EO-543) and extraction applies to each note it proposes. The refusals
 * are what the agent reads, so their words are pinned.
 */
const SCOPES: MemoryNoteScope[] = [
  { kind: "project", id: "project-p", name: "Payments" },
  { kind: "workspace", id: "workspace-w", name: "api" },
];

describe("checkMemoryNote", () => {
  it(`takes "${MEMORY_NOTE_PROJECT_SCOPE}" for the run's project, and trims the text`, () => {
    expect(checkMemoryNote({ scope: "project", text: "  Run pnpm install first.  " }, SCOPES)).toEqual({ ok: true, scope: { kind: "project", id: "project-p" }, body: "Run pnpm install first.", replaces: [] });
  });

  it("takes the project's own scope id for the project too, as an agent shown it in its memory section writes it (EO-543)", () => {
    expect(checkMemoryNote({ scope: "project-p", text: "Settlements are in UTC." }, SCOPES)).toEqual({ ok: true, scope: { kind: "project", id: "project-p" }, body: "Settlements are in UTC.", replaces: [] });
    expect(checkMemoryNote({ scope: " project-p ", text: "Settlements are in UTC." }, SCOPES)).toMatchObject({ ok: true, scope: { kind: "project", id: "project-p" } });
  });

  it("takes the id of a workspace the run works in", () => {
    expect(checkMemoryNote({ scope: "workspace-w", text: "Fixtures live in ./fixtures." }, SCOPES)).toMatchObject({ ok: true, scope: { kind: "workspace", id: "workspace-w" } });
  });

  it("takes the id of the container the run's item is filed under, and refuses it on a run given no container (EO-596)", () => {
    const container: MemoryNoteScope = { kind: "container", id: "container-c", name: "PAY-7 Rate limiting" };
    expect(checkMemoryNote({ scope: "container-c", text: "The limiter is keyed by account for now." }, [...SCOPES, container])).toMatchObject({ ok: true, scope: { kind: "container", id: "container-c" } });
    expect(checkMemoryNote({ scope: "container-c", text: "The limiter is keyed by account for now." }, SCOPES)).toEqual({
      ok: false,
      problem: '"container-c" is not a scope this run works in, so nothing was written. Use "project" or "workspace-w" (api).',
    });
    expect(checkMemoryNote({ scope: "elsewhere", text: "A fact." }, [...SCOPES, container])).toMatchObject({
      ok: false,
      problem: expect.stringContaining('Use "project" or "workspace-w" (api) or "container-c" (PAY-7 Rate limiting).'),
    });
  });

  it("refuses a scope the run does not work in with a sentence naming the scopes it may use", () => {
    expect(checkMemoryNote({ scope: "project-q", text: "Another project's fact." }, SCOPES)).toEqual({
      ok: false,
      problem: '"project-q" is not a scope this run works in, so nothing was written. Use "project" or "workspace-w" (api).',
    });
    // A project id is the project's only on a run in that project.
    expect(checkMemoryNote({ scope: "project-p", text: "A fact." }, [SCOPES[1]!])).toMatchObject({ ok: false });
    expect(checkMemoryNote({ scope: "project", text: "A fact." }, [])).toEqual({ ok: false, problem: "This run has no memory to write to. Nothing was written." });
  });

  it(`refuses a note longer than ${String(MAX_MEMORY_NOTE_CHARS)} characters with a sentence stating the limit, and takes one of exactly that`, () => {
    expect(checkMemoryNote({ scope: "project", text: "x".repeat(MAX_MEMORY_NOTE_CHARS + 1) }, SCOPES)).toEqual({
      ok: false,
      problem: "The note is 1,001 characters, and a note may be at most 1,000. Nothing was written; shorten it to the one fact worth keeping.",
    });
    expect(checkMemoryNote({ scope: "project", text: "x".repeat(MAX_MEMORY_NOTE_CHARS) }, SCOPES).ok).toBe(true);
  });

  it("refuses an empty note and a missing scope", () => {
    expect(checkMemoryNote({ scope: "project", text: "   " }, SCOPES)).toEqual({ ok: false, problem: "A note needs some text. Nothing was written." });
    expect(checkMemoryNote({ scope: "project", text: undefined }, SCOPES)).toMatchObject({ ok: false });
    expect(checkMemoryNote({ scope: "", text: "A fact." }, SCOPES)).toEqual({ ok: false, problem: 'A note needs a scope: "project", or the id of a workspace or container this run works in.' });
  });

  it("takes the ids a note replaces (EO-594), trimmed and each once, and none where it names none", () => {
    expect(checkMemoryNote({ scope: "project", text: "A fact.", replaces: [" m-1 ", "m-2", "m-1"] }, SCOPES)).toMatchObject({ ok: true, replaces: ["m-1", "m-2"] });
    expect(checkMemoryNote({ scope: "project", text: "A fact.", replaces: [] }, SCOPES)).toMatchObject({ ok: true, replaces: [] });
    expect(checkMemoryNote({ scope: "project", text: "A fact.", replaces: null }, SCOPES)).toMatchObject({ ok: true, replaces: [] });
  });

  it("refuses a replaces that is not a list of ids, and writes nothing", () => {
    const refusal = { ok: false, problem: "`replaces` is a list of the ids of memory entries this note replaces, each a non-empty string. Nothing was written." };
    expect(checkMemoryNote({ scope: "project", text: "A fact.", replaces: "m-1" }, SCOPES)).toEqual(refusal);
    expect(checkMemoryNote({ scope: "project", text: "A fact.", replaces: ["m-1", 2] }, SCOPES)).toEqual(refusal);
    expect(checkMemoryNote({ scope: "project", text: "A fact.", replaces: ["  "] }, SCOPES)).toEqual(refusal);
  });
});

describe("MemoryExtractedEventSchema", () => {
  it("still reads an event an older run left in the log", () => {
    const event = { type: MEMORY_EXTRACTED_EVENT, outcome: "follow_ups_only", entryIds: [], dropped: [], reason: null, followUps: ["a"], followUpsHeld: [], notesSkipped: "noted_itself" };
    expect(MemoryExtractedEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("MEMORY_NOTE_DEFINITION", () => {
  it("keeps a gap out of memory and sends it to the run's answer, where it is judged", () => {
    expect(MEMORY_NOTE_DEFINITION).toContain("Nor is a gap the work leaves when it is finished");
    expect(MEMORY_NOTE_DEFINITION).toContain("Say either in the run's answer, where whoever reads the work next can judge it");
    expect(MEMORY_NOTE_DEFINITION).not.toMatch(/follow-?up|handed on/i);
  });
});

describe("MemoryExtractionSchema (EO-594)", () => {
  it("ignores followUps from a model that still answers with them: nothing can act on one", () => {
    const answer = MemoryExtractionSchema.parse({ notes: [], followUps: [{ title: "A gap", reason: "Why." }] });
    expect(answer).toEqual({ notes: [] });
  });

  it("takes the ids each note replaces, and none from an answer that does not say", () => {
    expect(MemoryExtractionSchema.parse({ notes: [{ scope: "project", text: "A fact.", replaces: ["m-1"] }, { scope: "project", text: "Another." }] })).toEqual({
      notes: [
        { scope: "project", text: "A fact.", replaces: ["m-1"] },
        { scope: "project", text: "Another.", replaces: [] },
      ],
    });
    expect(MemoryExtractionSchema.safeParse({ notes: [{ scope: "project", text: "A fact.", replaces: "m-1" }] }).success).toBe(false);
  });

  it("lists replaces as required in the JSON Schema a backend's structured output is held to, as a strict one needs", () => {
    const schema = z.toJSONSchema(MemoryExtractionSchema, { io: "output" }) as unknown as { properties: { notes: { items: { required: string[]; properties: Record<string, unknown> } } } };
    expect(schema.properties.notes.items.required).toEqual(["scope", "text", "replaces"]);
    expect(schema.properties.notes.items.properties["replaces"]).toMatchObject({ type: "array", items: { type: "string" } });
  });
});
