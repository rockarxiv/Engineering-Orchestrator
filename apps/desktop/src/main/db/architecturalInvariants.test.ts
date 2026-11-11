import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSrcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Only this file may write items.stepId — see its own doc comment.
const ALLOWED_FILE = join(mainSrcRoot, "db", "repos", "transitionsRepo.ts");

/**
 * Every `.set({...})` that belongs to an `.update(items)` call.
 *
 * The invariant (#1) is specifically about the `stepId` column — where the
 * item sits — not about the items table as a whole: editing a title or
 * body is ordinary, and U-03 needs it. The original check banned
 * `.update(items)` outright, which was a fine proxy while no legitimate
 * edit existed and became too coarse the moment one did. This looks at what
 * is actually written, so a step write is caught wherever it hides.
 *
 * The column was `state` until KAN-52 renamed it. Matching the old name
 * would have made this check silently vacuous rather than failing loudly,
 * which is the one thing an invariant test must never do.
 */
function itemUpdatePayloads(source: string): string[] {
  return [...source.matchAll(/\.update\(items\)[\s\S]{0,200}?\.set\(([\s\S]*?)\)\s*\n?\s*\./g)].map((match) => match[1] ?? "");
}

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function findItemStateWriters(root: string, allowedFile: string): string[] {
  return walkTsFiles(root)
    .filter((file) => file !== allowedFile)
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      if (!source.includes(".update(items)")) return false;
      // A spread payload could carry `stepId` invisibly, so treat it as a
      // write too — the point is that a reviewer must be able to see, at
      // the call site, that the item's step is not being touched.
      return itemUpdatePayloads(source).some((payload) => /\bstepId\b/.test(payload) || payload.includes("..."));
    })
    .map((file) => relative(root, file));
}

describe("architectural invariant: items.stepId has exactly one writer", () => {
  it("no file other than transitionsRepo.ts writes items.stepId in the real source tree", () => {
    expect(findItemStateWriters(mainSrcRoot, ALLOWED_FILE)).toEqual([]);
  });

  it("the scanner catches a state write, and allows an ordinary field edit (proves it's not a tautology)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "eo-invariant-check-"));
    try {
      writeFileSync(join(tempDir, "sneaky.ts"), 'db.update(items).set({ stepId: "elsewhere" }).run();');
      writeFileSync(join(tempDir, "spread.ts"), "db.update(items).set({ ...patch }).run();");
      const allowed = join(tempDir, "allowed.ts");
      writeFileSync(allowed, 'db.update(items).set({ stepId: "ok" }).run();');
      writeFileSync(join(tempDir, "innocent.ts"), 'db.update(agents).set({ enabled: false }).run();');
      // The case U-03 introduced: editing an item's own text is fine.
      writeFileSync(join(tempDir, "titleEdit.ts"), 'db.update(items).set({ title, body }).run();');

      const offenders = findItemStateWriters(tempDir, allowed);

      expect(offenders.sort()).toEqual(["sneaky.ts", "spread.ts"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * The tables that are records rather than state, and the one file
 * allowed to remove a row from any of them.
 *
 * `run_events` is invariant #3's own subject and `transitions` has
 * always been held to the same rule beside it; `job_occurrences` joins
 * them (EO-304, `ARCHITECTURE.md`, "What a job records") because an
 * occurrence's whole value is that it says what happened at a moment
 * that has passed. A `skipped` row that could be updated to `fired`, or
 * quietly deleted, is a job that never ran and nothing left to say so.
 *
 * `job_events` is the fourth (EO-332, ARCHITECTURE.md, "What a job records", "Webhooks"), and the
 * rule bites hardest there: an event that is *held* is
 * waiting to be released, which is exactly the shape that wants a
 * status column somebody updates. It does not get one. The tick writes
 * a second row, `created`, carrying the same event key, and the first
 * goes on saying what happened when the delivery arrived — so "thirty
 * were held at 09:00 and let through over the next three hours" stays
 * readable afterwards instead of being overwritten into "thirty were
 * created".
 *
 * `itemsRepo.ts` is the exemption and it is invariant #3's own: deleting
 * the item itself (KAN-30) is a person asking for it to be gone rather
 * than a rewrite of what happened while it existed. An occurrence is not
 * in that cascade — its `item_id` deliberately carries no foreign key so
 * the firing outlives the item — so `job_occurrences` has no exempt file
 * at all. The one way an occurrence is ever removed is the person
 * deleting the whole job, which the schema's cascade does and no
 * TypeScript asks for.
 *
 * `skill_versions` is the fifth (EO-714): every write to a skill, with
 * its author, is what makes an agent's write to one accountable and
 * restorable. A version rewritten or removed is a write nobody can see
 * was made. Restoring one files a new version; no file is exempt, and
 * the only way a row goes is its skill being deleted outright, which the
 * schema's cascade does.
 */
const APPEND_ONLY: Readonly<Record<string, readonly string[]>> = {
  runEvents: [join("db", "repos", "itemsRepo.ts")],
  transitions: [join("db", "repos", "itemsRepo.ts")],
  jobOccurrences: [],
  jobEvents: [],
  skillVersions: [],
};

/**
 * Every file that updates or deletes one of those tables, minus the
 * files allowed to.
 *
 * Text rather than types, for the reason the scanner above is text: what
 * matters is whether a reviewer can see, at the call site, that nothing
 * is rewriting the record — and a query built up through a helper still
 * spells `.update(runEvents)` where it is issued.
 *
 * An update is refused everywhere, with no exemption at all. Removing a
 * row is something a person can ask for; changing what one says is not
 * something anybody can ask for.
 */
function findRecordRewriters(root: string, allowed: Readonly<Record<string, readonly string[]>>): string[] {
  const offenders: string[] = [];
  for (const file of walkTsFiles(root)) {
    const source = readFileSync(file, "utf8");
    const path = relative(root, file);
    for (const [table, exempt] of Object.entries(allowed)) {
      if (source.includes(`.update(${table})`)) offenders.push(`${path}: update(${table})`);
      if (!source.includes(`.delete(${table})`)) continue;
      if (exempt.includes(path)) continue;
      offenders.push(`${path}: delete(${table})`);
    }
  }
  return offenders.sort();
}

/**
 * Every statement in a migration that would rewrite `run_events` rows:
 * an UPDATE of it, a DELETE from it, or dropping or emptying it (EO-555).
 *
 * The source scanner above reads `.update(runEvents)` in TypeScript; a
 * migration is SQL, and is just as able to rewrite the substrate, so it
 * is read too. Adding an index, as 0140 does, is not a write of a row.
 */
function migrationRecordRewrites(sql: string, table = "run_events"): string[] {
  const statement = new RegExp(
    `\\b(update\\s+(?:or\\s+\\w+\\s+)?|delete\\s+from\\s+|drop\\s+table\\s+(?:if\\s+exists\\s+)?|replace\\s+into\\s+|insert\\s+or\\s+replace\\s+into\\s+)[\`"[]?${table}\\b`,
    "gi",
  );
  return [...sql.replace(/--[^\n]*/g, "").matchAll(statement)].map((match) => match[0].replace(/\s+/g, " ").toLowerCase());
}

/**
 * The one migration that removes `run_events` rows, and it is
 * `itemsRepo.ts`'s exemption above (invariant #3's own): 0167 deletes the
 * project and job threads outright (EO-730), so it deletes whatever an
 * agent mentioned on one ran there, as `deleteItem` would — the item
 * being gone, not a rewrite of what happened while it existed.
 */
const MIGRATIONS_DELETING_ITEMS: readonly string[] = ["0167_retire_threads.sql: delete from `run_events"];

describe("architectural invariant: a record is never rewritten", () => {
  it("no migration updates, deletes or drops run_events rows (EO-555)", () => {
    const migrations = join(mainSrcRoot, "db", "migrations");
    const offenders = readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .flatMap((name) => migrationRecordRewrites(readFileSync(join(migrations, name), "utf8")).map((found) => `${name}: ${found}`))
      .filter((found) => !MIGRATIONS_DELETING_ITEMS.includes(found));
    expect(offenders).toEqual([]);
    // And the reader is not a tautology.
    expect(migrationRecordRewrites("UPDATE `run_events` SET payload = '{}';\nDELETE FROM run_events WHERE seq > 3;\nCREATE INDEX `idx_run_events_x` ON `run_events` (`ts`);")).toEqual([
      "update `run_events",
      "delete from run_events",
    ]);
    expect(migrationRecordRewrites("-- never UPDATE run_events\nCREATE INDEX `idx_runs_item` ON `runs` (`item_id`);")).toEqual([]);
  });

  it("no migration updates, deletes or drops skill_versions rows (EO-714)", () => {
    const migrations = join(mainSrcRoot, "db", "migrations");
    const offenders = readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .flatMap((name) => migrationRecordRewrites(readFileSync(join(migrations, name), "utf8"), "skill_versions").map((found) => `${name}: ${found}`));
    expect(offenders).toEqual([]);
    // Filing the history the migration starts from is an insert, not a rewrite.
    expect(migrationRecordRewrites("INSERT INTO `skill_versions` (`id`) VALUES ('a');\nUPDATE skill_versions SET body = '';", "skill_versions")).toEqual([
      "update skill_versions",
    ]);
  });

  it("nothing updates run_events, transitions, job_occurrences, job_events or skill_versions, and only deleting an item removes a row", () => {
    expect(findRecordRewriters(mainSrcRoot, APPEND_ONLY)).toEqual([]);
  });

  it("the scanner catches a rewrite of each of them (proves it's not a tautology)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "eo-append-only-check-"));
    try {
      writeFileSync(join(tempDir, "tidy.ts"), "db.delete(jobOccurrences).where(eq(jobOccurrences.status, \"skipped\")).run();");
      writeFileSync(join(tempDir, "release.ts"), 'db.update(jobEvents).set({ outcome: "created" }).run();');
      writeFileSync(join(tempDir, "promote.ts"), 'db.update(jobOccurrences).set({ status: "fired" }).run();');
      writeFileSync(join(tempDir, "rewrite.ts"), 'db.update(runEvents).set({ payload: {} }).run();');
      writeFileSync(join(tempDir, "forget.ts"), "db.delete(transitions).where(eq(transitions.itemId, id)).run();");
      writeFileSync(join(tempDir, "history.ts"), 'db.update(skillVersions).set({ body: "" }).run();\ndb.delete(skillVersions).run();');
      // The sanctioned one, at the path the real exemption names.
      mkdirSync(join(tempDir, "db", "repos"), { recursive: true });
      writeFileSync(join(tempDir, "db", "repos", "itemsRepo.ts"), "tx.delete(runEvents).where(inArray(runEvents.runId, runIds)).run();");
      // And something that is not one of these tables at all.
      writeFileSync(join(tempDir, "innocent.ts"), "db.delete(comments).where(eq(comments.id, id)).run();");

      expect(findRecordRewriters(tempDir, APPEND_ONLY)).toEqual([
        "forget.ts: delete(transitions)",
        "history.ts: delete(skillVersions)",
        "history.ts: update(skillVersions)",
        "promote.ts: update(jobOccurrences)",
        "release.ts: update(jobEvents)",
        "rewrite.ts: update(runEvents)",
        "tidy.ts: delete(jobOccurrences)",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * The one file allowed to *ask* for a transition (EO-322,
 * `ARCHITECTURE.md`, "The record").
 *
 * The scanner above proves there is one writer of `items.stepId`. That
 * was enough while there was one process: the supervisor and the IPC
 * commands each called `transitionItem` and each of them was, in
 * effect, the record. Two desktops and a server would be three
 * schedulers and three callers of the same writer, and a lock around
 * the function would not help — what has to be single is the *role*,
 * not the statement.
 *
 * So the record is the only caller. A device that ran an agent, and a
 * person who dragged a card, send a transition command and the record
 * applies it. This proves the second half of invariant #1 the same way
 * the file proves the first: by reading the source rather than trusting
 * the arrangement.
 */
const TRANSITION_CALLERS_ALLOWED = [
  // The writer itself, whose own doc comment is the first half.
  join("db", "repos", "transitionsRepo.ts"),
  // The record, and `applyTransition` is the door.
  join("record", "localRecord.ts"),
];

/**
 * …and with the record on a server, the list is unchanged (EO-324).
 *
 * That is the claim this story had to keep, and the reason the
 * allowance above did not grow a line. A desktop signed in to an
 * organisation writes `items.step_id` in exactly one circumstance: the
 * record decided a move, and this machine is mirroring the decision
 * into its replica. Both halves of that go through the same door —
 * `remoteRecord.applyTransition` calls the local record's, and
 * `drain.ts` mirrors the record's answer through the same one — so
 * `localRecord.ts` remains the only file in the tree that names
 * `transitionItem`, and the scanner below proves it rather than this
 * paragraph asserting it.
 *
 * What moved is the *deciding*, and the scanner after it is what holds
 * that: the engine's scheduler has exactly one caller, and it is the
 * record.
 */

/**
 * The one file allowed to run the scheduler (EO-324, the original design: "the record
 * owns item state and **runs the only scheduler**").
 *
 * The other half of invariant #1, and the half that had no test until
 * this story because it had no way to be false. `tick()` in
 * `packages/engine` is the scheduler: give it the board and it answers
 * what may be dispatched. While there was one process, it did not much
 * matter who called it — the answer was the same answer and there was
 * one writer downstream of it either way.
 *
 * With two desktops and a server it matters completely. A device that
 * picked for itself would be a second scheduler: it would decide
 * against a replica, which is a copy and not an authority, and it would
 * decide *differently* — a stale board, a lease it cannot see, a guard
 * the record applies and it does not. Two schedulers over one record is
 * two agents in one checkout, which is the failure the lease exists to
 * prevent and which a lease alone cannot prevent if both ends are
 * choosing.
 *
 * So the supervisor asks (`ItemRecord.offerWork`) and the record
 * answers, and this is what stops the asking quietly becoming choosing
 * again. The import is what is matched: a file that does not import the
 * scheduler cannot run it, and a file that does is visible here.
 */
const SCHEDULER_CALLERS_ALLOWED = [join("record", "localRecord.ts")];

/**
 * Every file that imports the engine's `tick`.
 *
 * Read as source text, like every other scanner here, and matched on
 * the import rather than the call for a reason: `tick` is a four-letter
 * word this codebase uses for several things — the supervisor's own
 * `runTickOnce`, the outbox's drain loop, a schedule interval — and a
 * scanner matching the *name* would catch all of them. What is
 * unambiguous is where it came from.
 */
function findSchedulerCallers(root: string, allowed: readonly string[]): string[] {
  return walkTsFiles(root)
    .filter((file) => !allowed.includes(relative(root, file)))
    .filter((file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@eo\/engine"/g)].some((match) =>
        /(^|[,{\s])tick(\s|,|$|\s+as\s)/.test(match[1] ?? ""),
      );
    })
    .map((file) => relative(root, file))
    .sort();
}

describe("architectural invariant: the record runs the only scheduler", () => {
  it("nothing but the record imports the engine's tick in the real source tree", () => {
    expect(findSchedulerCallers(mainSrcRoot, SCHEDULER_CALLERS_ALLOWED)).toEqual([]);
  });

  it("the scanner catches a second scheduler and ignores the word elsewhere (proves it's not a tautology)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "eo-scheduler-check-"));
    try {
      writeFileSync(join(tempDir, "sneaky.ts"), 'import { tick } from "@eo/engine";\nexport const d = tick(input);');
      writeFileSync(join(tempDir, "renamed.ts"), 'import { tick as schedule, type Dispatch } from "@eo/engine";\nexport const d = schedule(input);');
      // The words that are not the scheduler: this app's own tick loop,
      // a drain on an interval, and a type whose name merely contains it.
      writeFileSync(join(tempDir, "loop.ts"), "function tick() {}\nsetInterval(() => void tick(), 5000);");
      writeFileSync(join(tempDir, "types.ts"), 'import { type TickInput, dispatchBlocker } from "@eo/engine";\nexport type T = TickInput<never>;');
      // The record's own, at the path the real allowance names.
      mkdirSync(join(tempDir, "record"), { recursive: true });
      writeFileSync(join(tempDir, "record", "localRecord.ts"), 'import { tick as schedule } from "@eo/engine";');

      expect(findSchedulerCallers(tempDir, [join("record", "localRecord.ts")])).toEqual(["renamed.ts", "sneaky.ts"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * Source with its comments taken out.
 *
 * Necessary here and not above, because this scanner matches a *name*
 * rather than a statement shape, and the name is written all over the
 * prose: a dozen comments explain what `transitionItem()` is, and the
 * repository-search pack ships `grep -rn transitionItem .` as its
 * worked example of a search. Every one of those would be an offender
 * to a scanner that read comments, and a test that fails on a sentence
 * is a test the next person deletes.
 *
 * A small state machine rather than a regular expression, because the
 * two quote-or-comment cases each contain the other: `// a string with
 * "quotes"` and `"a string with // in it"` are both ordinary, and a
 * pattern that strips one mangles the other.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const char = source[i]!;
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      i++;
      while (i < source.length && source[i] !== char) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      out += char;
      i++;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

function findTransitionCallers(root: string, allowed: readonly string[]): string[] {
  return walkTsFiles(root)
    .filter((file) => !allowed.includes(relative(root, file)))
    .filter((file) => /\btransitionItem\s*\(/.test(stripComments(readFileSync(file, "utf8"))))
    .map((file) => relative(root, file))
    .sort();
}

describe("architectural invariant: the record is the only caller of the transition writer", () => {
  it("nothing but the record asks for a transition in the real source tree", () => {
    expect(findTransitionCallers(mainSrcRoot, TRANSITION_CALLERS_ALLOWED)).toEqual([]);
  });

  it("the scanner catches a caller and ignores the name in prose (proves it's not a tautology)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "eo-record-writer-check-"));
    try {
      writeFileSync(join(tempDir, "sneaky.ts"), 'transitionItem(db, { itemId, toStepId: "elsewhere", actor: "human" });');
      writeFileSync(join(tempDir, "spaced.ts"), "await transitionItem (db, input);");
      // What the real tree is full of, and what a comment-blind scanner
      // would fail on: the name explained, and the name as an example
      // inside a string.
      writeFileSync(join(tempDir, "prose.ts"), "// Only `transitionItem()` writes stepId.\n/** See transitionItem(db, input). */\nexport const HELP = 'try: grep -rn transitionItem .';");
      // The record's own call, at the path the real allowance names.
      mkdirSync(join(tempDir, "record"), { recursive: true });
      writeFileSync(join(tempDir, "record", "localRecord.ts"), "applyTransition: (command) => transitionItem(db, command),");
      // And a file that merely passes the name along without calling it.
      writeFileSync(join(tempDir, "barrel.ts"), 'export { transitionItem } from "./transitionsRepo.js";');

      expect(findTransitionCallers(tempDir, [join("record", "localRecord.ts")])).toEqual(["sneaky.ts", "spaced.ts"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
