import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deprecatedToolsNamedIn } from "@eo/core";
import type { CodePack } from "./pack.js";
import { preflightPackPrompts, promptReader } from "./promptPreflight.js";
import { sourcePromptsDir } from "../roles/prompts.js";

/**
 * What a pack's prompts still tell an agent to call (KAN-178).
 *
 * A pack contributes roles, a role carries a prompt, and a prompt names
 * tools in prose — which is the one place the KAN-145 rename could not
 * reach, because EO owns the text it shipped and a person owns the text
 * they edited. So a prompt naming `mcp__eo__ticket_detail` is a contract
 * with a release left on it and an author who is the only one able to
 * fix it, which is exactly what invariant #12 says must not be left for
 * an agent to discover.
 */

/** A pack that contributes one role, whose prompt is whatever a test wrote. */
function packWith(role: string, file: string): CodePack {
  return {
    id: "test-pack",
    registry: { roles: new Map([[role, { prompt: file, threadReuse: false, schemasByAction: new Map() }]]) },
    builtins: {},
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eo prompts "));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a pack's prompts, before anything acts on them", () => {
  it("reports a prompt that names mcp__eo__ticket_detail, and what to use instead", () => {
    writeFileSync(join(dir, "implementer.md"), "Read a dependency with `mcp__eo__ticket_detail`, then get to work.\n");

    const warnings = preflightPackPrompts([packWith("implementer", "implementer.md")], promptReader(dir));

    expect(warnings).toEqual([
      {
        pack: "test-pack",
        role: "implementer",
        file: "implementer.md",
        names: [{ deprecated: "ticket_detail", replacement: "item_detail", server: "eo" }],
      },
    ]);
  });

  it("says nothing about a prompt that has moved to EO's own name", () => {
    writeFileSync(join(dir, "implementer.md"), "Read a dependency with `mcp__eo__item_detail`, then get to work.\n");

    expect(preflightPackPrompts([packWith("implementer", "implementer.md")], promptReader(dir))).toEqual([]);
  });

  /**
   * A pack naming a file it does not ship is a broken pack, and
   * `loadRolePrompt` is where that surfaces. Saying "this prompt is on
   * the old names" about text nobody can read would be inventing a fact.
   */
  it("says nothing about a prompt it cannot read, and does not throw at startup", () => {
    expect(preflightPackPrompts([packWith("implementer", "not-shipped.md")], promptReader(dir))).toEqual([]);
  });

  it("says nothing when no pack is installed, which is the core on its own", () => {
    expect(preflightPackPrompts([], promptReader(dir))).toEqual([]);
  });

  /**
   * The state KAN-162 left this installation in, asserted against the
   * real files rather than a fixture: every prompt EO ships names
   * `mcp__eo__item_detail`. This is the test that fails the day somebody
   * writes an old name back into a shipped prompt.
   *
   * The files are read from the directory rather than through the pack
   * value, which would put this file on `importAllowlist.test.ts`'s
   * list — a list this phase may not grow. `sourcePromptsDir` is a path
   * and not an import for exactly that reason (`roles/prompts.ts`).
   */
  it("is silent about the prompts EO ships, which KAN-162 moved to item_detail", () => {
    const shipped = sourcePromptsDir();
    const read = promptReader(shipped);

    const named = readdirSync(shipped)
      .filter((file) => file.endsWith(".md"))
      .flatMap((file) => deprecatedToolsNamedIn(read(file) ?? "").map((entry) => `${file}: ${entry.deprecated}`));

    expect(named).toEqual([]);
  });
});
