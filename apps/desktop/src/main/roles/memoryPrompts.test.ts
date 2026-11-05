import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_NOTE_TOOL_NAME } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, updateAgent } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { loadRolePrompt, sourcePromptsDir, syncRolePrompts } from "./prompts.js";

/**
 * How an agent writes memory is EO's block, not a role prompt's
 * paragraph (EO-593). The shipped implementer, reviewer and system agent
 * were told in their own words (EO-479); an agent a person made with
 * their own instructions was told nothing. Now every turn served
 * `memory_note` is given the same block (`memory/writing.ts`), and the
 * three prompts say nothing about it — a second, older account of how to
 * write memory beside EO's would be one the two could disagree in.
 */
const FILES = [
  { role: "implementer", file: "implementer.md", previous: "implementer-v14.md" },
  { role: "reviewer", file: "reviewer.md", previous: "reviewer-v14.md" },
  { role: "system", file: "system-agent.md", previous: "system-agent-v36.md" },
] as const;

const fixture = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", file), "utf8");

describe("the shipped prompts on memory", () => {
  it.each(FILES)("$file no longer mentions memory_note", ({ file }) => {
    const text = readFileSync(join(sourcePromptsDir(), file), "utf8");
    expect(text).not.toContain(MEMORY_NOTE_TOOL_NAME);
  });
});

describe("an agent still on a prompt that carried its own memory paragraph", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  const agentOf = (role: string) => listAgents(handle.db).find((agent) => agent.role === role && agent.deletedAt === null)!;

  it.each(FILES)("is brought up to the $file without it, though no provenance says the text was EO's", ({ role, previous }) => {
    // The fixture is that text: it still names the tool.
    const shipped = fixture(previous).trim();
    expect(shipped).toContain(`\`${MEMORY_NOTE_TOOL_NAME}\``);
    updateAgent(handle.db, agentOf(role).id, { instructions: shipped, promptHash: null });

    const { updated, customised } = syncRolePrompts(handle.db);

    expect(updated).toContain(role);
    expect(customised).not.toContain(role);
    expect(agentOf(role).instructions).toBe(loadRolePrompt(role));
  });

  it.each(FILES)("is left alone on an edit of the $previous text", ({ role, previous }) => {
    const edited = `${fixture(previous).trim()}\n\nAlways answer in French.`;
    updateAgent(handle.db, agentOf(role).id, { instructions: edited, promptHash: null });

    const { updated, customised } = syncRolePrompts(handle.db);

    expect(updated).not.toContain(role);
    expect(customised).toContain(role);
    expect(agentOf(role).instructions).toBe(edited);
  });
});
