import { checkMemoryNote, eoToolName, MAX_MEMORY_NOTE_CHARS, MEMORY_NOTE_DEFINITION, MEMORY_NOTE_REPLACES, MEMORY_NOTE_TOOL_NAME, MEMORY_READ_TOOL_NAME, MEMORY_USED_FIELD } from "@eo/core";
import { describe, expect, it } from "vitest";
import type { MemoryScopeInfo } from "./selection.js";
import { MEMORY_WRITING_SECTION_HEADING, renderMemoryWritingSection } from "./writing.js";

/**
 * The memory-writing block EO appends to every turn served `memory_note`
 * (EO-593). Pure: the scopes in, the block out — nothing about the agent,
 * its role or its action goes in, so two agents given the same scopes are
 * given the same words.
 */
const PROJECT: MemoryScopeInfo = { scope: { kind: "project", id: "project-p" }, name: "Payments" };
const WORKSPACE: MemoryScopeInfo = { scope: { kind: "workspace", id: "workspace-w" }, name: "api" };

describe("the memory-writing block", () => {
  const block = renderMemoryWritingSection([PROJECT, WORKSPACE])!;

  it("carries the shared definition of a note word for word", () => {
    expect(block).toContain(MEMORY_NOTE_DEFINITION);
  });

  it("names the tool as the memory section names memory_read, the spelling every backend advertises", () => {
    expect(block.startsWith(`${MEMORY_WRITING_SECTION_HEADING}\n`)).toBe(true);
    expect(block).toContain(`\`${eoToolName(MEMORY_NOTE_TOOL_NAME)}\``);
  });

  it("says one fact per note, within the limit a note is held to", () => {
    expect(block).toContain("One fact per note");
    expect(block).toContain(`${MAX_MEMORY_NOTE_CHARS.toLocaleString("en-US")} characters`);
  });

  it("names every scope the note may go to, as checkMemoryNote accepts it", () => {
    expect(block).toContain("- `project` — what is true across the whole project, Payments.");
    expect(block).toContain("- `workspace-w` — what is true only of the workspace api.");
    const scopes = [PROJECT, WORKSPACE].map((info) => ({ ...info.scope, name: info.name }));
    for (const named of [...block.matchAll(/^- `([^`]+)` — /gm)].map((match) => match[1]!)) {
      expect(checkMemoryNote({ scope: named, text: "A fact." }, scopes).ok, named).toBe(true);
    }
  });

  it("says to write only what was checked, and that the run's own story is not a note", () => {
    expect(block).toContain("Write only what you checked");
    expect(block).toContain("Nothing about this run is a note");
  });

  it("says when a note names the entries it replaces, that only an agent's may be named, and where their ids are (EO-594)", () => {
    expect(block).toContain(`A note that corrects an entry memory holds, or says again what one already says, names that entry's id in \`${MEMORY_NOTE_REPLACES}\`.`);
    expect(block).toContain("EO retires the entries it names when it writes the note");
    expect(block).toContain("Name only entries an agent wrote, in the scopes above — never a person's");
    expect(block).toContain(`\`${eoToolName(MEMORY_READ_TOOL_NAME)}\``);
  });

  it("asks for the entries the answer relied on in memoryUsed, of the field rather than of any action (EO-597)", () => {
    expect(MEMORY_USED_FIELD).toBe("memoryUsed");
    expect(block).toContain("Where your answer has a `memoryUsed` field, list in it the id of every memory entry you were given and relied on in this work");
    expect(block).toContain("Name only entries you were given; EO drops any other id.");
  });

  it("is rendered for scopes that hold no entries, and for a project alone", () => {
    const projectOnly = renderMemoryWritingSection([PROJECT])!;
    expect(projectOnly).toContain(MEMORY_NOTE_DEFINITION);
    expect(projectOnly).not.toContain("workspace-w");
  });

  it("is not rendered for a turn with no scope to write to, where memory_note is not listed", () => {
    expect(renderMemoryWritingSection([])).toBeNull();
  });

  it("says who is given a note, and what to do with the entries the answer names (EO-611)", () => {
    expect(block).toContain("later runs on other items are given it");
    expect(block).toContain(`\`${eoToolName(MEMORY_NOTE_TOOL_NAME)}\`'s answer names the active entries in its scope closest to it, with their ids and bodies`);
    expect(block).toContain(`naming in \`${MEMORY_NOTE_REPLACES}\` that entry and the note you just wrote`);
  });

  it("speaks of the item, never of a pack's word for it", () => {
    expect(block).not.toMatch(/\b(ticket|story|feature|branch|worktree|repository)\b/i);
  });
});
