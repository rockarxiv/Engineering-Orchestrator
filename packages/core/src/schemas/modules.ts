import { z } from "zod";

/**
 * A custom module, as it crosses every boundary (KAN-103).
 *
 * One definition, because a module crosses three: IPC when the settings
 * screen saves one, agent output when the architect proposes one
 * (KAN-107), and a file when a pipeline is exported (KAN-108). Three
 * hand-written shapes that had to agree is exactly the arrangement the
 * conventions rule out.
 */

/** One value a step configures when it uses a module. */
export const ModuleInputSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

/**
 * The shape a name in `needs.env` is held to, and the sentence that says
 * so. Exported so a screen that takes a variable's name (EO-417) refuses
 * a bad one in the words the manifest does, before anything is sent.
 */
export const MODULE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MODULE_ENV_NAME_MESSAGE = "Use an environment-variable name: letters, digits and underscores, not starting with a digit.";

/**
 * Everything the module reaches outside itself.
 *
 * Enforced rather than documented: the host refuses a binary absent from
 * `bin` and injects only the variables named in `env` (KAN-105). That is
 * the difference between this and a `needs:` typed beside a shell command,
 * and it is the whole reason a pipeline can be exported.
 */
export const ModuleNeedsSchema = z.object({
  bin: z.array(z.string().min(1)).default([]),
  /**
   * Environment-variable names, held to that shape here.
   *
   * A declared name becomes a filename under the secrets directory, and
   * `fileFor` refuses anything else — by throwing, which is right for a
   * programmer error and wrong as a user-facing outcome. Without this a
   * manifest declaring `FLY-API-TOKEN` saved and approved happily, then
   * parked every item that reached it with an internal message, and
   * could not be fixed: `moduleSecrets:set` enforces the pattern the
   * manifest did not, so the value was unsettable too.
   */
  env: z.array(z.string().regex(MODULE_ENV_NAME_PATTERN, MODULE_ENV_NAME_MESSAGE)).default([]),
  network: z.boolean().default(false),
  /**
   * Whether this module reads EO's items (EO-74).
   *
   * Beside `bin`, `env` and `network` because it belongs to the same
   * question — what does this module touch that is not the worktree —
   * and unlike them it is not enforced. The host hands `ctx.item()`
   * and `ctx.itemByKey()` to every module, declared or not, because a
   * refusal would stop nobody: the host is not a sandbox and `node:fs`
   * already reaches `eo.db`. This makes the intent legible to whoever
   * approves the module, which is where the decision actually is.
   *
   * Defaults to false so every manifest written before this reads as
   * what it was: a module that never asked for an item.
   */
  item: z.boolean().default(false),
  /**
   * Whether this module posts comments (EO-75).
   *
   * Beside `item` and read the same way — the author's word, not a
   * gate. What bounds a module's voice is the per-run cap the host and
   * the parent both apply, not this flag, and nothing here should read
   * as though it were the other way round.
   *
   * Defaults to false so every manifest written before this reads as
   * what it was: a module with nothing to say in the thread.
   */
  comment: z.boolean().default(false),
  /**
   * Whether this module attaches files to its item through
   * `ctx.attach()` (EO-414).
   *
   * Beside `comment` and read the same way — the author's word, not a
   * gate. An attach is a comment with files on it and is bounded as one:
   * it spends one of the run's comments, and the path rules the parent
   * applies are what decide which files may leave the run's directory.
   *
   * Defaults to false so every manifest written before this reads as
   * what it was: a module that puts no file on an item.
   */
  attach: z.boolean().default(false),
  /**
   * Whether this module creates work items through `ctx.createItem()`
   * (EO-433).
   *
   * Beside `comment` and `attach`, and unlike them it **is** enforced:
   * the host refuses the call and the parent refuses the event when the
   * manifest does not say this. Nothing sits between a module and the
   * board — a created item lands on the pipeline it names with no person
   * accepting it first — so the approval of the manifest is the gate,
   * and a gate that is only the author's word is not one.
   *
   * Defaults to false so every manifest written before this reads as
   * what it was: a module that files nothing.
   */
  create: z.boolean().default(false),
});

export const ModuleManifestSchema = z.object({
  name: z.string().min(1),
  /** Required everywhere. See `CustomModule.description` for why. */
  description: z.string().min(1, "A module needs a description — it is how anyone finds it again."),
  inputs: z.record(z.string(), ModuleInputSchema).default({}),
  needs: ModuleNeedsSchema.default({ bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }),
  /**
   * At least one, because a module that declares no result can produce
   * none that routes, and a step whose every outcome is unroutable parks
   * every item that reaches it.
   */
  results: z.array(z.string().min(1)).min(1),
  /**
   * Whether running this module reaches outside EO (EO-334, ARCHITECTURE.md, "A connector is an MCP
   * server with a setup flow").
   *
   * The author's word, like `needs.item` and `needs.comment`, and not a
   * gate: nothing stops a module that says nothing here from sending an
   * email. What it is read for is the one refusal that needs the
   * answer before anything runs — a pipeline a webhook enters and a
   * side-effecting step ends, with nobody asked in between. A payload
   * that arrived from the internet is not something EO can filter, so
   * what a pipeline carrying one is held to is where it can get to.
   *
   * Optional rather than defaulted, so that every manifest written
   * before this reads as what it was: a module nobody had asked the
   * question of. Absent is read as false everywhere, which is the
   * conservative answer for the *refusal* — it refuses less — and the
   * honest one about what the author actually said.
   */
  sideEffects: z.boolean().optional(),
  /**
   * Whether a step may run this module in keep-checking mode (EO-456,
   * ARCHITECTURE.md, "Modules: a step that is a script").
   *
   * A check is asked the same question over and over and answers
   * `waiting` until it has something to report, which is a different
   * contract from running once — so the author says the module was
   * written for it, and `validatePipeline` refuses the mode on a step
   * whose module does not. Optional for `sideEffects`' reason: absent
   * reads as a module that runs once.
   */
  watch: z.boolean().optional(),
  /**
   * Whether this module is an entry check (EO-736, ARCHITECTURE.md,
   * "Entry rules"): a `module` entry rule may name it, and EO runs it
   * against an item as it would enter a pipeline. It answers
   * `{ ok: true, result: "pass" }` or `{ ok: true, result: "refuse",
   * reason }`.
   *
   * Read-only by declaration: approval refuses a manifest that says this
   * and also declares `needs.create`, `needs.comment`, `needs.attach` or
   * `sideEffects` (`entryCheckManifestProblems`). Optional for
   * `sideEffects`' reason: absent reads as a module that is no check.
   */
  entryCheck: z.boolean().optional(),
});

/**
 * A slug is an identifier a person types and an export refers to.
 *
 * Same shape a role is held to (`ProposedAgentSchema.role`), for the same
 * reason: it appears in a step's configuration and in an exported
 * document, so it has to survive both without quoting.
 */
export const MODULE_SLUG_PATTERN = /^[a-z0-9_-]+$/;

/**
 * One test case as it arrives *with* a module rather than on its own
 * (EO-355): from the system agent's proposal, through `module_save`, in
 * an exported pipeline. Only the two fields an author writes — the id,
 * the module and the timestamps are this installation's to mint.
 *
 * The same two rules `ModuleTestSaveInputSchema` holds a case to one at
 * a time, because a case that could not be saved on its own must not be
 * able to arrive in a batch.
 */
export const ModuleTestCaseInputSchema = z.object({
  description: z.string().trim().min(1, "A test case needs a description — it is what the module page lists it by."),
  source: z.string().min(1, "A test case needs source: an ES module whose default export is an async function taking the harness."),
});

export type ModuleTestCaseInput = z.infer<typeof ModuleTestCaseInputSchema>;

export const ModuleSaveInputSchema = z.object({
  /** Absent creates; present edits that module in place. */
  id: z.string().optional(),
  slug: z.string().min(1).regex(MODULE_SLUG_PATTERN, "Use lowercase letters, digits, hyphens and underscores."),
  name: z.string().min(1),
  description: z.string().min(1, "A module needs a description — it is how anyone finds it again."),
  code: z.string().min(1),
  manifest: ModuleManifestSchema,
  originalScript: z.string().nullable().default(null),
  /**
   * Who wrote this. Optional with no default, deliberately.
   *
   * A `.default("user")` here is not a default at all on an edit: it
   * makes `source` always present, so `saveModule`'s "keep what the row
   * had" fallback can never fire and a rename erases the one field
   * saying the code came from the architect or from another machine.
   * Absent means "leave it as it is"; `saveModule` defaults a *new* row.
   */
  source: z.enum(["user", "architect", "import"]).optional(),
  /**
   * Test cases saved with the module, in the same write (EO-355).
   *
   * Optional, so every caller that saves only the code — the Settings
   * editor, an edit of a module that already has its cases — is
   * unchanged. Present, each case is *added*: on a new module that is
   * its whole set, and on an existing one they join the cases it has. A
   * case already there with the same description and source is not
   * added twice, so saving the same module and cases again is a no-op.
   *
   * Never a replacement. Removing a case is `moduleTests:delete`, which
   * the system agent holds as a dangerous tool on its own; a save that
   * could drop the cases it did not repeat would be that deletion
   * without the name.
   */
  tests: z.array(ModuleTestCaseInputSchema).optional(),
  // No `approve` (EO-353). Approving is an explicit act, never a side
  // effect of saving — and since approving runs the module's tests, it
  // is `modules:approve` alone. A save that could carry it would be a
  // way past those tests; `saveModule` clears an approval whenever the
  // code or the manifest changes.
});

/**
 * One thing a module looks like it reaches for that would not survive
 * being exported to another machine (EO-80).
 *
 * Advice rather than a verdict, and the wording of everything that shows
 * it has to keep that clear. What a module may actually import is
 * decided by a loader hook in `moduleHost.mjs`, exactly, at the moment it
 * asks; this is a text scan, so it reads a docstring that says one thing
 * differs `from` a quoted phrase as an import of a package called "CI is
 * unhappy". That misreading used to refuse production runs. It is kept
 * over-eager on purpose now that it cannot: the case it exists for is a
 * dynamic `import()` in a branch nobody has taken yet, which no run and
 * no hook will ever surface, and a pattern narrow enough never to
 * misread prose is narrow enough to miss one.
 */
export const PortabilityWarningSchema = z.object({
  /** The specifier the scan read, verbatim — including when that is a sentence. */
  specifier: z.string(),
  /** Where in `code` it read it, 1-based, so an author does not have to go looking. */
  line: z.number(),
});

/**
 * What kind of machine-specific value the scan in `machineSpecific.ts`
 * read (EO-449).
 *
 * - `machine_path`: a path under a root that only holds on one machine
 *   (`/home/…`, `/Users/…`, `/tmp/…`, `/opt/homebrew/…`).
 * - `windows_path` / `unc_path`: a drive-letter path or a network share.
 * - `home_reference`: `~/`, `$HOME`, `%USERPROFILE%` — somebody's home.
 * - `loopback`: `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`.
 * - `absolute_binary` / `shell_binary`: a manifest `needs.bin` entry
 *   naming a binary by absolute path, or a shell one OS has and another
 *   does not.
 */
export const MachineSpecificKindSchema = z.enum([
  "machine_path",
  "windows_path",
  "unc_path",
  "home_reference",
  "loopback",
  "absolute_binary",
  "shell_binary",
]);

/**
 * Where a machine-specific value was read: a module's code, manifest or
 * test case (EO-449), or a pipeline step's field, an agent's
 * instructions or a skill's body (EO-450).
 */
export const MachineSpecificPlaceSchema = z.discriminatedUnion("in", [
  /** The module's code, 1-based line. */
  z.object({ in: z.literal("code"), line: z.number() }),
  /** One manifest entry, named as an author would look for it: `needs.bin "bash"`. */
  z.object({ in: z.literal("manifest"), entry: z.string() }),
  /** One test case, by its description, and the 1-based line of its source. */
  z.object({ in: z.literal("test"), description: z.string(), line: z.number() }),
  /**
   * One field of a pipeline step (EO-450): the step by its name, the
   * field as an author would look for it — `name`, `instructions
   * summary`, `input "repoPath"` — and the 1-based line, or null when
   * the field's value is a single line and a line number would say nothing.
   */
  z.object({ in: z.literal("step"), step: z.string(), field: z.string(), line: z.number().nullable() }),
  /** An agent's instructions, 1-based line (EO-450). */
  z.object({ in: z.literal("instructions"), line: z.number() }),
  /** A skill's body, 1-based line (EO-450). */
  z.object({ in: z.literal("skill"), line: z.number() }),
]);

/**
 * A value in a module (EO-449), a pipeline step, an agent's
 * instructions or a skill's body (EO-450) that looks like it only holds
 * on the machine it was written on.
 *
 * Advice, never a gate — the same standing `PortabilityWarning` has, and
 * for the same reason: a text scan can be wrong, and nothing about
 * saving, approving or running a module waits on it.
 */
export const MachineSpecificWarningSchema = z.object({
  where: MachineSpecificPlaceSchema,
  /** What the scan matched, verbatim. */
  text: z.string(),
  kind: MachineSpecificKindSchema,
  /** What to use instead, as a phrase: "use ctx.cwd, or take the path as a step input". */
  instead: z.string(),
});

/**
 * One test case of a module (EO-352).
 *
 * Its own record rather than a field on the module, so a case can be
 * written, edited and removed on its own — which is how the system
 * agent works through a scenario one case at a time — and so the
 * description a person reads in a list is a column, not something
 * parsed back out of source.
 *
 * `source` is an ES module held to the import rule a module is held to
 * (Node builtins only, written `node:…`), whose default export is an
 * async function handed the test harness. What the harness offers is
 * documented in the header of `moduleHost.mjs`, which is where it is
 * implemented.
 */
export const ModuleTestCaseSchema = z.object({
  id: z.string(),
  moduleId: z.string(),
  description: z.string(),
  source: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Creating a case, or editing one in place. */
export const ModuleTestSaveInputSchema = z.object({
  /** Absent creates; present edits that case. */
  id: z.string().optional(),
  moduleId: z.string(),
  description: z.string().trim().min(1, "A test case needs a description — it is what the module page lists it by."),
  source: z.string().min(1, "A test case needs source: an ES module whose default export is an async function taking the harness."),
});

/** How one case went. */
export const ModuleTestCaseResultSchema = z.object({
  testId: z.string(),
  /** As it was when the case ran, so a result still reads after the case is edited. */
  description: z.string(),
  passed: z.boolean(),
  /** Why it failed, in the sentence the case, the harness or the time limit gave. Null when it passed. */
  failure: z.string().nullable(),
  /** Wall-clock time the case took, in milliseconds. Time inside a case is faked; this is not. */
  durationMs: z.number(),
  /** The tail of what the case and the module printed: `ctx.log`, `console.log`, scripted exec output. */
  output: z.string(),
});

/** Covered out of countable, and the percentage that makes. */
export const CoverageFigureSchema = z.object({
  covered: z.number(),
  total: z.number(),
  /** 0–100, to one decimal place. */
  percent: z.number(),
});

/**
 * One run of every case a module has (EO-352).
 *
 * Coverage is V8's, measured on the module's code alone — never on the
 * cases' — and aggregated across every case that ran: a line one case
 * reaches and another does not is covered.
 */
export const ModuleTestRunSchema = z.object({
  ranAt: z.number(),
  cases: z.array(ModuleTestCaseResultSchema),
  coverage: z.object({
    lines: CoverageFigureSchema,
    branches: CoverageFigureSchema,
  }),
});

/**
 * The line coverage a module's tests are expected to reach (EO-353), as a
 * percentage.
 *
 * Not a hard block: approving a module under it asks the person to
 * confirm, with the figure in front of them. Every case passing and at
 * least one case existing are the hard part of the rule.
 */
export const MODULE_COVERAGE_BAR = 80;

export type ModuleTestCase = z.infer<typeof ModuleTestCaseSchema>;
export type ModuleTestSaveInput = z.infer<typeof ModuleTestSaveInputSchema>;
export type ModuleTestCaseResult = z.infer<typeof ModuleTestCaseResultSchema>;
export type ModuleTestRun = z.infer<typeof ModuleTestRunSchema>;
export type CoverageFigure = z.infer<typeof CoverageFigureSchema>;

/** What the renderer and the exporter both read. */
export const ModuleViewSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  code: z.string(),
  manifest: ModuleManifestSchema,
  originalScript: z.string().nullable(),
  source: z.enum(["user", "architect", "import"]),
  approvedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
  /** How many steps, across every pipeline, run this module. Derived, never stored. */
  usedByStepCount: z.number(),
  /**
   * What its code looks like it imports that is not a Node builtin.
   *
   * Derived from `code` on every read, never stored — the same
   * arrangement `usedByStepCount` has, and for a sharper reason: a
   * warning kept in a column would go stale the moment somebody edited
   * the module, and stale advice about portability is worse than none.
   */
  portability: z.array(PortabilityWarningSchema),
  /**
   * What in its code, manifest and test cases looks like it only holds
   * on one machine (EO-449). Derived on every read, never stored, for
   * the reason `portability` is.
   */
  machineSpecific: z.array(MachineSpecificWarningSchema),
  /**
   * The latest run of this module's tests, or null when they have never
   * been run (EO-352).
   */
  testRun: ModuleTestRunSchema.nullable().default(null),
  /**
   * Whether `testRun` was taken against code or cases that have changed
   * since. Derived on every read by comparing what the run was taken
   * against with what is saved now, never stored — the same arrangement
   * as `usedByStepCount`. False when there is no run at all: there is
   * nothing to be stale, and `testRun: null` already says so.
   */
  testsStale: z.boolean().default(false),
  /**
   * How many test cases this module has now (EO-354). Derived on every
   * read, never stored.
   *
   * Not read off `testRun`: a module nobody has run the tests of has no
   * run at all, and "no tests" and "tests that have not run yet" are two
   * different things to tell a person — only the first is the reason a
   * step says it is not fully tested because nothing tests it.
   */
  testCount: z.number().default(0),
});

export type ModuleSaveInput = z.infer<typeof ModuleSaveInputSchema>;

/**
 * One reason a module is not fully tested (EO-354).
 *
 * The rule is the one approval is held to (EO-353), read off what is
 * stored rather than by running anything: at least one case, every case
 * passing, and line coverage at `MODULE_COVERAGE_BAR` or above. A module
 * short of it is flagged on every step that runs it, all the time, and
 * the flag always says which of these it is.
 *
 * `coverage` with a null figure is a module whose cases exist but have
 * not run yet: its coverage is not measured, which is not the same as
 * measured and fine.
 */
export type ModuleTestShortfall =
  | { reason: "no_tests" }
  | { reason: "failing"; failing: string[] }
  | { reason: "coverage"; lineCoverage: number | null };

/**
 * Why this module is not fully tested, or nothing when it is (EO-354).
 *
 * Derived, never stored (invariant #6's spirit): the moment a run lands
 * that passes the bar, every place asking gets an empty answer and the
 * marker is gone.
 *
 * Read off the latest run even when it is stale. Saving the code or a
 * case already re-runs the tests in the background, and the push that
 * run ends with refreshes every screen asking — so a stale answer lasts
 * as long as that run, and the alternative (calling a stale module
 * untested) would flag a module for having its cases edited.
 *
 * With no cases at all, that is the whole answer: coverage of nothing is
 * 0%, and saying so beside "no tests" would be one reason said twice.
 */
export function moduleTestShortfalls(module: { testCount?: number; testRun: ModuleTestRun | null }): ModuleTestShortfall[] {
  if ((module.testCount ?? 0) === 0) return [{ reason: "no_tests" }];
  const run = module.testRun;
  if (run === null) return [{ reason: "coverage", lineCoverage: null }];
  const shortfalls: ModuleTestShortfall[] = [];
  const failing = run.cases.filter((each) => !each.passed).map((each) => each.description);
  if (failing.length > 0) shortfalls.push({ reason: "failing", failing });
  if (run.coverage.lines.percent < MODULE_COVERAGE_BAR) shortfalls.push({ reason: "coverage", lineCoverage: run.coverage.lines.percent });
  return shortfalls;
}

/** A shortfall in the few words a column header has room for: "no tests", "2 failing cases", "64% line coverage". */
export function describeModuleTestShortfall(shortfall: ModuleTestShortfall): string {
  switch (shortfall.reason) {
    case "no_tests":
      return "no tests";
    case "failing":
      return shortfall.failing.length === 1 ? "1 failing case" : `${shortfall.failing.length} failing cases`;
    case "coverage":
      return shortfall.lineCoverage === null
        ? "coverage not measured yet"
        : `${shortfall.lineCoverage}% line coverage, under ${MODULE_COVERAGE_BAR}%`;
  }
}
export type ModuleView = z.infer<typeof ModuleViewSchema>;
export type PortabilityWarning = z.infer<typeof PortabilityWarningSchema>;
export type MachineSpecificKind = z.infer<typeof MachineSpecificKindSchema>;
export type MachineSpecificPlace = z.infer<typeof MachineSpecificPlaceSchema>;
export type MachineSpecificWarning = z.infer<typeof MachineSpecificWarningSchema>;

// ── A module's versions (EO-360) ──────────────────────────────────

/**
 * One test case as a module version holds it: the case as it stood
 * when that version stopped being current. Its `id` is the case's own,
 * so restoring the version brings the same case back rather than a
 * look-alike.
 */
export const ModuleVersionTestSchema = z.object({
  id: z.string(),
  description: z.string(),
  source: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** One line of a module's history, as the list shows it. */
export const ModuleVersionSummarySchema = z.object({
  /** 1, 2, 3… within one module. Never reused, even after older ones are deleted. */
  number: z.number().int().positive(),
  createdAt: z.number(),
  /** When a person approved this version's code, or null if nobody did while it was current. */
  approvedAt: z.number().nullable(),
  approved: z.boolean(),
  /** The version the module is on now — always the newest. */
  current: z.boolean(),
  /** How many test cases go with it. The current version's are the module's live cases. */
  testCount: z.number().int().nonnegative(),
  /**
   * The pipelines whose current graph pins this version (EO-770) — a
   * module step or a module entry rule running it — by name. Empty where
   * none does. Defaulted, so an answer from an older build reads as none.
   */
  pinnedBy: z.array(z.string()).default([]),
});

/** One version, whole: what restoring it would bring back. */
export const ModuleVersionSchema = ModuleVersionSummarySchema.extend({
  name: z.string(),
  description: z.string(),
  code: z.string(),
  manifest: ModuleManifestSchema,
  tests: z.array(ModuleVersionTestSchema),
});

/**
 * How many versions of each module an installation keeps (EO-360).
 *
 * A whole number of one or more, for `PipelineVersionsToKeepSchema`'s
 * reason: the version a module is on is never deleted, so "keep none"
 * is a limit EO could not honour.
 */
export const ModuleVersionsToKeepSchema = z.number().int().min(1);

/** Twenty, the pipelines' default — the two settings are separate, not different. */
export const DEFAULT_MODULE_VERSIONS_TO_KEEP = 20;

export type ModuleVersionTest = z.infer<typeof ModuleVersionTestSchema>;
export type ModuleVersionSummary = z.infer<typeof ModuleVersionSummarySchema>;
export type ModuleVersion = z.infer<typeof ModuleVersionSchema>;

/**
 * One value a step has actually set (EO-78).
 *
 * The three types `ModuleInputSchema` declares and nothing else. Null is
 * absent rather than a value: an input a step leaves alone falls back to
 * the manifest's default, and "set to nothing" would be a fourth state
 * the module host has no way to express — `resolveInputs` skips a null
 * default for the same reason.
 */
export const StepInputValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * What one step configured, keyed by the input's declared name.
 *
 * Only the names a person set. An unset input is *absent* here rather
 * than present-and-defaulted, which is what lets the editor say "this is
 * the manifest's default" instead of showing a number somebody chose,
 * and what lets a manifest change its default and have every step that
 * never overrode it follow.
 */
export const StepInputsSchema = z.record(z.string(), StepInputValueSchema);

export type ModuleInputType = z.infer<typeof ModuleInputSchema>["type"];
export type StepInputValue = z.infer<typeof StepInputValueSchema>;
export type StepInputs = z.infer<typeof StepInputsSchema>;

/** The declared type a value would satisfy, or null for anything else. */
function typeOf(value: unknown): ModuleInputType | null {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return null;
}

/** The value as a person would read it back: `the text "eight"`, `the number 8`. */
function shown(value: unknown): string {
  if (typeof value === "string") return `the text ${JSON.stringify(value)}`;
  if (typeof value === "number" || typeof value === "boolean") return `the ${typeof value} ${String(value)}`;
  return "a value of none of those kinds";
}

/**
 * What is wrong with the values a step configured, in sentences (EO-78).
 *
 * Invariant #5 — verify, don't trust — applied to what a person typed.
 * A module declaring `timeout_seconds` as a number and being handed the
 * string `"900"` does arithmetic on it and gets `"9001"`, or waits
 * `NaN` milliseconds, in a subprocess whose only account of itself is a
 * transcript nobody is watching. Refusing it by name, before it runs, is
 * the difference between a mistake and a mystery.
 *
 * Empty means every value matches what the manifest declares. Two
 * callers apply it, and they are not redundant: `validatePipeline` so a
 * bad value cannot be published at all, and `runModule` so one that
 * reached the row another way — a manifest edited after the step was
 * saved, a client writing to `pipeline_steps` — still never reaches
 * `ctx.inputs`.
 *
 * A name the manifest does not declare is *not* a problem. It is inert:
 * `resolveInputs` passes only declared names, so a value left behind by
 * an input the manifest dropped costs nothing and breaks nothing. The
 * manifest decides what exists.
 */
export function moduleInputProblems(manifest: { inputs: Record<string, { type: ModuleInputType }> }, configured: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [name, declared] of Object.entries(manifest.inputs)) {
    const value = configured[name];
    // Absent is the ordinary case: the manifest's default applies.
    if (value === undefined || value === null) continue;
    if (typeOf(value) === declared.type) continue;
    problems.push(`"${name}" expects a ${declared.type}, and this step sets ${shown(value)}.`);
  }
  return problems;
}

/**
 * The configured values this manifest still declares (EO-78).
 *
 * What a step keeps when it is pointed at a different module. Carrying
 * the old module's values across would leave a step holding numbers for
 * inputs the new one never asks about — invisible, because nothing
 * renders an input the manifest does not declare, and one manifest edit
 * away from meaning something again.
 */
export function declaredStepInputs(manifest: { inputs: Record<string, unknown> }, configured: StepInputs): StepInputs {
  const kept: StepInputs = {};
  for (const [name, value] of Object.entries(configured)) {
    if (name in manifest.inputs) kept[name] = value;
  }
  return kept;
}

/**
 * How many work items one module run may create (EO-433).
 *
 * A created item lands on a pipeline with nobody accepting it first, so
 * a loop that creates per file would fill a board the way a loop that
 * comments per file would fill a thread — and an item is dispatched,
 * which a comment is not. Ten, stated in the refusal.
 *
 * Here rather than beside the module runner because two processes hold
 * it: the device that runs the module, and the record that performs the
 * write and counts for itself.
 */
export const MAX_MODULE_CREATIONS_PER_RUN = 10;

/**
 * How long a chain of modules creating work for each other may get
 * (EO-433).
 *
 * An item no module created is generation 0 and a created item is its
 * originator's generation plus one, so three creations deep is the last
 * item that can exist: a run on it cannot create.
 */
export const MAX_ITEM_GENERATION = 3;

/**
 * What `ctx.createItem()` asked for, once the process that ran the
 * module has held it to its shape and redacted it (EO-433).
 *
 * A schema as well as a type because it crosses a second boundary on a
 * managed project: the device sends it to the organisation's record,
 * which is the side that creates the item.
 */
/**
 * Who waits for whom after a creation (EO-434).
 *
 * `this_waits` makes the item the step is running on depend on the new
 * one; `created_waits` makes the new one depend on it; `none` adds no
 * edge between the two. Waiting is a dependency edge and nothing else,
 * so what it holds is what any dependency holds: the next step EO would
 * dispatch — never a step a person acts on, and never the last one.
 */
export const MODULE_CREATION_WAITS = ["none", "this_waits", "created_waits"] as const;
export const ModuleCreationWaitSchema = z.enum(MODULE_CREATION_WAITS);
export type ModuleCreationWait = z.infer<typeof ModuleCreationWaitSchema>;

export const ModuleCreationSchema = z.object({
  idempotencyKey: z.string().min(1),
  /** An item type's slug. Which types the project has is the writer's to answer. */
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  /** The fields that type's shape declares. */
  spec: z.record(z.string(), z.unknown()),
  pipeline: z.string().min(1).optional(),
  parent: z.string().min(1).optional(),
  repository: z.string().min(1).optional(),
  /** A branch that already exists, to work on instead of cutting one (EO-648). Judged by the door that creates the item. */
  existingBranch: z.string().min(1).optional(),
  /** Left out means `none`. */
  wait: ModuleCreationWaitSchema.optional(),
  /** Keys of other existing items the new one waits for. Left out means none. */
  dependsOn: z.array(z.string().min(1)).optional(),
});
export type ModuleCreation = z.infer<typeof ModuleCreationSchema>;

/** What a module is answered with. `existing` is true when this key had already made that item. */
export const ModuleCreationAnswerSchema = z.union([
  z.object({ created: z.literal(true), key: z.string(), existing: z.boolean() }),
  z.object({ created: z.literal(false), reason: z.string() }),
]);
export type ModuleCreationAnswer = z.infer<typeof ModuleCreationAnswerSchema>;
