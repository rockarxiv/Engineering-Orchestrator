import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/client.js";
import { listAgents, updateAgent } from "../db/repos/index.js";
import { registry } from "../registry.js";

/**
 * Where the prompt files live when running from source.
 *
 * Production passes an explicit directory instead, resolved by
 * resources.ts — packaged, these ship as extraResources, since Rollup
 * bundles JavaScript and not .md.
 *
 * **The directory belongs to the developer pack** (KAN-144). Every role
 * that has a prompt is a role the pack contributes to the registry —
 * the implementer, the reviewer and the system agent alike — and the
 * registry entry is what names each file (`RoleEntry.prompt`). What is
 * left here is the reading of one, which is not the pack's business:
 * `loadRolePrompt` and `syncRolePrompts` know how to fill in a
 * placeholder and how to tell EO's own words from somebody's edit, and
 * neither knows what an implementer is. A path rather than an import,
 * so nothing in the core links against the pack to find its own
 * default; a build with no pack installed resolves a directory that is
 * not there, and every role reads as one nobody shipped a prompt for.
 */
export function sourcePromptsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "packs", "developer", "prompts");
}

/**
 * The directory in force for this process.
 *
 * A module-level value because it is a property of the running app
 * rather than of any one call: `main/index.ts` resolves it once from
 * `resources.ts` and every reader wants that same answer. Threading it
 * through every caller instead would put a path argument on IPC handlers
 * that have no other reason to know about the filesystem — and one
 * caller forgetting it would silently read a *different* prompt in a
 * packaged build than the one the agent is running.
 */
let promptsDir = sourcePromptsDir();

/** Called once at startup, before anything reads a prompt. */
export function usePromptsDir(dir: string): void {
  promptsDir = dir;
}

/**
 * Filename per role, read off the registry (KAN-124). A role with no
 * entry there simply has no default prompt.
 *
 * Derived rather than declared, so this set and the roles EO ships are
 * one fact rather than two lists that agree today (EO-178). `builtin`
 * on the wire is what the Agents editor acts on, and a role EO ships a
 * prompt for but does not call built-in — or the reverse — cannot
 * happen when both answers come from the same entry. That is what made
 * merging the two conversational roles (EO-181) a compile error here
 * until `product-owner.md` and `pipeline-architect.md` had actually
 * been replaced by `system-agent.md`, rather than a stale filename that
 * throws ENOENT on the first dispatch after launch; the registry's
 * `prompt` field is where that filename lives now.
 *
 * Exported for the tests, which have to name a role's file to stand a
 * newer one next to it — `role.replace("_", "-") + ".md"` guessed right
 * only while every filename happened to be its role's.
 *
 * A function rather than a constant since KAN-144: the registry is the
 * fold of whatever packs are installed, and `createEngine` installs it
 * while this module is long since loaded. A map built at import time
 * would answer for the packs that were installed when somebody
 * happened to import this file.
 */
export function promptFiles(): Record<string, string> {
  return Object.fromEntries([...registry.roles].map(([role, entry]) => [role, entry.prompt]));
}

/** What the seed migration writes, and what marks an agent as never having been configured. */
export const PLACEHOLDER_PREFIX = "TODO: placeholder instructions";

/**
 * How a prompt is identified.
 *
 * Over the trimmed text, because `loadRolePrompt` trims what it reads and
 * an agent's stored instructions therefore never carry the file's
 * trailing newline. Hashing the untrimmed file would make every prompt
 * look edited.
 */
export function promptHash(instructions: string): string {
  return createHash("sha256").update(instructions.trim()).digest("hex");
}

/**
 * Every default prompt EO shipped before it started recording what it
 * wrote (migration 0033).
 *
 * A closed set, but for the one addition at the end of this note. It exists for exactly one job: an
 * install created before `agents.prompt_hash` existed has no provenance,
 * and without this its untouched default would be indistinguishable from
 * a prompt someone spent an afternoon on. Recognising the text as
 * something EO itself shipped settles that — a prompt byte-identical to
 * a release of EO's own is not somebody's work.
 *
 * From 0033 onward EO records the hash of what it writes, so for an
 * install of that vintage the question answers itself and nothing needs
 * adding here. What does need adding is a role whose *identifier*
 * changes underneath a pre-0033 row, because this is keyed on
 * `agent.role` and a renamed row stops matching the list that describes
 * its own history. That is EO-181: migration 0062 turns the Product
 * Owner row into the system agent, so every hash EO ever shipped as
 * `product-owner.md` is listed under `system` — otherwise a pre-0033
 * install would have its untouched default read as somebody's afternoon
 * of work and be left on a prompt for a role that no longer exists.
 *
 * `pipeline_architect` is absent for a reason rather than an oversight:
 * that prompt first shipped with migration 0036, long after 0033, so
 * every architect row in existence carries provenance — and 0062 leaves
 * that row's role alone in any case.
 *
 * `system-agent.md` v1 is in the set and is now historical, exactly as
 * EO-181 said it would become: it was the shipping text when the role
 * was renamed, and EO-184's revision is the next version it spoke of.
 * Nothing current is in the set for any role now, which is the steady
 * state — a prompt written since 0033 carries its own provenance, so
 * recognising its text is not a question anybody has to ask.
 * `refine.test.ts` keeps one of these
 * historical texts as a fixture, since nothing shipping can stand in for
 * one. Generated by `node scripts/shipped-prompt-hashes.mjs`, which
 * walks each file's git history — including the history of the files a
 * merged prompt replaced — so this is reproducible rather than asserted.
 *
 * **One addition since, and why (EO-593).** How an agent writes memory
 * moved out of the three prompts into a block EO appends to every turn
 * served `memory_note`, so the texts that still carried a paragraph of
 * their own about it — implementer and reviewer v14, system agent v36 —
 * are listed too. A row whose provenance was recorded is decided by that
 * provenance before this list is asked (`isUnedited`), so this changes
 * nothing for one; it is for a row holding one of those texts with none,
 * which must be brought up to the text without the paragraph rather than
 * read as somebody's edit and left telling its agent about memory twice.
 */
const SHIPPED_PROMPT_HASHES: Record<string, readonly string[]> = {
  system: [
    // The last text with its own memory paragraph (EO-593).
    "85068d8ad4877360d03cf3f00ebcfc428c2b9024fff8568efe881f7db48a5cd3", // system-agent.md v36
    // The text `system-agent.md` shipped with when the role was renamed
    // (EO-181), historical since EO-184 revised it.
    "75ecf243e0a6768349f4a237d24e07bbcdc267af89a0dcd29e398db2a0be166c", // system-agent.md v1
    // Shipped as `product-owner.md`, under the `product_owner` role this
    // one replaces. Kept because a pre-0033 row carries no provenance and
    // its text is still the only evidence of who wrote it.
    "7e55cf1789cc6b7640017d3f34fc76087b1dbe3c7798ef775dfd70341d9050e5", // v8
    "6101de7f53fb6738665745af2732108df052b2a1b0ccbf7cd6734756014d0b82", // v8
    "03d59ed65847a3c63d50e123ff975e0990b118e0780a68ea608e1d497e88b021", // v7
    "d669eff831e91f4c54bbac8b24c77ce914bf83dffa4c3f862969dbcfc730d727", // v6
    "704ef1900a9c7c71006bd9f2f18f1329ea06a8370a05089fadcb8e368f084f08", // v5
    "0d693ac95bf367c072c3deeef8f9a7063a89dc1dce2cbf3d7539427c7729dfee", // v4
    "2644ccad1fe5ec64e42f1c0848c11c739dfe06e15cf4c734c5e7fae7182eba43", // v3
  ],
  implementer: [
    "73597aa475bf715f2e63e02db8c108f65512887b162a030fe154c93feb7600d7", // v14, the last with its own memory paragraph (EO-593)
    "296a928720563cd2db5011c92401ee4fcdbb1b2bd8950d96b347eb82b7440aec", // v4
    "82512b4d88ebb3386e750fe8f28adc1ba735e97e1dd92a2229979690dd7724d6", // v3
    "55906f7bd5f96e4a54e25fa10d8c21a5468df5b9e0efae322e3160d5e924a800", // v2
  ],
  reviewer: [
    "62b01f3c317bfa67bc02f94b235a0ae5a4737a6a13e221800adaa7c8590e16a1", // v14, the last with its own memory paragraph (EO-593)
    "f67989722a76930924ab1d25918954c3f014d3afb3031d6abc9a8a24aff4212e", // v3
    "a0ea572d0a7d9c08fbc358586ff28b978e0635965b0548413159905d661872ec", // v2
  ],
};

/**
 * The default prompt for a role, read from its versioned file (R-01:
 * "a versioned prompt file, not an inline string").
 *
 * Files rather than a migration because prompts get iterated on — they
 * want diffs, review, and blame, none of which a string embedded in
 * applied SQL gives you.
 */
export function loadRolePrompt(role: string, dir = promptsDir): string | undefined {
  const file = registry.roles.get(role)?.prompt;
  if (file === undefined) return undefined;
  return readFileSync(join(dir, file), "utf8").trim();
}

/** Whether these instructions are EO's own words rather than somebody's edit. */
function isUnedited(agent: { instructions: string; promptHash: string | null; role: string }): boolean {
  if (agent.instructions.startsWith(PLACEHOLDER_PREFIX)) return true;

  const hash = promptHash(agent.instructions);
  // Recorded provenance is the authority when there is any: it says what
  // EO wrote, and text that still hashes to it has not been touched.
  if (agent.promptHash !== null) return hash === agent.promptHash;

  // No provenance, so fall back to recognising a prompt EO shipped
  // before it kept any. Anything unrecognised is treated as a human's.
  return (SHIPPED_PROMPT_HASHES[agent.role] ?? []).includes(hash);
}

export interface PromptSyncReport {
  /** Roles whose prompt was brought up to the shipped default. */
  updated: string[];
  /**
   * Roles left alone because someone had edited them.
   *
   * Reported rather than silently skipped: a new default that nobody is
   * told about is a change that did not happen. The Agents screen offers
   * these as "load the default" beside the editor.
   */
  customised: string[];
}

/**
 * Brings every unedited prompt up to the version this build ships.
 *
 * It used to fill in the seed placeholder and nothing else, which meant a
 * prompt improved after your first launch never reached you — the whole
 * point of versioning them was lost to a check that could not tell an
 * untouched default from an edit. It can tell now (see `isUnedited`), so
 * the rule is the one R-01 and U-06 always implied together: EO owns the
 * text it wrote, you own the text you wrote, and neither overwrites the
 * other.
 *
 * Runs at startup, so instructions take effect on the next dispatch and
 * never underneath a run already in flight.
 */
export function syncRolePrompts(db: Db, dir = promptsDir): PromptSyncReport {
  const updated: string[] = [];
  const customised: string[] = [];

  for (const agent of listAgents(db)) {
    // A deleted agent's instructions were cleared on purpose (EO-350);
    // refilling them would be bringing it back.
    if (agent.deletedAt !== null) continue;
    const prompt = loadRolePrompt(agent.role, dir);
    if (!prompt) continue;

    const hash = promptHash(prompt);
    if (agent.instructions === prompt) {
      // Already current. Record provenance if this build is the first to
      // keep any, so the next version can recognise it without leaning
      // on the historical set.
      if (agent.promptHash !== hash) updateAgent(db, agent.id, { instructions: prompt, promptHash: hash });
      continue;
    }

    if (!isUnedited(agent)) {
      customised.push(agent.role);
      continue;
    }

    updateAgent(db, agent.id, { instructions: prompt, promptHash: hash });
    updated.push(agent.role);
  }

  return { updated, customised };
}
