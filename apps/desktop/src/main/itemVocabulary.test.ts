import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * Where the word "ticket" is still written down, after KAN-145 renamed
 * the entity to `item` everywhere else.
 *
 * This is the story's own acceptance criterion made executable. The
 * criterion is a shell command —
 *
 * ```
 * grep -riw ticket --include=*.ts --include=*.tsx packages apps/desktop/src \
 *   | grep -v packs/developer | grep -v mcpHost/catalog | grep -v 'ctx.ticket'
 * ```
 *
 * — and the list it returns is checked in beside this file, so that what
 * is left is something a reviewer reads once rather than something each
 * of us re-derives.
 *
 * ## What the three exclusions are
 *
 * - The developer pack keeps the word, because that is its own
 *   vocabulary (`ARCHITECTURE.md`, "What a pack labels"). The core's word is
 *   `item`; a pack labels its own types, and phase 6 (KAN-119) is what
 *   makes the UI read the label.
 * - `mcpHost/catalog` describes the MCP tools `ticket_get`,
 *   `ticket_move`, `tickets_list` and `work_submit_ticket`, whose names
 *   external clients have registered against. The names stay this
 *   release and so does the prose describing them.
 * - `ctx.ticket()` is the module host's, called by user-authored,
 *   approved-by-hash modules.
 *
 * KAN-162 gave the last two `item_*` twins rather than renaming them, so
 * both spellings resolve for one release and both are still written
 * down here; the first is permanent.
 *
 * ## What is in the list, and what must never be
 *
 * Three kinds of thing, and nothing else.
 *
 * **Words a person or an agent reads** — button labels, the sentences EO
 * posts into a thread, the prompt the engine assembles, the guides the
 * MCP host serves, and the test lines that assert on them. That is
 * deliberate. The story's other criterion is that "the renderer shows
 * exactly what it showed before for a developer project", and
 * the design says a developer notices nothing
 * until phase 6 — so this rename moved every identifier, every column,
 * every channel and every comment, and moved no words a person sees.
 *
 * **The MCP wire** — `mcpHost/legacyNames.ts` and the tests around it.
 * The tool names stayed, so the arguments those tools take and the shape
 * they answer with stayed too; that file is the table translating
 * between EO's vocabulary and the one clients registered against. KAN-145
 * left a note here saying the alias story would delete it, and KAN-162
 * did not: a table that went away would take the *answers* with it, and
 * a client that registered against `ticket_get` reads `ticketId` out of
 * what comes back. What KAN-162 added is an `item_*` twin per tool, and
 * `ToolSpelling` saying which vocabulary a tool *advertises* its
 * arguments in — whose two values are the two vocabularies' own names,
 * so `"ticket"` appears there as a *value on the wire* rather than as a
 * word for the entity. Both halves of a pair answer in the legacy
 * spelling, because a pair that answered two ways would be two tools.
 * A key spelled `ticket` in that file is the external contract written
 * down, not a rename that was missed — and the story that retires the
 * aliases is what removes it.
 *
 * **The developer pack's own vocabulary, as data** — the entries in
 * `packages/core/src/registry/developer.ts` that say the pack calls one
 * of its items a "Ticket", the field on `PackVocabulary` documenting
 * what such an entry holds, and the module that decides when the chrome
 * uses a pack's word instead of the core's (EO-309, ARCHITECTURE.md, "What a pack labels"). These
 * are
 * outside `packs/developer` only because the developer pack's registry
 * still lives in `packages/core` until phase 7 moves it; they are the
 * excluded path's contents by any other measure. What changed with them
 * is that the *renderer* no longer writes the word down at all: the
 * lines this list used to hold for `Sidebar.tsx`, `Archive.tsx`,
 * `ItemList.tsx` and `Inbox.tsx` are gone, because those screens read a
 * label now. That is the direction of travel, and a line reappearing in
 * a renderer file is the thing to refuse.
 *
 * **A database from before the rename** — the fixtures in
 * `db/migrate.test.ts` that seed a row in the shape 0068 has to convert,
 * and the prose explaining what that shape was. A migration test cannot
 * be written in the vocabulary the migration produces; if these read
 * `item` they would be proving nothing.
 *
 * What must never appear here is an *internal* identifier in live code:
 * a variable, a type, a column, an IPC channel, a query key. If the
 * snapshot grows one of those, something was missed rather than kept,
 * and the fix is to rename it rather than to update the snapshot.
 *
 * The list carries no line numbers, on purpose: an edit above a line
 * would otherwise churn it, and the reviewer's question is *which words*
 * are left, not where.
 */
const ROOTS = ["packages", join("apps", "desktop", "src")];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "out", ".turbo", "coverage", "__snapshots__"]);

/** `grep -v` on the path, matching the acceptance criterion's own filters. */
const EXCLUDED_PATHS = [join("packs", "developer"), join("mcpHost", "catalog")];

/** `grep -v 'ctx.ticket'` — the module host's contract, line by line. */
const EXCLUDED_LINES = ["ctx.ticket"];

/**
 * `grep -iw ticket`. JavaScript's `\b` counts `_` as a word character
 * exactly as grep's does, which is what keeps `ticket_detail` and
 * `work_submit_ticket` out of the list without naming them.
 */
const BARE_WORD = /\bticket\b/i;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

function remainingMentions(): string[] {
  const lines = new Set<string>();
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(repoRoot, root))) {
      const key = relative(repoRoot, file).split(sep).join("/");
      if (EXCLUDED_PATHS.some((excluded) => key.includes(excluded.split(sep).join("/")))) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!BARE_WORD.test(line)) continue;
        if (EXCLUDED_LINES.some((excluded) => line.includes(excluded))) continue;
        lines.add(`${key}: ${line.trim()}`);
      }
    }
  }
  return [...lines].sort();
}

describe("the word that is left after tickets became items (KAN-145)", () => {
  it("is only words a person or an agent reads, and the list is checked in", async () => {
    await expect(remainingMentions().join("\n") + "\n").toMatchFileSnapshot(join(dirname(fileURLToPath(import.meta.url)), "itemVocabulary.txt"));
  });

  /**
   * The check above is only worth having if it would notice. `grep -w`
   * is a narrow instrument — it passes over `itemId`, `items`, and
   * `ticket_detail` alike — so this pins the one thing it does catch:
   * the bare word, wherever it is written.
   */
  it("would catch the bare word, in either case, and steps over the compound forms", () => {
    expect(BARE_WORD.test("the ticket moved")).toBe(true);
    expect(BARE_WORD.test("A Ticket here")).toBe(true);
    expect(BARE_WORD.test("PER-TICKET")).toBe(true);
    expect(BARE_WORD.test("ticketId")).toBe(false);
    expect(BARE_WORD.test("tickets")).toBe(false);
    expect(BARE_WORD.test("ticket_detail")).toBe(false);
    expect(BARE_WORD.test("work_submit_ticket")).toBe(false);
  });
});
