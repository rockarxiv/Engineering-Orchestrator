import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  AssistModuleChangeSchema,
  ModuleChangeEditArgsSchema,
  ModuleChangeFreezeArgsSchema,
  ModuleChangePrepareArgsSchema,
  ModuleChangeSchema,
  uuidv7,
  type AgentWriteAnswer,
  type AssistModuleChange,
  type Item,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getItem, getModule, getModuleChangeProposal, getRun, insertModuleChangeProposal, listModuleTests } from "../db/repos/index.js";
import { ASSIST_ACTION, ASSIST_STEP, SCENARIO_ACTION, SCENARIO_STEP } from "./conversationSteps.js";
import { canonical, changeBaseOf, drawModuleChange, sameManifest, type ChangeBase } from "./moduleChange.js";
import { scenarioModuleIdOf } from "./scenario.js";

/**
 * Preparing a change to an existing module once, and naming it by id
 * (EO-813).
 *
 * An assistant or scenario turn that proposes a change used to restate
 * the module's whole code — and any test it changed — inside its final
 * answer. Here it stages the module as it is saved, edits only what it
 * changes, and freezes the result into EO's database; the answer then
 * names the proposal's id.
 *
 * What this file holds to:
 *
 *   * **Nothing it does changes the module.** Staging reads the catalog;
 *     freezing writes one `module_change_proposals` row. The module's
 *     code, manifest, test cases, history and approval are untouched, and
 *     neither `saveModule` nor any approval path is reached from here.
 *     Apply, on the card, is still the only way in.
 *   * **A frozen proposal is its own copy.** The row holds the whole
 *     code, manifest and cases as they were read; the staging files can
 *     be edited or swept afterwards and the row says what it said.
 *   * **Bound to the run that made it.** A staging area belongs to one run
 *     on one conversation, and a proposal to that conversation and run.
 *     Who may stage what is the room's rule: the assistant's chat any
 *     module in the catalog, with its test cases; a scenario chat its own
 *     module, and code and manifest alone — it writes cases directly.
 *   * **Files only from the staging area.** A path is relative to the
 *     staging directory, may not leave it or pass through a symbolic link,
 *     and is held to a size limit. This is not a way to read the disk.
 *
 * The staging areas are this process's alone and are kept in memory: a
 * run's go when it ends, and whatever a crash left is swept at start.
 * Nothing stored names a path.
 */

/** The largest staged file read or written, in bytes. A module several times larger than any EO has seen. */
export const MAX_STAGED_FILE_BYTES = 1024 * 1024;
/** The most a freeze reads across every file, in bytes. */
export const MAX_FROZEN_BYTES = 4 * 1024 * 1024;
/** The most staging areas one run may hold at once. */
export const MAX_STAGINGS_PER_RUN = 20;

/** The staged module's files, by the name the turn is given. */
export const STAGED_CODE_FILE = "module.js";
export const STAGED_MANIFEST_FILE = "manifest.json";
const STAGED_TESTS_DIR = "tests";

/** Where the staging areas are made: `~/.eo/module-staging`, beside the no-disk directories. */
export function defaultModuleStagingRoot(): string {
  return join(homedir(), ".eo", "module-staging");
}

/** Which room a turn is in, which decides what it may stage. */
export type ModuleChangeRoom = "assist" | "scenario";

/** Which turn is asking: the conversation it is on and its run. */
export interface ModuleChangeCaller {
  itemId: string;
  runId: string;
}

/** A frozen proposal, read back for the conversation and run that may use it. */
export interface ModuleChangeProposal {
  id: string;
  itemId: string;
  runId: string;
  room: ModuleChangeRoom;
  /** The change, in the shape the help chat's card takes; a scenario proposal's `tests` and `removeTests` are empty. */
  change: AssistModuleChange;
  /** What it was prepared against, as `applyModuleChange` reads a recorded base. */
  base: ChangeBase;
  createdAt: number;
}

export type ResolvedModuleChangeProposal = { ok: true; proposal: ModuleChangeProposal } | { ok: false; reason: string };

interface Staging {
  id: string;
  itemId: string;
  runId: string;
  moduleId: string;
  room: ModuleChangeRoom;
  /** The hashes of the code and manifest staged: the source version. */
  base: ChangeBase;
  /** The directory as the turn was told it, and what it was when EO made it. */
  directory: StagingAnchor;
}

export interface ModuleChangeStaging {
  prepare: (caller: ModuleChangeCaller, args: unknown) => AgentWriteAnswer;
  edit: (caller: ModuleChangeCaller, args: unknown) => AgentWriteAnswer;
  freeze: (caller: ModuleChangeCaller, args: unknown) => AgentWriteAnswer;
  /** Removes a run's staging areas — its proposals stay. Called when the run ends. */
  releaseRun: (runId: string) => void;
  /** Removes every staging area, kept or abandoned. Called at start, when none can be in use. */
  sweep: () => void;
}

const refused = (code: string, problem: string): AgentWriteAnswer => ({ ok: false, code, problem });

/** The room a run's turn is in, or null when it is in neither chat that may propose a module change. */
function roomOf(db: Db, caller: ModuleChangeCaller): { room: ModuleChangeRoom; item: Item } | null {
  const item = getItem(db, caller.itemId as Item["id"]);
  const run = getRun(db, caller.runId as Item["id"]);
  if (!item || !run || run.itemId !== item.id) return null;
  if (run.action === ASSIST_ACTION && item.stepId === ASSIST_STEP) return { room: "assist", item };
  if (run.action === SCENARIO_ACTION && item.stepId === SCENARIO_STEP) return { room: "scenario", item };
  return null;
}

const NOT_SERVED = "Only a turn in the assistant's chat or a module's scenario chat may prepare a module change, so nothing was staged.";

export function createModuleChangeStaging(options: { db: Db; root?: string; now?: () => number }): ModuleChangeStaging {
  const { db } = options;
  const root = resolve(options.root ?? defaultModuleStagingRoot());
  const now = options.now ?? Date.now;
  const stagings = new Map<string, Staging>();

  /** The staging area this caller made, or a refusal that says the same of one that is unknown and one that is another run's. */
  function stagingFor(caller: ModuleChangeCaller, stagingId: string): Staging | AgentWriteAnswer {
    const staging = stagings.get(stagingId);
    if (!staging || staging.itemId !== caller.itemId || staging.runId !== caller.runId) {
      return refused(
        "STAGING_NOT_FOUND",
        `This run prepared no staging area \`${stagingId}\` — an id is good only in the run that prepared it, and staging is cleared when a run ends. Call module_change_prepare again.`,
      );
    }
    return staging;
  }

  function prepare(caller: ModuleChangeCaller, args: unknown): AgentWriteAnswer {
    const parsed = ModuleChangePrepareArgsSchema.safeParse(args);
    if (!parsed.success) return refused("INVALID_ARGUMENT", "module_change_prepare takes `moduleId`, a module's id as modules_list gives it, and nothing else.");
    const room = roomOf(db, caller);
    if (room === null) return refused("TOOL_NOT_SERVED", NOT_SERVED);

    let moduleId = parsed.data.moduleId;
    if (room.room === "scenario") {
      const own = scenarioModuleIdOf(room.item);
      if (own === null) return refused("MODULE_NOT_FOUND", "This scenario chat names no module, so there is nothing to stage.");
      if (moduleId !== undefined && moduleId !== own) {
        return refused("WRONG_MODULE", `A scenario chat changes only its own module (\`${own}\`), so \`${moduleId}\` was not staged.`);
      }
      moduleId = own;
    }
    if (moduleId === undefined) return refused("INVALID_ARGUMENT", "module_change_prepare needs `moduleId` here: the id of the module to change, as modules_list gives it.");

    const module = getModule(db, moduleId);
    if (!module || module.archivedAt !== null) {
      return refused("MODULE_NOT_FOUND", `The catalog holds no module \`${moduleId}\` — use an id modules_list gives — so nothing was staged.`);
    }
    if ([...stagings.values()].filter((staging) => staging.runId === caller.runId).length >= MAX_STAGINGS_PER_RUN) {
      return refused("TOO_MANY_STAGINGS", `This run already holds ${MAX_STAGINGS_PER_RUN} staging areas. Freeze or reuse one you prepared instead of preparing another.`);
    }

    const id = uuidv7();
    const directory = join(root, id);
    const tests = room.room === "assist" ? listModuleTests(db, module.id) : [];
    let anchor: StagingAnchor;
    try {
      mkdirSync(join(directory, STAGED_TESTS_DIR), { recursive: true, mode: 0o700 });
      anchor = anchorOf(directory);
      writeStaged(anchor.real, STAGED_CODE_FILE, module.code);
      writeStaged(anchor.real, STAGED_MANIFEST_FILE, `${canonical(module.manifest, 2)}\n`);
      for (const test of tests) writeStaged(anchor.real, testFile(test.id), test.source);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      return refused("STAGING_FAILED", `EO could not stage ${module.name}, so nothing was staged: ${error instanceof Error ? error.message : String(error)}`);
    }
    stagings.set(id, { id, itemId: caller.itemId, runId: caller.runId, moduleId: module.id, room: room.room, base: changeBaseOf(module), directory: anchor });

    const files = [STAGED_CODE_FILE, STAGED_MANIFEST_FILE, ...tests.map((test) => testFile(test.id))];
    const testLines = tests.map((test) => `- \`${testFile(test.id)}\`: “${test.description}” (id ${test.id})`);
    const text = [
      `EO staged ${module.name} (\`${module.slug}\`) as it is saved, under staging id ${id}, in ${directory}. Nothing about the module has changed.`,
      `Its code is \`${STAGED_CODE_FILE}\` and its manifest \`${STAGED_MANIFEST_FILE}\`.` +
        (room.room === "assist" ? (tests.length > 0 ? ` Its test cases are:\n${testLines.join("\n")}` : " It has no test cases.") : ""),
      "Change only what the change needs, with module_change_edit — or your own file tools, inside that directory — and leave the rest as it is. " +
        "Then call module_change_freeze with this staging id and a summary" +
        (room.room === "assist" ? ", plus `tests` to add or replace (each with `source` or a staged `file`) and `removeTests`, the ids of cases to delete" : "") +
        ". It answers with a proposal id for your answer to name.",
    ].join("\n\n");
    return { ok: true, text, data: { stagingId: id, moduleId: module.id, directory, files, tests: tests.map((test) => ({ id: test.id, description: test.description, file: testFile(test.id) })) } };
  }

  function edit(caller: ModuleChangeCaller, args: unknown): AgentWriteAnswer {
    const parsed = ModuleChangeEditArgsSchema.safeParse(args);
    if (!parsed.success) {
      return refused("INVALID_ARGUMENT", "module_change_edit takes `stagingId`, `file` (a staged file's path) and either `edits` ([{ old_text, new_text }]) or `content`, and nothing else.");
    }
    if (roomOf(db, caller) === null) return refused("TOOL_NOT_SERVED", NOT_SERVED);
    const staging = stagingFor(caller, parsed.data.stagingId);
    if ("ok" in staging) return staging;
    const { file, edits, content } = parsed.data;

    let text: string;
    if (content !== undefined) {
      text = content;
    } else {
      const read = readStaged(staging.directory, file);
      if (!read.ok) return refused("FILE_REFUSED", read.problem);
      text = read.text;
      for (const [index, { old_text, new_text }] of (edits ?? []).entries()) {
        const at = text.indexOf(old_text);
        if (at === -1 || text.indexOf(old_text, at + 1) !== -1) {
          return refused(
            "EDIT_NOT_UNIQUE",
            `Edit ${index + 1}'s \`old_text\` occurs ${at === -1 ? "nowhere" : "more than once"} in \`${file}\` as the edits before it left it, so nothing was changed. Quote the text exactly, with enough around it to be unique.`,
          );
        }
        text = text.slice(0, at) + new_text + text.slice(at + old_text.length);
      }
    }
    const written = writeStagedChecked(staging.directory, file, text);
    if (!written.ok) return refused("FILE_REFUSED", written.problem);
    return { ok: true, text: `EO changed \`${file}\` in staging ${staging.id}. Nothing about the module has changed.`, data: { stagingId: staging.id, file, bytes: Buffer.byteLength(text, "utf8") } };
  }

  function freeze(caller: ModuleChangeCaller, args: unknown): AgentWriteAnswer {
    const parsed = ModuleChangeFreezeArgsSchema.safeParse(args);
    if (!parsed.success) {
      return refused(
        "INVALID_ARGUMENT",
        `module_change_freeze takes \`stagingId\`, \`summary\` and, in the assistant's chat, \`tests\` and \`removeTests\`: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    const room = roomOf(db, caller);
    if (room === null) return refused("TOOL_NOT_SERVED", NOT_SERVED);
    const staging = stagingFor(caller, parsed.data.stagingId);
    if ("ok" in staging) return staging;
    const { summary, tests, removeTests } = parsed.data;
    if (staging.room === "scenario" && (tests.length > 0 || removeTests.length > 0)) {
      return refused("INVALID_ARGUMENT", "A scenario chat's change carries code and manifest alone — this chat writes test cases directly — so nothing was frozen. Leave out `tests` and `removeTests`.");
    }

    const module = getModule(db, staging.moduleId);
    if (!module || module.archivedAt !== null) return refused("MODULE_NOT_FOUND", "The module this staging area holds is no longer in the catalog, so nothing was frozen.");
    const current = changeBaseOf(module);
    if (current.code !== staging.base.code || current.manifest !== staging.base.manifest) {
      return refused("STALE_STAGING", `${module.name} has been saved since it was staged, so nothing was frozen. Call module_change_prepare again and make the change against it as it is now.`);
    }

    let budget = MAX_FROZEN_BYTES;
    const take = (file: string): { ok: true; text: string } | { ok: false; problem: string } => {
      const read = readStaged(staging.directory, file);
      if (!read.ok) return read;
      budget -= Buffer.byteLength(read.text, "utf8");
      if (budget < 0) return { ok: false, problem: `Together the files this freeze reads are more than ${MAX_FROZEN_BYTES} bytes, which is far beyond any module.` };
      return read;
    };
    const code = take(STAGED_CODE_FILE);
    if (!code.ok) return refused("FILE_REFUSED", `${code.problem} Nothing was frozen.`);
    const manifestText = take(STAGED_MANIFEST_FILE);
    if (!manifestText.ok) return refused("FILE_REFUSED", `${manifestText.problem} Nothing was frozen.`);
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText.text);
    } catch (error) {
      return refused("INVALID_MANIFEST", `\`${STAGED_MANIFEST_FILE}\` is not JSON (${error instanceof Error ? error.message : String(error)}), so nothing was frozen. Fix it with module_change_edit.`);
    }
    const cases: { description: string; source: string }[] = [];
    for (const test of tests) {
      if (test.source !== undefined) {
        cases.push({ description: test.description, source: test.source });
        continue;
      }
      const read = take(test.file!);
      if (!read.ok) return refused("FILE_REFUSED", `${read.problem} Nothing was frozen.`);
      cases.push({ description: test.description, source: read.text });
    }

    // The room's own shape, as its answer schema holds a change to:
    // the same rules, so a frozen change is one a card could carry inline.
    const candidate = {
      summary,
      code: code.text,
      manifest: sameManifest(module.manifest, manifest) ? null : manifest,
      moduleId: module.id,
      tests: cases,
      removeTests,
    };
    const shaped = staging.room === "assist" ? AssistModuleChangeSchema.safeParse(candidate) : ModuleChangeSchema.safeParse(candidate);
    if (!shaped.success) {
      const problems = shaped.error.issues.map((issue) => `${issue.path.length > 0 ? `\`${issue.path.join(".")}\`: ` : ""}${issue.message}`).join("; ");
      return refused("INVALID_CHANGE", `The staged change does not hold to a module change's rules, so nothing was frozen: ${problems}.`);
    }
    const change: AssistModuleChange = { tests: [], removeTests: [], moduleId: module.id, ...shaped.data };
    const drawn = drawModuleChange(db, module, change, staging.room === "assist" ? { tests: change.tests, removeTests: change.removeTests, requireCases: true } : {});
    if (!drawn.ok) return refused("INVALID_CHANGE", `EO did not freeze this proposal. ${drawn.reason}`);

    const id = uuidv7();
    insertModuleChangeProposal(db, {
      id,
      itemId: caller.itemId,
      runId: caller.runId,
      moduleId: module.id,
      room: staging.room,
      summary: change.summary,
      code: change.code,
      manifest: change.manifest,
      tests: change.tests,
      removeTests: change.removeTests,
      base: drawn.base,
      createdAt: now(),
    });
    const codeBytes = Buffer.byteLength(change.code, "utf8");
    return {
      ok: true,
      text:
        `EO froze this change to ${module.name} as proposal ${id}. It is kept whole — later edits to the staging files do not change it — and nothing about the module has changed: ` +
        "it is applied only when the person presses Apply on the card. Name this proposal id in your answer instead of restating the code.",
      data: {
        proposalId: id,
        moduleId: module.id,
        codeChanged: change.code !== module.code,
        manifestChanged: change.manifest !== null,
        tests: change.tests.length,
        removeTests: change.removeTests.length,
        codeBytes,
      },
    };
  }

  function releaseRun(runId: string): void {
    for (const staging of [...stagings.values()]) {
      if (staging.runId !== runId) continue;
      stagings.delete(staging.id);
      // rmSync removes a link put in the directory's place, not what it leads to.
      rmSync(staging.directory.path, { recursive: true, force: true });
    }
  }

  function sweep(): void {
    stagings.clear();
    rmSync(root, { recursive: true, force: true });
  }

  return { prepare, edit, freeze, releaseRun, sweep };
}

/**
 * A frozen proposal, for the conversation and run that may use it (EO-813)
 * — what a card is drawn from and applies.
 *
 * Refused, with a sentence to post, when the id is unknown, belongs to
 * another conversation or run, or is for another module than the one the
 * caller names. An unknown id and another conversation's read the same, so
 * the answer says nothing about what other conversations hold.
 */
export function resolveModuleChangeProposal(
  db: Db,
  proposalId: string,
  expected: { itemId: string; runId?: string; moduleId?: string },
): ResolvedModuleChangeProposal {
  const row = getModuleChangeProposal(db, proposalId);
  if (!row || row.itemId !== expected.itemId) {
    return { ok: false, reason: `This conversation holds no module-change proposal \`${proposalId}\`, so there is nothing to show or apply.` };
  }
  if (expected.runId !== undefined && row.runId !== expected.runId) {
    return { ok: false, reason: `Proposal \`${proposalId}\` was frozen by another turn of this conversation, so this one cannot name it. Nothing was saved.` };
  }
  if (expected.moduleId !== undefined && row.moduleId !== expected.moduleId) {
    return { ok: false, reason: `Proposal \`${proposalId}\` is a change to another module than the one named, so there is nothing to show or apply.` };
  }
  const change = AssistModuleChangeSchema.safeParse({
    summary: row.summary,
    code: row.code,
    manifest: row.manifest,
    moduleId: row.moduleId,
    tests: row.tests,
    removeTests: row.removeTests,
  });
  const base = row.base;
  if (!change.success || base === null || typeof base !== "object" || (row.room !== "assist" && row.room !== "scenario")) {
    return { ok: false, reason: `Proposal \`${proposalId}\` could not be read back whole, so there is nothing to show or apply.` };
  }
  return { ok: true, proposal: { id: row.id, itemId: row.itemId, runId: row.runId, room: row.room, change: change.data, base: base as ChangeBase, createdAt: row.createdAt } };
}

// ── The staging area's files ──────────────────────────────────

function testFile(testId: string): string {
  return `${STAGED_TESTS_DIR}/${testId}.js`;
}

/** O_NOFOLLOW where the platform has it, so the last component is never followed if it is a link. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * A staging directory, held to what it was when EO made it (EO-813): the
 * path the turn was told, the path with every link on the way resolved,
 * and the directory's own device and inode.
 *
 * The boundary is this, and not whatever the path resolves to when a file
 * is asked for — otherwise a turn could move the directory aside, put a
 * link to anywhere in its place, and have that be the boundary.
 */
export interface StagingAnchor {
  path: string;
  real: string;
  dev: number;
  ino: number;
}

/** Records a directory EO has just made. It must be a directory, not a link to one. */
export function anchorOf(directory: string): StagingAnchor {
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) throw new Error(`${directory} is not a directory`);
  return { path: directory, real: realpathSync(directory), dev: stat.dev, ino: stat.ino };
}

/**
 * Whether the staging directory is still the one EO made: not replaced by
 * a link or another directory, and reached by the same real path — so
 * neither it nor any directory above it has been swapped for a link.
 */
function anchorHolds(anchor: StagingAnchor): boolean {
  try {
    const at = lstatSync(anchor.path);
    if (!at.isDirectory() || at.dev !== anchor.dev || at.ino !== anchor.ino) return false;
    if (realpathSync(anchor.path) !== anchor.real) return false;
    const real = lstatSync(anchor.real);
    return real.isDirectory() && real.dev === anchor.dev && real.ino === anchor.ino;
  } catch {
    return false;
  }
}

const MOVED = "The staging directory is no longer the one EO made — it was moved, replaced or reached through a link — so EO will not read or write in it. Call module_change_prepare again.";

/**
 * The absolute path of a file named relative to a staging directory, or
 * why it is not one: absolute, climbing out with `..`, resolving outside
 * the directory once every link on the way is followed, or the directory
 * itself no longer the one EO made.
 */
export function stagedPath(anchor: StagingAnchor, file: string): { ok: true; path: string } | { ok: false; problem: string } {
  const outside = { ok: false as const, problem: `\`${file}\` is not a file in the staging directory: name it relative to that directory, as module_change_prepare does.` };
  if (file.includes("\0") || isAbsolute(file) || /^[a-zA-Z]:/.test(file)) return outside;
  const normalised = normalize(file);
  if (normalised === "." || normalised.split(/[\\/]/).includes("..")) return outside;
  if (!anchorHolds(anchor)) return { ok: false, problem: MOVED };
  // Taken from the real path EO recorded, never from what the path resolves to now.
  const path = resolve(anchor.real, normalised);
  if (!path.startsWith(anchor.real + sep)) return outside;
  // Every directory on the way resolved, so a linked directory cannot carry the path out.
  try {
    const parent = realpathSync(resolve(path, ".."));
    if (parent !== anchor.real && !parent.startsWith(anchor.real + sep)) return outside;
  } catch {
    return { ok: false, problem: `\`${file}\` is not in the staging directory.` };
  }
  return { ok: true, path };
}

/**
 * After a file is opened: the boundary still holds, and the file opened is
 * the one at the checked path — so a link swapped in between the check and
 * the open is caught before anything is read or written through it.
 */
function openedInside(anchor: StagingAnchor, file: string, path: string, fd: number): boolean {
  const again = stagedPath(anchor, file);
  if (!again.ok || again.path !== path) return false;
  try {
    const opened = fstatSync(fd);
    const there = lstatSync(path);
    return opened.isFile() && there.isFile() && opened.dev === there.dev && opened.ino === there.ino;
  } catch {
    return false;
  }
}

/** A staged file's text, read through the boundary and the size limit. */
function readStaged(anchor: StagingAnchor, file: string): { ok: true; text: string } | { ok: false; problem: string } {
  const at = stagedPath(anchor, file);
  if (!at.ok) return at;
  let stat;
  try {
    stat = lstatSync(at.path);
  } catch {
    return { ok: false, problem: `\`${file}\` is not in the staging directory.` };
  }
  if (stat.isSymbolicLink()) return { ok: false, problem: `\`${file}\` is a symbolic link, and EO reads only plain files from the staging directory.` };
  if (!stat.isFile()) return { ok: false, problem: `\`${file}\` is not a file.` };
  let fd: number;
  try {
    fd = openSync(at.path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return { ok: false, problem: `\`${file}\` could not be opened as a plain file in the staging directory.` };
  }
  try {
    if (!openedInside(anchor, file, at.path, fd)) return { ok: false, problem: MOVED };
    const size = fstatSync(fd).size;
    if (size > MAX_STAGED_FILE_BYTES) return { ok: false, problem: `\`${file}\` is ${size} bytes, over the ${MAX_STAGED_FILE_BYTES}-byte limit for a staged file.` };
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const got = readSync(fd, buffer, read, size - read, read);
      if (got === 0) break;
      read += got;
    }
    return { ok: true, text: buffer.subarray(0, read).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** Writes a staged file EO itself lays out, in the directory it has just made. */
function writeStaged(directory: string, file: string, text: string): void {
  const fd = openSync(join(directory, file), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Writes a file a turn named, through the boundary and the size limit. */
function writeStagedChecked(anchor: StagingAnchor, file: string, text: string): { ok: true } | { ok: false; problem: string } {
  if (Buffer.byteLength(text, "utf8") > MAX_STAGED_FILE_BYTES) return { ok: false, problem: `That would make \`${file}\` larger than the ${MAX_STAGED_FILE_BYTES}-byte limit for a staged file, so nothing was changed.` };
  // No directory is made for it: one made through a linked directory
  // would be made outside. A new file goes beside the staged ones.
  const at = stagedPath(anchor, file);
  if (!at.ok) return at;
  try {
    const stat = lstatSync(at.path, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return { ok: false, problem: `\`${file}\` is a symbolic link, and EO writes only plain files in the staging directory.` };
    if (stat !== undefined && !stat.isFile()) return { ok: false, problem: `\`${file}\` is not a file.` };
    // Not truncated as it is opened: only once the file opened is known to be inside.
    const fd = openSync(at.path, constants.O_WRONLY | constants.O_CREAT | NOFOLLOW, 0o600);
    try {
      if (!openedInside(anchor, file, at.path, fd)) return { ok: false, problem: MOVED };
      ftruncateSync(fd, 0);
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { ok: false, problem: `\`${file}\` could not be written: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true };
}
