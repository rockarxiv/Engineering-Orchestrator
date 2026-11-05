import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deprecatedToolsNamedIn, type DeprecatedToolName } from "@eo/core";
import type { CodePack } from "./pack.js";

/**
 * What a pack's prompts still tell an agent to call (KAN-178).
 *
 * A pack contributes roles, and a role's prompt is prose naming tools by
 * name — the original design lists "the roles with prompts" as
 * part of what a pack is. Three of the tool names those prompts can use
 * are aliases with a release left on them, and a prompt is the one place
 * the rename cannot reach: EO owns the text it shipped and a person owns
 * the text they edited (`roles/prompts.ts`), so `syncRolePrompts`
 * deliberately will not rewrite somebody's words to say `item_detail`.
 *
 * That leaves a prompt naming `mcp__eo__ticket_detail` which works today
 * and stops working a release from now, and whose author is the only one
 * who can fix it. Invariant #12 is explicit about what must not happen
 * next: the absence must not be left to be discovered by an agent. The
 * deprecation notice on the tool description tells the model; this tells
 * the person.
 *
 * ## Where this runs, and where a pack import would run it
 *
 * A code pack is a value compiled into this build, so the moment its
 * prompts enter an installation is startup, where `syncRolePrompts` reads each role's
 * file out of the pack's directory and writes it onto an agent. So that
 * is where this is called from, and it is a preflight in the exact sense
 * the other two are: it reads what a pack brought, before anybody acts
 * on it, and reports what has a clock on it.
 *
 * It takes the packs and a reader rather than reaching for a directory
 * itself, so the pack import that phase 7c adds can hand it a document's
 * prompts instead of a filesystem and get the same answer.
 */
export interface PackPromptWarning {
  /** The pack whose prompt this is — `CodePack.id`, as a collision names it. */
  pack: string;
  /** The role it belongs to, which is what the Agents screen calls the row. */
  role: string;
  /** The file it was read from, so somebody can go and edit the right one. */
  file: string;
  /** The names it still uses, each with EO's own name for the same tool. */
  names: DeprecatedToolName[];
}

/**
 * Every prompt in these packs still written against a renamed tool.
 *
 * Empty is the ordinary answer and the one EO ships in: its own prompts
 * name `mcp__eo__item_detail` as of KAN-162. What this is for is the
 * pack somebody else wrote, and the release that retires the aliases,
 * which is the one where an empty answer stops being a formality.
 *
 * A prompt that cannot be read is not a warning. A pack naming a file it
 * does not ship is a broken pack, and `loadRolePrompt` is where that
 * surfaces — saying "this prompt is on the old names" about a file
 * nobody can read would be inventing a fact about missing text.
 */
export function preflightPackPrompts(packs: readonly CodePack[], read: (file: string) => string | null): PackPromptWarning[] {
  const found: PackPromptWarning[] = [];
  for (const pack of packs) {
    for (const [role, entry] of pack.registry.roles ?? []) {
      const text = read(entry.prompt);
      if (text === null) continue;
      const names = deprecatedToolsNamedIn(text);
      if (names.length > 0) found.push({ pack: pack.id, role, file: entry.prompt, names });
    }
  }
  return found;
}

/**
 * Reads a prompt out of the directory the packs' files live in.
 *
 * Null rather than a throw for a file that is not there: this runs at
 * startup, and EO not launching because a pack named a prompt it did not
 * ship would be an accessory failing the whole app — the rule
 * `mcpHost/index.ts` states for itself.
 */
export function promptReader(dir: string): (file: string) => string | null {
  return (file) => {
    try {
      return readFileSync(join(dir, file), "utf8");
    } catch {
      return null;
    }
  };
}
