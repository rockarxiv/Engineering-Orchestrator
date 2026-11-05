import { createHash } from "node:crypto";
import { ModuleManifestSchema, type CustomModule, type ModuleChange, type ModuleTestCase } from "@eo/core";
import type { Db } from "../db/client.js";
import { deleteModuleTest, getModule, getModuleTest, listModuleTests, pairedWithExisting, putModuleTests, saveModule } from "../db/repos/index.js";

/**
 * A change to a module that already exists, as a card with Apply on it
 * (EO-356, EO-418).
 *
 * Two chats raise one — a module's scenario chat and the help chat — and
 * this is the part neither may do differently from the other: how the
 * card is drawn, what it is recorded as having been drawn against, and
 * what Apply writes. Which conversation a card belongs to, and which
 * module a change is for, stay with the room that knows
 * (`roles/scenario.ts`, `roles/assist.ts`).
 *
 * The rule the whole file serves: **what is applied is what was shown.**
 * The card is a diff against the module as it is saved when the card is
 * posted; the hashes of that code and that manifest are kept beside the
 * card; and Apply refuses when either no longer matches, because writing
 * a change over somebody else's edit would discard that edit without
 * anybody having seen the two side by side. A case the card removes is
 * held to the same rule (EO-499): what it was when the card was drawn is
 * recorded beside it, and Apply refuses when it has gone or been edited.
 */

/** A test case a change adds or replaces — the two fields an author writes. */
export interface ChangeTestCase {
  description: string;
  source: string;
}

/**
 * What a change does to a module's test cases, beside its code and
 * manifest — the help chat's to say (EO-418, EO-499). The scenario chat's
 * change carries none of it.
 */
export interface ChangeCases {
  /** Cases to add or replace, matched by description. */
  tests?: readonly ChangeTestCase[];
  /** Ids of the module's cases to delete. */
  removeTests?: readonly string[];
  /**
   * Refuse a change that would leave the module with no test cases, which
   * is a module that can never be approved again (EO-499) — whatever the
   * change does, removals or not, so a code fix to a module that already
   * has none is refused too. The help chat's rule; the scenario chat,
   * whose job is to write a module's cases, does not ask it.
   */
  requireCases?: boolean;
}

/** The cases a module would hold after a change: those it keeps once its removals are gone, plus those the change adds. */
function casesAfter(kept: readonly ModuleTestCase[], tests: readonly ChangeTestCase[]): number {
  return kept.length + pairedWithExisting(kept, tests).filter(({ replaces }) => replaces === undefined).length;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A value as JSON with its keys in one order, so two manifests that say the same thing compare equal however each was written. */
export function canonical(value: unknown, indent?: number): string {
  return JSON.stringify(
    value,
    (_key, entry: unknown) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : entry,
    indent,
  );
}

/**
 * A manifest with every default written in, or the value as it is when
 * it is not a manifest at all.
 *
 * What two manifests are compared as. A manifest saved before `needs`
 * gained a flag does not carry it, and one an agent returns through the
 * schema always does — so compared as stored, restating a module's own
 * manifest would read as a change to it, be drawn as a diff of lines
 * nobody altered, and withdraw an approval over nothing.
 */
function withDefaults(manifest: unknown): unknown {
  const parsed = ModuleManifestSchema.safeParse(manifest);
  return parsed.success ? parsed.data : manifest;
}

/** Do two manifests say the same thing, however each was written and whichever defaults each spelled out? */
export function sameManifest(a: unknown, b: unknown): boolean {
  return canonical(withDefaults(a)) === canonical(withDefaults(b));
}

// ── What a card was drawn against ─────────────────────────────

/** The hashes of the code and manifest a card was drawn against. */
export interface ChangeBase {
  code: string;
  manifest: string;
  /**
   * Each test case the card removes, by id, as it was when the card was
   * drawn (EO-499): its description, to name it when Apply refuses, and
   * the hash of its description and source. Absent when it removes none.
   */
  removes?: Record<string, RemovedCaseBase>;
}

/** A case a card removes, as the card was drawn against it. */
export interface RemovedCaseBase {
  description: string;
  case: string;
}

/** The hash a removed case is recorded under: its description and its source together. */
function caseHash(test: { description: string; source: string }): string {
  return sha256(canonical([test.description, test.source]));
}

export function changeBaseOf(module: Pick<CustomModule, "code" | "manifest">): ChangeBase {
  return { code: sha256(module.code), manifest: sha256(canonical(module.manifest)) };
}

/**
 * A recorded base, read back.
 *
 * Two shapes, because cards outlive the build that posted them: before
 * EO-418 a scenario card recorded the hash of the code alone, as a bare
 * string, and such a card must still apply. Its change carried no
 * manifest and writes none, so there is no manifest for it to have been
 * drawn against — `manifest: null` says exactly that, and the manifest
 * is then not compared.
 */
function readChangeBase(recorded: unknown): { code: string; manifest: string | null; removes: Record<string, RemovedCaseBase> } | null {
  if (typeof recorded === "string" && recorded !== "") return { code: recorded, manifest: null, removes: {} };
  if (recorded === null || typeof recorded !== "object" || Array.isArray(recorded)) return null;
  const { code, manifest, removes } = recorded as Record<string, unknown>;
  if (typeof code !== "string" || code === "") return null;
  return { code, manifest: typeof manifest === "string" && manifest !== "" ? manifest : null, removes: readRemovedCases(removes) };
}

/** The removed cases a card recorded, keeping only entries that say both things one has to. */
function readRemovedCases(recorded: unknown): Record<string, RemovedCaseBase> {
  if (recorded === null || typeof recorded !== "object" || Array.isArray(recorded)) return {};
  const read: Record<string, RemovedCaseBase> = {};
  for (const [id, entry] of Object.entries(recorded as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { description, case: hash } = entry as Record<string, unknown>;
    if (typeof description === "string" && typeof hash === "string" && hash !== "") read[id] = { description, case: hash };
  }
  return read;
}

// ── The diff ──────────────────────────────────────────────────

/** Past this many lines a side, a diff is not computed; the card shows the new text whole instead. */
const MAX_DIFF_LINES = 4000;
/** Unchanged lines kept around each change, as `diff -u` keeps three. */
const DIFF_CONTEXT = 3;

/** A fence that the text inside it cannot close. */
function fence(text: string, info = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${info}\n${text}\n${ticks}`;
}

/**
 * A unified diff of two versions of a text, as a ```diff block.
 *
 * A longest-common-subsequence walk, which is exact and fine at module
 * sizes; past `MAX_DIFF_LINES` a side, the new text is shown whole rather
 * than a diff nobody could compute in reasonable time.
 */
function renderDiff(before: string, after: string, whole: { label: string; info: string }): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return `${whole.label}\n\n${fence(after, whole.info)}`;

  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  type Op = { tag: " " | "-" | "+"; text: string; aLine: number; bLine: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ tag: " ", text: a[i]!, aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // A removal before the addition that replaces it, as `diff -u` reads.
      ops.push({ tag: "-", text: a[i]!, aLine: i + 1, bLine: j });
      i++;
    } else {
      ops.push({ tag: "+", text: b[j]!, aLine: i, bLine: j + 1 });
      j++;
    }
  }

  const changed = ops.map((op, index) => (op.tag === " " ? -1 : index)).filter((index) => index !== -1);
  if (changed.length === 0) return "_No line changes._";

  // Hunks: each change with its context, merged where they touch.
  const hunks: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - DIFF_CONTEXT);
    const end = Math.min(ops.length - 1, index + DIFF_CONTEXT);
    const last = hunks.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }

  const body = hunks.map(([start, end]) => {
    const slice = ops.slice(start, end + 1);
    const first = slice[0]!;
    const aStart = first.tag === "+" ? first.aLine + 1 : first.aLine;
    const bStart = first.tag === "-" ? first.bLine + 1 : first.bLine;
    const aCount = slice.filter((op) => op.tag !== "+").length;
    const bCount = slice.filter((op) => op.tag !== "-").length;
    return [`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...slice.map((op) => `${op.tag}${op.text}`)].join("\n");
  });
  return fence(body.join("\n"), "diff");
}

/** A unified diff of two versions of a module's code, as a ```diff block. */
export function renderCodeDiff(before: string, after: string): string {
  return renderDiff(before, after, { label: "The whole module after the change:", info: "js" });
}

/**
 * A unified diff of two manifests, as a ```diff block.
 *
 * Both written out the same way first — every default in, keys in one
 * order, two spaces — so the lines that differ are the ones that say
 * something different, and removing two names from `needs.env` reads as
 * two removed lines rather than as a manifest rewritten.
 */
export function renderManifestDiff(before: unknown, after: unknown): string {
  return renderDiff(canonical(withDefaults(before), 2), canonical(withDefaults(after), 2), { label: "The whole manifest after the change:", info: "json" });
}

// ── Drawing the card ──────────────────────────────────────────

export type DrawnModuleChange = { ok: true; body: string; base: ChangeBase } | { ok: false; reason: string };

/** A sentence listing the problems zod found with a manifest, each with where it is. */
function manifestProblems(manifest: unknown): string | null {
  const parsed = ModuleManifestSchema.safeParse(manifest);
  if (parsed.success) return null;
  return parsed.error.issues.map((issue) => `${issue.path.length > 0 ? `\`${issue.path.join(".")}\`: ` : ""}${issue.message}`).join("; ");
}

/**
 * The card a person reads before applying a change to a module, or why
 * there is no card to offer.
 *
 * Drawn against the module as it is saved at this moment: the summary, a
 * diff of the code, a diff of the manifest, the test cases the change
 * adds, replaces or removes, and what Apply will do — which, for an
 * approved module, includes losing its approval: any change to its code,
 * its manifest or its test cases withdraws it (EO-498).
 *
 * Refused, with the reason as a sentence the caller posts as a rejection
 * (invariant #8) and nothing to apply:
 *
 *   * the module is not in the catalog — never was, or has been deleted;
 *   * the manifest the change carries is not a valid manifest. A reply
 *     carrying one fails its output schema and is sent back to the agent
 *     before it gets here (`ModuleChangeSchema`), so this is the same
 *     check asked a second time, on the line that would put a button on
 *     it — for a result that reached this function by some other road;
 *   * it removes a test case, by id, that the module does not hold
 *     (EO-499) — an id from another module, a deleted case, or one never
 *     given by `module_tests_list`;
 *   * with `requireCases`, it would leave the module with no test cases at
 *     all — by removing them, or by changing a module that has none and
 *     adding none — which is a module that can never be approved again:
 *     approving is what runs them, and it refuses a module with none;
 *   * the change is what is saved already — the same code, the same
 *     manifest, and no test case that would be written or removed.
 *
 * Writes nothing. Reading the module's test cases to say which a listed
 * case replaces, and which it removes, is the only thing it asks of the
 * database.
 */
export function drawModuleChange(
  db: Db,
  module: CustomModule | undefined,
  change: ModuleChange,
  cases: ChangeCases = {},
): DrawnModuleChange {
  const { tests = [], removeTests = [], requireCases = false } = cases;
  if (!module || module.archivedAt !== null) {
    return {
      ok: false,
      reason:
        "A change to a module was proposed, but the catalog holds no module with that id — it may have been deleted, or the id is not one " +
        "`modules_list` gives — so there is nothing to apply it to. Nothing was saved.",
    };
  }

  // Already held to this by the reply's schema. Asked again here rather
  // than taken on trust, since this is the line that offers Apply.
  const invalid = change.manifest === null ? null : manifestProblems(change.manifest);
  if (invalid !== null) {
    return {
      ok: false,
      reason:
        `A change to ${module.name} was proposed, but the manifest it carries is not a valid manifest, so there is nothing to apply: ${invalid}. ` +
        "Nothing was saved. Ask for the change again and it can be proposed with a manifest that is.",
    };
  }

  const had = listModuleTests(db, module.id);
  const removal = removalOf(had, removeTests);
  if (removal.unknown.length > 0) {
    return {
      ok: false,
      reason:
        `A change to ${module.name} was proposed, but it removes ${removal.unknown.length === 1 ? "a test case" : "test cases"} ${module.name} does not hold ` +
        `(${removal.unknown.map((id) => `\`${id}\``).join(", ")}) — a case is removed by the id \`module_tests_list\` gives for this module — so there is nothing to apply. ` +
        "Nothing was saved.",
    };
  }

  // What `putModuleTests` will pair the listed cases with: the cases left
  // once the removals are deleted, which Apply does first.
  const paired = pairedWithExisting(removal.kept, tests);
  if (requireCases && casesAfter(removal.kept, tests) === 0) {
    const how = removal.removed.length > 0 ? "it removes every test case the module has and adds none" : `${module.name} has no test cases and it adds none`;
    return {
      ok: false,
      reason:
        `A change to ${module.name} was proposed, but ${how}, so it would leave the module with no test cases and there is nothing to apply: ` +
        "a module with no test cases could not be approved again, since approving it is what runs them. Nothing was saved. " +
        (removal.removed.length > 0
          ? "Keep at least one case, or list the case that takes their place in the same change."
          : "List at least one case for it in `tests` in the same change."),
    };
  }

  const codeChanged = change.code !== module.code;
  const manifestChanged = change.manifest !== null && !sameManifest(module.manifest, change.manifest);
  const testsChanged = removal.removed.length > 0 || paired.some(({ given, replaces }) => replaces === undefined || replaces.source !== given.source);
  if (!codeChanged && !manifestChanged && !testsChanged) {
    return {
      ok: false,
      reason:
        `A change to ${module.name} was proposed, but what it proposes is the module as it is already saved — the same code` +
        `${change.manifest === null ? "" : ", the same manifest"}${tests.length === 0 ? "" : ", and test cases it already has"} — so there is nothing to apply.`,
    };
  }

  const parts = [`**Proposed change to ${module.name}** (\`${module.slug}\`)`, "", change.summary];
  parts.push("", "**Code**", "", codeChanged ? renderCodeDiff(module.code, change.code) : "_The code is left as it is._");
  parts.push("", "**Manifest**", "", manifestChanged ? renderManifestDiff(module.manifest, change.manifest) : "_The manifest is left as it is._");

  if (tests.length > 0 || removal.removed.length > 0) {
    // The pairing `putModuleTests` makes: the oldest case of that description not yet taken.
    const lines = paired.map(({ given, replaces }) => {
      if (replaces === undefined) return `- Adds “${given.description}”`;
      return replaces.source === given.source ? `- Keeps “${given.description}” as it is` : `- Replaces “${given.description}”`;
    });
    for (const removed of removal.removed) lines.push(`- Removes “${removed.description}”`);
    parts.push("", "**Test cases**", "", ...lines, "", "Cases not listed here are kept as they are.");
  }

  const saves = [codeChanged ? "the code" : null, manifestChanged ? "the manifest" : null, testsChanged ? "the test cases above" : null].filter(
    (entry): entry is string => entry !== null,
  );
  // A change to the cases alone withdraws it too (EO-498): approving is
  // what runs them, and these are not the cases that were run.
  const withdraws = module.approvedAt !== null && (codeChanged || manifestChanged || testsChanged);
  parts.push(
    "",
    `Nothing is saved until you apply it. Applying saves ${list(saves)}, keeps the code it has now in its history, and re-runs its tests.` +
      (withdraws
        ? ` It also withdraws the module's approval, so steps that run ${module.name} stop until it is approved again.`
        : module.approvedAt === null
          ? " It is not approved now, and stays that way until you approve it."
          : ""),
  );

  const base: ChangeBase = changeBaseOf(module);
  if (removal.removed.length > 0) {
    base.removes = Object.fromEntries(removal.removed.map((test) => [test.id, { description: test.description, case: caseHash(test) }]));
  }
  return { ok: true, body: parts.join("\n"), base };
}

/**
 * The cases a change removes, read against the module's cases: those it
 * holds, in the order given and each once; the ids it does not hold; and
 * the cases left once they are gone.
 */
function removalOf(had: readonly ModuleTestCase[], removeTests: readonly string[]): { removed: ModuleTestCase[]; unknown: string[]; kept: ModuleTestCase[] } {
  const byId = new Map(had.map((test) => [test.id, test]));
  const ids = [...new Set(removeTests)];
  const removed = ids.map((id) => byId.get(id)).filter((test): test is ModuleTestCase => test !== undefined);
  const gone = new Set(removed.map((test) => test.id));
  return { removed, unknown: ids.filter((id) => !byId.has(id)), kept: had.filter((test) => !gone.has(test.id)) };
}

/** "a", "a and b", "a, b and c". */
function list(entries: readonly string[]): string {
  if (entries.length <= 1) return entries[0] ?? "nothing";
  return `${entries.slice(0, -1).join(", ")} and ${entries.at(-1)!}`;
}

// ── Applying it ───────────────────────────────────────────────

export type AppliedModuleChange =
  | {
      ok: true;
      module: CustomModule;
      /** Whether the module was approved before this was applied. */
      wasApproved: boolean;
      /**
       * Whether applying withdrew that approval — read from the module as
       * it stands once the cases are written too, since a change to the
       * test cases alone withdraws it (EO-498).
       */
      approvalWithdrawn: boolean;
      /** What was actually written: the cases added or replaced, and the cases removed (EO-499). */
      saved: { code: boolean; manifest: boolean; tests: number; removed: number };
    }
  | { ok: false; reason: string };

/** A test case the change listed could not be written; carries why, out of the transaction. */
class ChangeRefused extends Error {}

/**
 * Saves what a change card proposed — the person having pressed Apply.
 *
 * Refused, with nothing written, when the module is no longer what the
 * card was drawn against: its code, or its manifest, has a different
 * hash from the one recorded beside the card; or a case the card removes
 * has been deleted since, or had its description or source edited
 * (EO-499) — removing a case somebody has just rewritten would discard
 * that rewrite unseen, exactly as writing over edited code would.
 *
 * Then one transaction through `saveModule`, the save Settings makes:
 * the card's code and manifest onto that module, with its `slug`, its
 * name and description and its `source` exactly as they were. That
 * function files the version, so the code it had is in its history, and
 * withdraws approval when the code or the manifest changed. The listed
 * cases it removes are deleted first, and the listed test cases go in
 * after them, matched by description as a corrected module's are
 * (`putModuleTests`, EO-401); a case added, replaced or removed
 * withdraws the approval as well (EO-498) — a case that cannot be written
 * takes the save back out with it, because a change applied without the
 * cases it was shown with is not the change on the card.
 *
 * Whether this card may still be applied at all — newest wins, not yet
 * applied — is the caller's, through `approvableIds`, which every room
 * shares.
 */
export function applyModuleChange(
  db: Db,
  module: CustomModule,
  change: ModuleChange,
  recordedBase: unknown,
  cases: ChangeCases = {},
): AppliedModuleChange {
  const { tests = [], removeTests = [], requireCases = false } = cases;
  const base = readChangeBase(recordedBase);
  const now = changeBaseOf(module);
  const codeMoved = base === null || base.code !== now.code;
  const manifestMoved = base !== null && base.manifest !== null && base.manifest !== now.manifest;
  if (codeMoved || manifestMoved) {
    const what = codeMoved && manifestMoved ? "code and manifest have" : manifestMoved ? "manifest has" : "code has";
    return {
      ok: false,
      reason: `${module.name}'s ${what} changed since this was proposed, so applying it would overwrite that edit. Ask for the change again against the module as it is now.`,
    };
  }

  const removing = [...new Set(removeTests)];
  const movedCases: string[] = [];
  for (const id of removing) {
    const drawn = base?.removes[id];
    const held = getModuleTest(db, id);
    const current = held !== undefined && held.moduleId === module.id ? held : undefined;
    if (drawn === undefined) movedCases.push(`${current ? `“${current.description}”` : `the case \`${id}\``} was not on the card as it was drawn`);
    else if (current === undefined) movedCases.push(`“${drawn.description}” has been deleted`);
    else if (caseHash(current) !== drawn.case) movedCases.push(`“${drawn.description}” has been edited`);
  }
  if (movedCases.length > 0) {
    return {
      ok: false,
      reason:
        `${module.name}'s test cases have changed since this was proposed — ${list(movedCases)} — so applying it would remove a case nobody saw as it is now. ` +
        "Nothing was saved. Ask for the change again against the module as it is now.",
    };
  }
  // Asked again here, against the cases as they are now: a case the card
  // kept may have been deleted since it was drawn — the last one, even,
  // on a change that removes nothing.
  if (requireCases && casesAfter(listModuleTests(db, module.id).filter((test) => !removing.includes(test.id)), tests) === 0) {
    return {
      ok: false,
      reason: `Applying this would leave ${module.name} with no test cases, and a module with none could not be approved again. Nothing was saved.`,
    };
  }

  // The module's own manifest object where the change says nothing new
  // about it, so a restatement that only orders its keys differently is
  // not read by `saveModule` as an edit.
  //
  // And held to a manifest's rules again, on the line that writes one:
  // the card was drawn only from a manifest that passed, but what is
  // saved is read back from the run, and nothing that is not a manifest
  // is ever put where a run will enforce it.
  const proposed = change.manifest === null ? null : ModuleManifestSchema.safeParse(change.manifest);
  if (proposed !== null && !proposed.success) {
    return { ok: false, reason: `The manifest this change carries is not a valid manifest, so nothing was saved: ${manifestProblems(change.manifest)}.` };
  }
  const manifestChanged = proposed !== null && !sameManifest(module.manifest, proposed.data);
  const manifest = manifestChanged ? proposed.data : module.manifest;
  const codeChanged = change.code !== module.code;

  let written = 0;
  try {
    return db.transaction((): AppliedModuleChange => {
      const saved = saveModule(db, {
        id: module.id,
        slug: module.slug,
        name: module.name,
        description: module.description,
        code: change.code,
        manifest,
        originalScript: module.originalScript,
        source: module.source,
      });
      if (!saved.ok) return { ok: false, reason: saved.reason };

      // Removed before the listed cases are written, as the card paired
      // them: against the cases left once these are gone.
      let removed = 0;
      for (const id of removing) {
        if (deleteModuleTest(db, id) === null) throw new ChangeRefused(`the case \`${id}\` is no longer there to remove.`);
        removed += 1;
      }

      if (tests.length > 0) {
        const before = new Map(listModuleTests(db, module.id).map((test) => [test.id, test.source]));
        for (const put of putModuleTests(db, module.id, tests)) {
          // Thrown so the transaction rolls the module back with it.
          if (!put.ok) throw new ChangeRefused(put.reason);
          if (before.get(put.test.id) !== put.test.source) written += 1;
        }
      }

      // After the cases, not from `saved`: writing them is the other
      // thing that withdraws an approval (EO-498).
      const after = getModule(db, module.id) ?? saved.module;
      return {
        ok: true,
        module: after,
        wasApproved: module.approvedAt !== null,
        approvalWithdrawn: module.approvedAt !== null && after.approvedAt === null,
        saved: { code: codeChanged, manifest: manifestChanged, tests: written, removed },
      };
    });
  } catch (error) {
    if (!(error instanceof ChangeRefused)) throw error;
    return { ok: false, reason: `A test case could not be saved with the change, so nothing was: ${error.message}` };
  }
}

/**
 * What a person is told under the card once Apply has run (invariant #8):
 * what was saved, and whether the module's approval was withdrawn.
 */
export function appliedChangeNote(applied: AppliedModuleChange): string {
  if (!applied.ok) return `Not applied. ${applied.reason}`;
  const { module, saved } = applied;
  const what = [
    saved.code ? "code" : null,
    saved.manifest ? "manifest" : null,
    saved.tests > 0 ? `${saved.tests} test case${saved.tests === 1 ? "" : "s"}` : null,
  ].filter((entry): entry is string => entry !== null);
  const verb = what.length === 1 && saved.tests <= 1 ? "is" : "are";
  const approval = applied.approvalWithdrawn
    ? ` Its approval is withdrawn, so steps that run it stop until it is approved again.`
    : applied.wasApproved
      ? " Its approval stands: the code, the manifest and the test cases it was approved with are unchanged."
      : " It was not approved before, and is not now.";
  const removed = saved.removed > 0 ? `${saved.removed} test case${saved.removed === 1 ? " is" : "s are"} removed` : null;
  // A change of removals alone saves no code, manifest or case of its own.
  const done = what.length === 0 && removed !== null ? `${removed} from ${module.name}` : `${module.name}'s ${list(what)} ${verb} saved${removed === null ? "" : `, ${removed}`}`;
  return `Applied. ${done}, and its tests are re-running.${approval}`;
}
