import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALIAS_RETIREMENT_VERSION, isPackShipped, moduleMachineSpecificWarnings, specFields } from "@eo/core";
import type { Comment, CustomModule, Item, Uuid } from "@eo/core";
import { openDb, type DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { attachWorkspace, createTestItem } from "../db/testHelpers.js";
import { onCommentPosted } from "../db/commentEvents.js";
import {
  addDependency,
  createItemType,
  createRun,
  getItemType,
  listAgents,
  listCommentsForItem,
  listMentionsForComment,
  needsAttention,
  pendingPushesForItem,
  postComment,
  updateItem,
} from "../db/repos/index.js";
import type { StepAnswer } from "../roles/answers.js";
import { resetSearchPathForTests, resolveSearchPath } from "../process/searchPath.js";
import { postModuleComment } from "./moduleComments.js";
import { moduleItemView } from "../ipc/domainQueries.js";
import { updateItemTypeCommand } from "../ipc/itemTypeCommands.js";
import {
  MAX_COMMENTS_PER_RUN,
  MAX_COMMENT_CHARS,
  MAX_OPTIONS,
  MAX_OPTION_CHARS,
  redactSecrets,
  resolveInputs,
  runModule,
  systemRootEnv,
  type ModuleHostLauncher,
  type ModuleOutcome,
} from "./runModule.js";
// @ts-expect-error — the host is plain JavaScript, deliberately: it ships
// unbundled because another process executes it by path.
import { computedImportSites, moduleEnv, specifierSites } from "./moduleHost.mjs";
import { moduleItemReader } from "./moduleItemRead.js";


/** Any `item_types` row: these fixtures never read the type's row, only the word on it. */
const STORY_TYPE_ID = "0199aa00-0000-7000-8000-000000000001" as Uuid;
/**
 * The module host, end to end (KAN-105).
 *
 * A real child process running the real `moduleHost.mjs`, because every
 * property worth testing here is a property of the boundary: what a
 * module can reach, what it cannot, and what happens when it misbehaves.
 * A stubbed host would assert the stub.
 */

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "moduleHost.mjs");
const migrationsFolder = join(here, "..", "db", "migrations");

/**
 * Node, not Electron. Production launches `process.execPath` with
 * ELECTRON_RUN_AS_NODE=1 — under vitest `process.execPath` already *is*
 * node, so the same line covers both.
 */
const launcher: ModuleHostLauncher = { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

/**
 * Whether a binary starts at all, asked by starting it.
 *
 * `existsSync` was the whole test and it is not enough. CI's unit-test
 * job installs Electron's npm package, so the file is certainly there —
 * on an image carrying none of the shared libraries the binary links
 * against, because `playwright install --with-deps` is run for the e2e
 * job and not this one. It exits before reaching a line of the host, the
 * host sends nothing on its result channel, and the three tests below
 * failed saying a module "ended without returning a result": true, and
 * silent about what was actually wrong.
 *
 * A present binary and a runnable one are different questions, so this
 * asks the second one.
 */
function startsAsNode(binary: string): boolean {
  const probe = spawnSync(binary, ["-e", "process.exit(0)"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 30_000,
    stdio: "ignore",
  });
  return probe.error === undefined && probe.status === 0;
}

/**
 * Electron's binary, for the block at the bottom that runs the host on
 * the runtime production uses. `null` where it cannot run.
 *
 * Read through `createRequire` rather than imported: the package's
 * runtime export is a path string, while its types describe the API a
 * renderer sees, so the declared type is not what `require` hands back
 * here.
 */
const electronExport: unknown = createRequire(import.meta.url)("electron");
const electronBinary = typeof electronExport === "string" && existsSync(electronExport) && startsAsNode(electronExport) ? electronExport : null;

const item = {
  id: "019fb8c6-0000-7000-8000-000000000001" as Uuid,
  key: "EO-1",
  typeId: STORY_TYPE_ID,
  type: "story",
  title: "Ship it",
  branch: "eo/EO-1",
  prUrl: null,
} as unknown as Item;

function moduleWith(code: string, overrides: Partial<CustomModule["manifest"]> = {}): CustomModule {
  return {
    id: "019fb8c6-0000-7000-8000-0000000000aa" as Uuid,
    slug: "probe",
    name: "Probe",
    description: "A module written to be looked at.",
    code,
    manifest: { name: "Probe", description: "A module.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["ok"], ...overrides },
    originalScript: null,
    source: "user",
    approvedAt: 1,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}

function run(
  module: CustomModule,
  extra: {
    env?: Record<string, string>;
    inputs?: Record<string, unknown>;
    timeoutMs?: number;
    onOutput?: (text: string) => void;
    launcher?: ModuleHostLauncher;
    answer?: StepAnswer;
  } = {},
) {
  return runModule(extra.launcher ?? launcher, {
    module,
    item,
    cwd: process.cwd(),
    env: extra.env ?? {},
    ...(extra.inputs ? { inputs: extra.inputs } : {}),
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
    ...(extra.onOutput ? { onOutput: extra.onOutput } : {}),
    ...(extra.answer ? { answer: extra.answer } : {}),
  });
}

describe("running a module", () => {
  it("returns the result key it produced", async () => {
    const outcome = await run(moduleWith(`export default async function run() { return { ok: true, result: "ok", detail: "did the thing" }; }`));
    expect(outcome).toEqual({ ok: true, result: "ok", detail: "did the thing" });
  });

  it("reports a module that throws, rather than crashing the host", async () => {
    const outcome = await run(moduleWith(`export default async function run() { throw new Error("boom"); }`));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("boom");
  });

  // Guessing at what a module meant is how a failure comes to look like a
  // success, which on a `deploy` step is the worst outcome available.
  it("refuses a module that succeeds without naming its result", async () => {
    const outcome = await run(moduleWith(`export default async function run() { return { ok: true }; }`));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("must name the result");
  });

  it("refuses a module with no default export", async () => {
    const outcome = await run(moduleWith(`export const manifest = {};`));
    expect(outcome.ok === false && outcome.reason).toContain("default function");
  });

  // The rule that keeps a pipeline portable. Enforced in the host rather
  // than by a lint, because a lint is advice and this has to be a fact —
  // and asked of the loader rather than read off the text (EO-80), which
  // is what makes it a fact rather than a guess.
  it("refuses a module importing anything but a Node builtin, and names it", async () => {
    const outcome = await run(moduleWith(`import fetch from "node-fetch";\nexport default async function run() { return { ok: true, result: "ok" }; }`));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
  });

  it("allows a node: builtin", async () => {
    const code = `import { sep } from "node:path";\nexport default async function run() { return { ok: true, result: "ok", detail: sep }; }`;
    expect(await run(moduleWith(code))).toMatchObject({ ok: true, result: "ok" });
  });

  it("allows a node: builtin reached through a subpath", async () => {
    const code = `import { readFile } from "node:fs/promises";\nexport default async function run() { return { ok: true, result: "ok", detail: typeof readFile }; }`;
    expect(await run(moduleWith(code))).toMatchObject({ ok: true, result: "ok", detail: "function" });
  });

  /**
   * Spelled like a builtin, and not one (EO-80 review).
   *
   * `startsWith("node:")` was the whole test, so this was handed to the
   * real resolver as though EO had approved of it — and came back a few
   * frames later as Node's own ERR_UNKNOWN_BUILTIN_MODULE, which names
   * no line, no rule, and nothing an author can act on. A specifier this
   * host will not stand behind has to be refused where the refusal can
   * still say where in the module it is written.
   */
  it("refuses a node: specifier that is not a builtin, and names where it is written", async () => {
    const code = ['export const note = "nothing here";', "", 'import { thing } from "node:does-not-exist";', 'export default async function run() { return { ok: true, result: "ok" }; }'].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node:does-not-exist"');
    expect(outcome.ok === false && outcome.reason).toContain("no builtin by that name");
    expect(outcome.ok === false && outcome.reason).toContain("line 3");
    expect(outcome.ok === false && outcome.reason).toContain('import { thing } from "node:does-not-exist";');
    // Node's own wording for this, which is what the author used to get.
    expect(outcome.ok === false && outcome.reason).not.toContain("ERR_UNKNOWN_BUILTIN_MODULE");
  });

  /**
   * A subpath is the same builtin wearing a different name.
   *
   * `node:inspector` is withheld and the set was matched on the whole
   * string, so `node:inspector/promises` — the same API with promises on
   * it — walked around it.
   */
  it("refuses a withheld builtin reached through its subpath", async () => {
    const code = `import { Session } from "node:inspector/promises";\nexport default async function run() { return { ok: true, result: "ok" }; }`;
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node:inspector/promises"');
    expect(outcome.ok === false && outcome.reason).toContain("withholds");
    expect(outcome.ok === false && outcome.reason).toContain("line 1");
  });

  // Withheld under any spelling, and told so once rather than sent to a
  // second refusal by being asked to write it the long way first.
  it("refuses a withheld builtin written bare", async () => {
    const outcome = await run(moduleWith(`import { spawn } from "child_process";\nexport default async function run() { return { ok: true, result: "ok" }; }`));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("withholds");
  });

  // A builtin written the short way is a builtin, and the refusal says
  // how to write it rather than calling it an npm package.
  it("tells a module naming a builtin bare how to name it the long way", async () => {
    const outcome = await run(moduleWith(`import { sep } from "path";\nexport default async function run() { return { ok: true, result: "ok" }; }`));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('write "node:path"');
  });

  /**
   * The bug, as it actually happened (EO-80).
   *
   * `[\s\S]+?` spanned any distance and any content, every module
   * contains `export default`, and a comment is text — so the first
   * quoted phrase after the word `from` anywhere in the rest of the file
   * was read as a package name. This module imports nothing. It refused
   * a production run, reporting a package called "CI is unhappy".
   *
   * `important` is in here too: `\bimport` had no trailing boundary, so
   * the word opened a match just as well as the keyword did.
   */
  it("runs a module whose only import is a sentence about one", async () => {
    const code = [
      "/**",
      " * Tags the release.",
      " *",
      ' * One important detail: it differs from "CI is unhappy" in that it',
      " * does not reach for anything at all.",
      " */",
      'export default async function run() { return { ok: true, result: "ok", detail: "nothing imported" }; }',
    ].join("\n");
    expect(await run(moduleWith(code))).toMatchObject({ ok: true, result: "ok", detail: "nothing imported" });
  });

  /**
   * Machine-specific values are advice and never a gate (EO-449): a
   * module the scan has plenty to say about still runs. Nothing on the
   * run path reads the scan at all; this holds it to that.
   */
  it("runs a module whose code and manifest hold machine-specific values", async () => {
    const code = [
      "export default async function run(ctx) {",
      '  const notes = "/home/dev/notes.md";',
      '  const api = "http://localhost:3000";',
      '  return { ok: true, result: "ok", detail: notes + " " + api };',
      "}",
    ].join("\n");
    const module = moduleWith(code, { needs: { bin: ["bash", "/usr/bin/git"], env: [], network: false, item: false, comment: false, attach: false, create: false } });
    expect(moduleMachineSpecificWarnings({ code: module.code, manifest: module.manifest })).toHaveLength(4);

    expect(await run(module)).toEqual({ ok: true, result: "ok", detail: "/home/dev/notes.md http://localhost:3000" });
  });

  /**
   * A refusal has to name where the problem is.
   *
   * The one that misfired named a package and stopped, so it had to be
   * diagnosed by reading the module against a regular expression — which
   * is not something a module author should ever have to do.
   */
  it("names the line a refused import is written on", async () => {
    const code = ['export const note = "nothing here";', "", 'import fetch from "node-fetch";', 'export default async function run() { return { ok: true, result: "ok" }; }'].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 3");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node-fetch";');
  });

  /**
   * The loader is handed a *decoded* specifier.
   *
   * `import "node\x2dfetch"` reaches the hook as `node-fetch`, because
   * the parser resolved the escape before there was a specifier to
   * resolve — so a refusal that went looking for `node-fetch` in a source
   * that says no such thing named the package and pointed nowhere. The
   * source is decoded to meet the loader instead.
   */
  it("names the line when the specifier is written with an escape", async () => {
    const code = ['export const note = "nothing here";', "", 'import fetch from "node\\x2dfetch";', 'export default async function run() { return { ok: true, result: "ok" }; }'].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("line 3");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node\\x2dfetch";');
  });

  /**
   * The same, for a module written on Windows.
   *
   * A backslash before CR LF is one line terminator and contributes no
   * character, so this resolves to the refused `node-fetch` exactly as
   * an unbroken spelling would — and it is the spelling most likely to
   * be reached for by accident, since a long import wrapped in an editor
   * that writes CRLF produces it.
   *
   * Two separate things left the refusal pointing nowhere: the decoder
   * knew only a backslash before LF, and before it could even be asked,
   * `closingQuote` read the LF half of the CR LF as the end of the line
   * and called the literal unterminated — so there was no token at all.
   * End to end because that pair is only visible through the whole
   * path: the loader decodes, and the host has to find its way back.
   */
  it("names the import line when a CRLF line continuation splits the specifier", async () => {
    const code = ['export const note = "nothing here";', "", 'import fetch from "node\\\r\n-fetch";', 'export default async function run() { return { ok: true, result: "ok" }; }'].join("\r\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    // The name the loader resolved, not the broken one the source spells.
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("line 3");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node\\');
  });

  /**
   * End to end, for a regular expression the lexer used to misread.
   *
   * `if (false) {} /"/.test("x")` is ordinary JavaScript. Taking the `}`
   * for the end of an expression made the `/` a division and the quote
   * after it the start of a string, and that string then ran on and
   * swallowed the import — so a module that reaches for a package was
   * refused by a message that could not say where. Through a host
   * because the refusal, not the locator, is what an author reads.
   *
   * The import shares the line deliberately. A misread string stops at
   * the line ending, so an import on the next line down survives the
   * mistake and the shape only bites where it was found: on one line.
   */
  it("names the import line past a regular expression that follows a block", async () => {
    const code = ['export const note = "nothing here";', 'if (false) {} /"/.test("x"); import fetch from "node-fetch";', 'export default async function run() { return { ok: true, result: "ok" }; }'].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 2");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node-fetch";');
  });

  /**
   * The same, for a `/` after a *labelled* block.
   *
   * `retry: {} /"/.test("x")` is ordinary JavaScript too, and knowing
   * what the `}` closed was not enough on its own: a `{` written after a
   * colon was read as an object literal, which is the right reading for
   * `{ n: {} }` and the wrong one for a label. So the `}` ended an
   * expression, the `/` divided, the quote after it opened a string, and
   * the string swallowed the import — the failure above exactly, one
   * colon further out.
   *
   * The import shares the line for the same reason it does above: a
   * misread string stops at the line ending, so an import written a line
   * further down survives the mistake and would prove nothing.
   */
  it("names the import line past a regular expression that follows a labelled block", async () => {
    const code = ['export const note = "nothing here";', 'retry: {} /"/.test("x"); import fetch from "node-fetch";', 'export default async function run() { return { ok: true, result: "ok" }; }'].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 2");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node-fetch";');
  });

  /**
   * End to end, for the plainest arithmetic there is.
   *
   * `n++ / 2` divides. Every punctuation mark but `]`, `}` and `)` was
   * taken for an operator, and `++` is spelled with one that usually is
   * — so the `/` was read as a regular expression opening, and it ran
   * to the end of the line and swallowed the import written after it
   * there. A module reaching for a package was refused by a message
   * that could not say where.
   *
   * The import shares the line for the reason the two above it do: a
   * misreading stops at the line ending, so an import written a line
   * further down survives it and would prove nothing.
   */
  it("names the import line past a division by a postfix increment", async () => {
    const code = ['export const note = "nothing here";', 'let n = 1; n++ / 2; import fetch from "node-fetch";', "export default async function run() { return { ok: true, result: \"ok\" }; }"].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 2");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node-fetch";');
  });

  /**
   * The same, for a function expression being divided.
   *
   * `function g() {}` and `const f = function () {}` are spelled
   * identically from the `}` backwards, and only the keyword's own
   * position tells them apart — a declaration's body ends a statement,
   * an expression's ends an operand. Every function body was read as a
   * declaration's, so the `/` after this one opened a regular
   * expression that ran on and took the import with it.
   */
  it("names the import line past a division of a function expression", async () => {
    const code = ['export const note = "nothing here";', 'const f = function () {} / 2; import fetch from "node-fetch";', "export default async function run() { return { ok: true, result: \"ok\", detail: String(f) }; }"].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 2");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node-fetch";');
  });

  /**
   * The same, for a regular expression being divided.
   *
   * A regular expression is an operand like any other and `/a/ / 2`
   * divides one, but the lexer stepped over the literal without leaving
   * a token behind — so the `/` after it was asked about the `=` before
   * the literal instead, which opens a regular expression. The same
   * misreading as above, reached by a token that was never there rather
   * than by one that was misread.
   */
  it("names the import line past a division of a regular expression", async () => {
    const code = ['export const note = "nothing here";', 'const ratio = /"/ / 2; import fetch from "node-fetch";', "export default async function run() { return { ok: true, result: \"ok\", detail: String(ratio) }; }"].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 2");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node-fetch";');
  });

  /**
   * And a third: a number is an operand, and one of them ends in a dot.
   *
   * `1./2` is a division. Read a character at a time the point looked
   * like a member dot, after which the `/` opened a regular expression
   * that ran to the end of the line and took the import written there
   * into itself — leaving the refusal with nowhere to point, which is
   * the whole of what this item is about.
   */
  it("names the import line past a division of a number written with a trailing point", async () => {
    const code = ['export const note = "nothing here";', 'const quotient = 1./2; import fetch from "node-fetch";', "export default async function run() { return { ok: true, result: \"ok\", detail: String(quotient) }; }"].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("It is written here:");
    expect(outcome.ok === false && outcome.reason).toContain("line 2");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node-fetch";');
  });

  /**
   * The same, for a module whose lines end in CR alone.
   *
   * Counting LF alone found no line ending anywhere in it: the leading
   * comment ran to the end of the file and took the import into itself,
   * and had it not, every offset would still have been reported as line
   * 1 with the whole module quoted as that line. CR-only source is rare
   * and CR LF is not, but the two are the same defect and this is the
   * spelling that fails hardest.
   */
  it("names the import line in a module whose lines end in CR alone", async () => {
    const code = ['// a note about what this module does', 'import fetch from "node-fetch";', 'export default async function run() { return { ok: true, result: "ok" }; }'].join("\r");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 2");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node-fetch";');
    expect(outcome.ok === false && outcome.reason).not.toContain("a note about");
  });

  /**
   * Prose is not an import site, here either.
   *
   * Searching the text for the package name counted every mention of it,
   * so a docstring naming it often enough filled the refusal with
   * citations of prose and pushed the import itself off the end — the
   * same mistake this item is about, one job further down. Import
   * syntax is located, and a comment has none.
   */
  it("names the import rather than a comment that mentions the package", async () => {
    const code = [
      '// "node-fetch" is what this used to reach for.',
      '// "node-fetch" was dropped, because "node-fetch" is not portable.',
      '/* Twice more, in a block: "node-fetch", "node-fetch". */',
      'import fetch from "node-fetch";',
      'export default async function run() { return { ok: true, result: "ok" }; }',
    ].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 4");
    expect(outcome.ok === false && outcome.reason).not.toContain("used to reach for");
    expect(outcome.ok === false && outcome.reason).not.toContain("…and");
  });

  /**
   * Nor is a method somebody named `import`.
   *
   * `registry.import("node-fetch")` is a call on an object. It reaches
   * for nothing, the loader is never asked about it, and reading it as
   * an `import(` call put five lines that import nothing at the top of
   * the refusal and pushed the one that does past the cap as "…and 1
   * more" — leaving the refusal saying everything except where. Five of
   * them because five is the cap: the failure needs the citations to be
   * spent, not merely wrong.
   */
  it("names the import rather than the member calls written above it", async () => {
    const code = [
      "const registry = { import: (name) => name };",
      'registry.import("node-fetch");',
      'registry.import("node-fetch");',
      'registry.import("node-fetch");',
      'registry.import("node-fetch");',
      'registry.import("node-fetch");',
      'import fetch from "node-fetch";',
      "export default async function run() { return { ok: true, result: \"ok\" }; }",
    ].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 7");
    expect(outcome.ok === false && outcome.reason).toContain('import fetch from "node-fetch";');
    expect(outcome.ok === false && outcome.reason).not.toContain("registry.import");
    expect(outcome.ok === false && outcome.reason).not.toContain("…and");
  });

  /**
   * A fourth way to ask the loader, and one nothing here could see.
   *
   * `import.meta.resolve` runs the resolve hook with the module as the
   * parent exactly as an import does, so a module reaching for a package
   * through it has its run refused — while being neither an import
   * statement nor an `import(` call. The refusal named the package and
   * pointed nowhere, which is the whole of what this item is about.
   */
  it("names the line an import.meta.resolve is written on", async () => {
    const code = ["export default async function run() {", '  const where = import.meta.resolve("node-fetch");', '  return { ok: true, result: "ok", detail: where };', "}"].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("It is written here:");
    expect(outcome.ok === false && outcome.reason).toContain("line 2");
    expect(outcome.ok === false && outcome.reason).toContain("import.meta.resolve");
  });

  /**
   * The same call with two more marks in front of its bracket.
   *
   * `import.meta.resolve?.("node-fetch")` is an optional call, reaching
   * the loader exactly as the plain one does — and read as neither an
   * `import` nor an `import.meta.resolve`, so the refusal named the
   * package and stopped. Written here with the module's own
   * `Error.prepareStackTrace` set, which is how it was reported: this
   * asserts that the source names the line, without any help from a
   * stack the module has had its hands on.
   */
  it("names the line an optional import.meta.resolve call is written on", async () => {
    const code = [
      "export default async function run() {",
      "  Error.prepareStackTrace = () => null;",
      '  const where = import.meta.resolve?.("node-fetch");',
      '  return { ok: true, result: "ok", detail: where };',
      "}",
    ].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("It is written here:");
    expect(outcome.ok === false && outcome.reason).toContain("line 3");
    expect(outcome.ok === false && outcome.reason).toContain("import.meta.resolve?.");
  });

  /**
   * A module does not get to turn its own refusal's location off.
   *
   * `Error.prepareStackTrace` is a documented hook and a module may
   * have set one for reasons entirely its own, long before it reached
   * for anything — but the stack read here does not go through it, or
   * through `Error` at all. Written through a name of the module's own
   * so that nothing but the stack can answer: this is the fallback
   * being asserted, not the source.
   */
  it("names the line even when the module has replaced Error.prepareStackTrace", async () => {
    const code = [
      "export default async function run() {",
      "  Error.prepareStackTrace = () => null;",
      "  const { resolve } = import.meta;",
      '  return { ok: true, result: "ok", detail: resolve("node-fetch") };',
      "}",
    ].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("The module asked for it here:");
    expect(outcome.ok === false && outcome.reason).toContain("line 4");
  });

  /**
   * Nor by nailing `Error` down so that it cannot be put right.
   *
   * The hook here is non-writable and non-configurable and `Error` is
   * frozen over the top of it, which is as far as a module can go: put
   * back is not something that has to be arranged, because nothing was
   * borrowed. `stackTraceLimit` is set to 0 in the same breath, that
   * being the other half a stack read out of `Error` depended on.
   */
  it("names the line when the module has nailed Error down", async () => {
    const code = [
      "export default async function run() {",
      '  Object.defineProperty(Error, "prepareStackTrace", { value: () => null, writable: false, configurable: false });',
      "  Error.stackTraceLimit = 0;",
      "  Object.freeze(Error);",
      "  const { resolve } = import.meta;",
      '  return { ok: true, result: "ok", detail: resolve("node-fetch") };',
      "}",
    ].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("The module asked for it here:");
    expect(outcome.ok === false && outcome.reason).toContain("line 6");
  });

  /**
   * The same, through a name the module gave it.
   *
   * `const { resolve } = import.meta` puts that function behind a
   * binding of the module's choosing, and no amount of lexing the source
   * — or parsing it — finds that without following the binding. Reading
   * the source is the wrong instrument here and the stack is the right
   * one: `import.meta.resolve` is an ordinary synchronous call, so when
   * the hook throws, the module's own frame is still standing underneath
   * with the line it was called from.
   */
  it("names the line when a module resolves through a name of its own", async () => {
    const code = ["export default async function run() {", "  const { resolve } = import.meta;", '  return { ok: true, result: "ok", detail: resolve("node-fetch") };', "}"].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("The module asked for it here:");
    expect(outcome.ok === false && outcome.reason).toContain("line 3");
  });

  /**
   * A module is free to turn stack traces off, and does not get to turn
   * its own refusal's location off by doing it.
   */
  it("names the line even when the module has set stackTraceLimit to 0", async () => {
    const code = ["Error.stackTraceLimit = 0;", "export default async function run() {", "  const { resolve } = import.meta;", '  return { ok: true, result: "ok", detail: resolve("node-fetch") };', "}"].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("line 4");
  });

  /**
   * Reading a stack runs code the module may have replaced.
   *
   * `Error.prepareStackTrace` is a documented hook, so a module can make
   * `.stack` throw — and by the time it resolves anything at run time,
   * it has had the chance to. That must cost the refusal its location at
   * worst, never turn the refusal into some other error. Reading the
   * source is what answers here, which is the point of keeping both.
   *
   * Written inside `run` rather than at the top of the module because an
   * import declaration is hoisted: a static import is resolved before
   * any statement of the module has run, so a hook installed up there
   * would not be installed yet when the refusal fires.
   */
  it("still refuses, and still points, when the module has broken Error.prepareStackTrace", async () => {
    const code = [
      "export default async function run() {",
      '  Error.prepareStackTrace = () => { throw new Error("no stacks for you"); };',
      '  const where = import.meta.resolve("node-fetch");',
      '  return { ok: true, result: "ok", detail: where };',
      "}",
    ].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("It is written here:");
    expect(outcome.ok === false && outcome.reason).toContain("line 3");
  });

  /**
   * Exact, the way `import(String("node:os"))` is exact.
   *
   * The hook is the whole policy, so a permitted builtin asked for
   * through `import.meta.resolve` is permitted. Nothing here is a list
   * of shapes a module may write.
   */
  it("allows a builtin reached through import.meta.resolve", async () => {
    const code = `export default async function run() { return { ok: true, result: "ok", detail: import.meta.resolve("node:os") }; }`;
    expect(await run(moduleWith(code))).toMatchObject({ ok: true, result: "ok", detail: "node:os" });
  });

  // The loader knows what a computed specifier resolved to; the source
  // does not contain it. So the refusal points at the `import()` that
  // asked, and says why there is no line with the specifier on it.
  it("points at the import() when the specifier was assembled at run time", async () => {
    const code = ["export default async function run() {", '  const half = "node-";', '  await import(half + "fetch");', "}"].join("\n");
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("assembled while the module runs");
    expect(outcome.ok === false && outcome.reason).toContain("line 3");
  });

  /**
   * Exact, where the scan was conservative.
   *
   * `import(String("node:os"))` reaches `node:os` and nothing else. The
   * scan could not read it and so refused the run; the loader resolves
   * it and there is nothing to refuse. That a module has an import
   * nothing can read statically is real, but it is portability advice —
   * `portability.ts` says so to an author — not grounds to refuse a
   * deploy.
   */
  it("allows a builtin reached through a computed specifier", async () => {
    const code = `export default async function run() { const m = await import(String("node:os")); return { ok: true, result: "ok", detail: typeof m.platform }; }`;
    expect(await run(moduleWith(code))).toMatchObject({ ok: true, result: "ok", detail: "function" });
  });

  /**
   * A dynamic import is refused where it was called, so a module can
   * catch it. It does not get to carry on and report success: the guard
   * fired, and a fired guard does not end in the module's own account of
   * events (invariant #5, invariant #8).
   */
  it("refuses the run when a module swallows a refused import and reports success", async () => {
    const code = `export default async function run() { try { await import("node-fetch"); } catch {} return { ok: true, result: "ok", detail: "got away with it" }; }`;
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
  });

  // The property the pre-import scan was defending, kept and now
  // asserted rather than argued. Static imports are resolved and linked
  // before any of a module's own code executes, so a hook that throws
  // during resolution fires exactly as early as a scan that ran first.
  it("refuses a static import before any of the module has run", async () => {
    const lines: string[] = [];
    const code = `console.log("THE-BODY-RAN");\nimport fetch from "node-fetch";\nexport default async function run() { return { ok: true, result: "ok" }; }`;
    const outcome = await run(moduleWith(code), { onOutput: (text) => lines.push(text) });
    expect(outcome.ok).toBe(false);
    expect(lines.join("")).not.toContain("THE-BODY-RAN");
  });

  // Nothing silently drops work on the floor (invariant #8). A refusal
  // the module caught still reaches the person watching the run, at the
  // moment it happened rather than only in the outcome afterwards.
  it("writes a refused import to the transcript", async () => {
    const lines: string[] = [];
    const code = `export default async function run() { try { await import("node-fetch"); } catch {} return { ok: true, result: "ok" }; }`;
    await run(moduleWith(code), { onOutput: (text) => lines.push(text) });
    expect(lines.join("")).toContain("EO refused an import");
    expect(lines.join("")).toContain('"node-fetch"');
  });
});

/**
 * A module that is a check (EO-458, ARCHITECTURE.md, "Modules: a step
 * that is a script"): `waiting`, and its news, from a manifest that says
 * it can wait, and from no other.
 */
describe("a module that is a check", () => {
  const WAITS = `export default async function run() {
    return { ok: true, result: "waiting", detail: "still pending", news: [{ id: "job-1", text: "lint failed" }, { id: "job-2", text: "e2e failed" }] };
  }`;

  it("answers waiting with its news from a manifest that declares watch: true", async () => {
    const outcome = await run(moduleWith(WAITS, { watch: true }));
    expect(outcome).toEqual({
      ok: true,
      result: "waiting",
      detail: "still pending",
      news: [
        { id: "job-1", text: "lint failed" },
        { id: "job-2", text: "e2e failed" },
      ],
    });
  });

  it("answers waiting with no news as an empty list", async () => {
    const outcome = await run(moduleWith(`export default async function run() { return { ok: true, result: "waiting" }; }`, { watch: true }));
    expect(outcome).toEqual({ ok: true, result: "waiting", detail: "", news: [] });
  });

  it("refuses waiting from a module whose manifest does not declare watch: true, saying so", async () => {
    for (const watch of [undefined, false]) {
      const outcome = await run(moduleWith(WAITS, watch === undefined ? {} : { watch }));
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toContain("its manifest does not declare `watch: true`, so it cannot wait");
    }
  });

  it("refuses news that is not a list of entries with an id and a text", async () => {
    for (const news of [`"lint failed"`, `[{ text: "no id" }]`, `[{ id: "", text: "empty id" }]`, `[{ id: "job-1", text: 7 }]`, `[null]`]) {
      const outcome = await run(moduleWith(`export default async function run() { return { ok: true, result: "waiting", news: ${news} }; }`, { watch: true }));
      expect(outcome.ok, news).toBe(false);
      expect(outcome.ok === false && outcome.reason).toContain('result: "waiting", news: [{ id, text }');
    }
  });

  it("redacts a secret from news, its id as well as its text", async () => {
    const outcome = await run(
      moduleWith(`export default async function run(ctx) { return { ok: true, result: "waiting", news: [{ id: "seen-" + process.env.TOKEN, text: "token " + process.env.TOKEN } ] }; }`, {
        watch: true,
        needs: { bin: [], env: ["TOKEN"], network: false, item: false, comment: false, attach: false, create: false },
      }),
      { env: { TOKEN: "s3cr3t-value" } },
    );
    expect(JSON.stringify(outcome)).not.toContain("s3cr3t-value");
    expect(outcome.ok && outcome.news).toEqual([{ id: "seen-«TOKEN»", text: "token «TOKEN»" }]);
  });

  it("drops news from any result but waiting, and still routes the result", async () => {
    const outcome = await run(moduleWith(`export default async function run() { return { ok: true, result: "ok", detail: "", news: [{ id: "x", text: "y" }] }; }`, { watch: true }));
    expect(outcome).toEqual({ ok: true, result: "ok", detail: "" });
  });
});

/**
 * The same host, on the runtime EO actually ships (EO-80).
 *
 * Everything above runs on plain Node, because under vitest
 * `process.execPath` is node. Production is Electron's own binary under
 * ELECTRON_RUN_AS_NODE=1, and two things this check depends on are true
 * only there. One is that `registerHooks` works at all — the assumption
 * the whole item rests on, established by hand and asserted nowhere
 * until now. The other is that the loader's builtin set is *Electron's*,
 * which is Node's plus `original-fs` and Electron's own js2c bundles, so
 * asking the runtime what a builtin is answers a slightly different
 * question here than it does above.
 *
 * Skipped where that binary cannot run, which is the only honest thing a
 * test can do about a runtime that is not there. That includes CI's
 * unit-test job, which installs the package but none of the libraries
 * the binary needs — so treat this block as covering a developer machine
 * and the release workflow, and not as something a green CI has checked.
 */
describe.skipIf(electronBinary === null)("running a module under ELECTRON_RUN_AS_NODE", () => {
  // `process.execPath` when Electron is absent, which is exactly when
  // every test in this block is skipped.
  const onElectron: ModuleHostLauncher = { execPath: electronBinary ?? process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

  it("installs the loader hook, and refuses a package by line", async () => {
    const code = ['export const note = "nothing here";', "", 'import fetch from "node-fetch";', 'export default async function run() { return { ok: true, result: "ok" }; }'].join("\n");
    const outcome = await run(moduleWith(code), { launcher: onElectron });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node-fetch"');
    expect(outcome.ok === false && outcome.reason).toContain("line 3");
  });

  it("runs a module that imports a Node builtin", async () => {
    const code = `import { sep } from "node:path";\nexport default async function run() { return { ok: true, result: "ok", detail: sep }; }`;
    expect(await run(moduleWith(code), { launcher: onElectron })).toMatchObject({ ok: true, result: "ok" });
  });

  /**
   * A builtin this runtime has and Node does not.
   *
   * `original-fs` is `fs` without asar, and it resolves here because the
   * host is Electron's binary — on the machine an exported pipeline
   * lands on, it resolves nowhere. Asking the runtime is exact about what
   * *will* resolve, which is not the same as the rule being enforced, so
   * the runtime's own additions are subtracted back off. Plain Node has
   * never heard of this name, so this assertion says nothing at all in
   * the block above: it only bites here.
   */
  it("refuses a builtin only this runtime has", async () => {
    const code = 'import "node:original-fs";\nexport default async function run() { return { ok: true, result: "ok" }; }';
    const outcome = await run(moduleWith(code), { launcher: onElectron });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('"node:original-fs"');
    expect(outcome.ok === false && outcome.reason).toContain("Electron running as Node");
    expect(outcome.ok === false && outcome.reason).toContain("line 1");
  });
});

/**
 * Pointing at the import, not at text that resembles one (EO-80).
 *
 * The refusals above are the loader's and are exact. The other half of a
 * refusal is *where in the module the problem is*, and that half still
 * has to read the source: the loader knows what was asked for, never
 * where it was written. So this is the one place a text scan survived —
 * and it is held to import syntax rather than to text that matches,
 * because `indexOf` over the source is how a comment came to be quoted
 * back at an author as their import in the first place.
 *
 * Directly rather than through a host: each of these is a shape the
 * source has to be read correctly to find, and a subprocess per shape
 * buys nothing the assertions do not already say.
 */
describe("where a refused import is written", () => {
  const linesOf = (code: string, specifier: string): number[] =>
    (specifierSites(code, specifier) as { line: number }[]).map((site) => site.line);

  it.each([
    ["a static import", 'import fetch from "node-fetch";'],
    ["a side-effect import", 'import "node-fetch";'],
    ["a re-export", 'export { get } from "node-fetch";'],
    ["a dynamic import", 'await import("node-fetch");'],
    ["a template specifier", "await import(`node-fetch`);"],
    ["an import broken by a block comment", 'import/*x*/{ get } from "node-fetch";'],
  ])("finds %s", (_shape, line) => {
    expect(linesOf(`const before = 1;\n${line}\n`, "node-fetch")).toEqual([2]);
  });

  // The loader resolved the escape long before it had a specifier to
  // resolve, so the decoded name appears nowhere in the source. Decoding
  // the source is what closes the gap.
  it.each([
    ["a hex escape", 'import fetch from "node\\x2dfetch";'],
    ["a unicode escape", 'import fetch from "node\\u002dfetch";'],
    ["a code point escape", 'import fetch from "node\\u{2d}fetch";'],
  ])("finds a specifier written with %s", (_shape, line) => {
    expect(linesOf(`const before = 1;\n${line}\n`, "node-fetch")).toEqual([2]);
  });

  /**
   * A line continuation contributes no character, in all five spellings
   * of one.
   *
   * JavaScript has four line terminators and CR LF is a fifth spelling,
   * being one terminator written with two characters. Every one of these
   * resolves to the refused `node-fetch`, so every one of them has to be
   * locatable — only LF was, which left an ordinary import in a module
   * written on Windows refused by a message that pointed nowhere.
   *
   * Written as `\u2028` and `\u2029` rather than as themselves: they
   * are invisible characters that several editors and diff tools treat
   * as line breaks, and source nobody can review is its own defect.
   */
  it.each([
    ["LF", "\n"],
    ["CR", "\r"],
    ["CRLF", "\r\n"],
    ["LS", "\u2028"],
    ["PS", "\u2029"],
  ])("finds a specifier a %s line continuation splits", (_terminator, breaks) => {
    expect(linesOf(`const before = 1;\nimport fetch from "node\\${breaks}-fetch";\n`, "node-fetch")).toEqual([2]);
  });

  /**
   * A continuation joins the literal it is inside and nothing else.
   *
   * The near miss on line 1 is a different string, so it is not a site;
   * the import below it is, and the continuation must not have cost the
   * scan its place in the file. Line 3 rather than 2 because a
   * continuation spends a real line to write no character — which is the
   * whole reason a refusal has to count lines rather than statements.
   */
  it("keeps its place in the file across a continuation", () => {
    const code = ['const a = "node\\', '-fetc";', 'import fetch from "node-fetch";', ""].join("\r\n");
    expect(linesOf(code, "node-fetch")).toEqual([3]);
  });

  // Every one of these mentions the package and none of them imports it.
  // A refusal citing any of them sends its author to the wrong line, and
  // enough of them push the real import past the cap entirely.
  it.each([
    ["a line comment", '// "node-fetch" is not portable.'],
    ["a block comment", '/* "node-fetch" is not portable. */'],
    ["a docstring the old patterns misread", '/** One important detail: it differs from "node-fetch". */'],
    ["a string that is merely a string", 'const name = "node-fetch";'],
    ["an object key called from", 'const options = { from: "node-fetch" };'],
    ["a call whose argument is called from", 'report(from, "node-fetch");'],
    ["a regular expression with a quote in it", 'const quoted = /["\']node-fetch["\']/;'],
  ])("ignores %s", (_shape, line) => {
    expect(linesOf(`${line}\nexport default async function run() {}\n`, "node-fetch")).toEqual([]);
  });

  /**
   * A word spelled like a keyword is not one when somebody is reading it
   * off an object, and a literal after it imports nothing.
   *
   * `registry.import("node-fetch")` calls a method. So does
   * `registry?.import(…)`, which is that same read with a `?` written in
   * front of the dot, and `this.#import(…)` on a private one. The loader
   * is never asked about any of them — but each was read as an `import(`
   * call, so five written above a real import spent all five of the
   * refusal's citations on lines that import nothing and pushed the one
   * that does off the end as "…and 1 more", leaving the refusal saying
   * everything except where.
   *
   * `from` fails the same way through semicolon insertion. A line ending
   * between `o.from` and a literal is a statement boundary JavaScript
   * puts there and the source does not show, so testing adjacency alone
   * read two unrelated statements as one import. Walking back to the head
   * of the clause is what tells them apart — and a reserved word ends the
   * walk, which is what stops `export { helper }` with `let from` written
   * under it being read as a single import spanning both.
   *
   * The tagged template is the third spelling: a static specifier is a
   * quoted string and never a template, because an import written in
   * backticks does not parse. So a literal in backticks after `from` is a
   * tag being called. A dynamic import takes one happily, being an
   * ordinary expression — which is why the static and dynamic shapes are
   * asked separately, and why the template row in the first table above
   * still resolves rather than being caught by this.
   *
   * Every row is valid ESM that mentions the package and imports nothing,
   * and every row produced a false site before this.
   */
  it.each([
    ["a method named import", 'const registry = { import: (n) => n };\nregistry.import("node-fetch");'],
    ["a method named import reached through ?.", 'const registry = { import: (n) => n };\nregistry?.import("node-fetch");'],
    ["a private method named import", "class C { #import(n) { return n; } m() { this.#import(\"node-fetch\"); } }"],
    ["a property named from that a literal follows", 'const o = { from: 1 };\nconst x = o.from\n"node-fetch"\n;'],
    ["a variable named from that a literal follows", 'const from = 1;\nconst y = from\n"node-fetch"\n;'],
    ["a template tagged with a function named from", "const from = (s) => s;\nconst v = from`node-fetch`;"],
    ["an export list a from declaration follows", 'export { helper };\nfunction helper() {}\nlet from = 1;\nlet z = from\n"node-fetch"\n;'],
  ])("ignores %s", (_shape, line) => {
    expect(linesOf(`${line}\nexport default async function run() {}\n`, "node-fetch")).toEqual([]);
  });

  /**
   * The same reading, on the fallback that reports an assembled
   * specifier.
   *
   * `o.import(a + b)` is a call this cannot read the argument of either,
   * but it is not an import, and reporting it would point an author at a
   * line that reaches for nothing. The real `import()` calls are pinned
   * beside it because the fix for one is the bug in the other: a rule
   * strict enough to drop a member call can drop the keyword too.
   */
  it.each([
    ["a member call", "const o = { import: (x) => x };\no.import(a + b);", 0],
    ["a member call reached through ?.", "const o = { import: (x) => x };\no?.import(a + b);", 0],
    ["a private member call", "class C { #import(x) { return x; } m() { this.#import(a + b); } }", 0],
    ["an assembled dynamic import", 'const p = import("node-" + name);', 1],
    ["a dynamic import of a variable", "const p = import(name);", 1],
    ["a dynamic import of a substituted template", "const p = import(`node:${name}`);", 1],
    ["a dynamic import of a plain literal", 'const p = import("node:os");', 0],
    ["a dynamic import with attributes", 'const p = import("node:os", { with: { type: "json" } });', 0],
  ])("counts the assembled specifiers %s asks for", (_shape, line, count) => {
    expect((computedImportSites(`${line}\nexport default async function run() {}\n`) as unknown[]).length).toBe(count);
  });

  /**
   * A line ends in all four spellings, and CR LF is one line rather than
   * two.
   *
   * `siteAt` counted LF alone, so an import on the second line of a
   * CR-only, LS- or PS-separated module was reported as being on line 1
   * with both lines quoted back at its author joined into one. The lexer
   * had the same hole from the other side: a `//` comment ran to the
   * next LF, so in such a module the first comment swallowed every
   * import below it and the refusal could point at nothing at all. Both
   * are asserted here — the comment does not run on, and the line quoted
   * is one line.
   *
   * Written as `\u2028` and `\u2029` rather than as themselves, for the
   * same reason as the continuations above: source nobody can review is
   * its own defect.
   */
  it.each([
    ["LF", "\n"],
    ["CR", "\r"],
    ["CRLF", "\r\n"],
    ["LS", "\u2028"],
    ["PS", "\u2029"],
  ])("counts a %s as the end of a line", (_terminator, breaks) => {
    const code = `// a note about what this module does${breaks}import fetch from "node-fetch";${breaks}`;
    expect(specifierSites(code, "node-fetch") as { line: number; text: string }[]).toEqual([{ line: 2, text: 'import fetch from "node-fetch";' }]);
  });

  /**
   * A `/` opens a regular expression or divides, and after `}` or `)` it
   * depends on what that bracket *opened*.
   *
   * Reading every closing bracket as the end of an expression is the
   * usual shorthand and is wrong for a block, so `if (false) {} /"/` was
   * read as a division and then a string literal opening at that quote —
   * which ran on and swallowed the import after it on the line, leaving
   * the refusal nowhere to point. That is the failure this item is
   * about, reached from the other direction: not prose read as an
   * import, but an import read as prose.
   *
   * The divisions are pinned alongside because the fix for one is the
   * bug in the other. A `/` wrongly taken for a regular expression runs
   * to the end of its line and takes the import with it, so each of
   * these is written with a single `/` — enough to swallow the rest of
   * the line if it were misread.
   */
  it.each([
    ["a regular expression after a block", 'if (false) {} /"/.test("x");'],
    ["a regular expression after an if with no block", 'if (false) /"/.test("x");'],
    ["a regular expression after a class body", 'class A {} /"/.test("x");'],
    ["a regular expression starting a statement", '/"/.test("x");'],
    ["a regular expression after an arrow body", 'const f = () => {}; /"/.test("x");'],
    ["a division of an object literal", "const half = {} / 2;"],
    ["a division of a parenthesised expression", "const third = (6) / 2;"],
    ["a division of what a call returned", 'const rate = size("x") / 2;'],
    ["a division of an element", "const first = sizes[0] / 2;"],
  ])("finds an import written past %s", (_shape, line) => {
    expect(linesOf(`${line} import fetch from "node-fetch";`, "node-fetch")).toEqual([1]);
  });

  /**
   * JavaScript writes four different things with a `:`, and a `{` after
   * two of them opens a block rather than an object literal.
   *
   * A property's colon (`{ n: {} }`) and a ternary's (`ok ? 1 : {}`) are
   * each followed by an expression; a label's (`retry: {}`) and a case's
   * (`case 1: {}`) are each followed by a statement. Reading every colon
   * as a property's made `retry: {} /"/` a division and then a string,
   * and that string swallowed the import after it — the failure above
   * exactly, one colon further out.
   *
   * `??` and `?.` are in here because only a ternary's `?` may be
   * answered by a `:` and all three are spelled with the same mark. A
   * `??` counted as two questions leaves a label's colon answering one
   * of them, which is the same bug reached by another route.
   *
   * The last two rows are divisions, and they passed before this and
   * have to keep passing: they are what stops the fix for a label
   * becoming a bug for a property, since a `/` wrongly taken for a
   * regular expression runs to the end of its line and takes the import
   * with it.
   */
  it.each([
    ["a labelled block", 'retry: {} /"/.test("x");'],
    ["a labelled block inside a function", 'function f() { retry: {} /"/.test("x"); }'],
    ["a case body", 'switch (1) { case 1: {} /"/.test("x"); }'],
    ["a default body", 'switch (1) { default: {} /"/.test("x"); }'],
    ["a labelled block past a ternary", 'const value = ok ? 1 : 2; retry: {} /"/.test("x");'],
    ["a labelled block past a nullish default", 'const value = given ?? 1; retry: {} /"/.test("x");'],
    ["a labelled block past an optional read", 'const value = given?.n; retry: {} /"/.test("x");'],
    ["a division inside an object literal", "const sizes = { half: {} / 2 };"],
    ["a division after a ternary's colon", "const half = ok ? 1 : {} / 2;"],
  ])("finds an import written after %s", (_shape, line) => {
    expect(linesOf(`${line} import fetch from "node-fetch";`, "node-fetch")).toEqual([1]);
  });

  /**
   * A `/` divides when what stands before it ends an operand, and two
   * things that end one are written with marks that otherwise do not.
   *
   * `n++` is the first. Listing the marks that end an operand — `]`,
   * and a `}` or `)` that closed an expression — missed it, so
   * `n++ / 2` was read as a regular expression opening; it ran to the
   * end of the line and took the import written after it there into
   * itself. `/a/` is the second: a regular expression is an operand
   * too, and `/a/ / 2` divides one, but the lexer stepped over the
   * literal without leaving a token behind to be asked.
   *
   * The last three rows are regular expressions, and they passed before
   * this and have to keep passing: a `++` read as postfix where it is a
   * prefix, or a `+ +` mistaken for one, is this same bug with its sign
   * reversed. Every row puts a single `/` after the shape under test,
   * so a misreading runs to the end of the line and takes the import.
   */
  it.each([
    ["a division by a postfix increment", "let n = 1; n++ / 2;"],
    ["a division by a postfix decrement", "let n = 1; n-- / 2;"],
    ["a division by a postfix increment of a property", "const o = { n: 1 }; o.n++ / 2;"],
    ["a division by a postfix increment of an element", "const sizes = [1]; sizes[0]++ / 2;"],
    ["a division of a regular expression", 'const ratio = /"/ / 2;'],
    ["a division of a regular expression with a class in it", 'const ratio = /["]/ / 2;'],
    ["a regular expression after a binary plus", 'const total = 1 + /"/.source.length;'],
    ["a regular expression after a unary plus that touches it", 'const total = 1+ +/"/.source.length;'],
    ["a regular expression after a postfix increment and a plus", 'let n = 1; n++ + /"/.source.length;'],
  ])("finds an import written past %s", (_shape, line) => {
    expect(linesOf(`${line} import fetch from "node-fetch";`, "node-fetch")).toEqual([1]);
  });

  /**
   * A function or class body ends a statement or an operand depending
   * on what its keyword was written after, which is several tokens back.
   *
   * `function g() {} /"/.test("x")` is a declaration and then a regular
   * expression; `const f = function () {} / 2` is an expression being
   * divided. From the `}` backwards the two are spelled identically, so
   * the `}` cannot answer for itself and the keyword has to answer for
   * it — which is why the parameter list in between must not be allowed
   * to look like the body (`function (a = {}) {}`), and why a keyword
   * written as a property name (`{ class: 1 }`) must not collect the
   * next brace that turns up.
   */
  it.each([
    ["a function expression", "const f = function () {} / 2;"],
    ["a named function expression", "const f = function g() {} / 2;"],
    ["an async function expression", "const f = async function () {} / 2;"],
    ["a generator expression", "const f = function* () {} / 2;"],
    ["a function expression with a default parameter", "const f = function (a = {}) {} / 2;"],
    ["a class expression", "const C = class {} / 2;"],
    ["a named class expression", "const C = class A {} / 2;"],
    ["a class expression that extends", "const C = class A extends Object {} / 2;"],
    ["an object literal after a property named class", "const o = { class: 1, half: {} / 2 };"],
  ])("finds an import written past a division of %s", (_shape, line) => {
    expect(linesOf(`${line} import fetch from "node-fetch";`, "node-fetch")).toEqual([1]);
  });

  /**
   * The declarations, which passed before the fix above and are what
   * stops it becoming a bug for them: a body read as an expression's
   * makes the `/` after it a division, and a division swallows nothing
   * but is equally wrong.
   */
  it.each([
    ["a function declaration", 'function g() {} /"/.test("x");'],
    ["an async function declaration", 'async function g() {} /"/.test("x");'],
    ["an exported function declaration", 'export function g() {} /"/.test("x");'],
    ["a default-exported function declaration", 'export default function () {} /"/.test("x");'],
    ["a class declaration", 'class A {} /"/.test("x");'],
    ["a default-exported class declaration", 'export default class {} /"/.test("x");'],
    ["a function declared inside a function", 'function outer() { function inner() {} /"/.test("x"); }'],
    ["a statement past a property named class", 'const o = { class: 1 }; if (1) {} /"/.test("x");'],
  ])("finds an import written past a regular expression after %s", (_shape, line) => {
    expect(linesOf(`${line} import fetch from "node-fetch";`, "node-fetch")).toEqual([1]);
  });

  /**
   * A number ends an operand, and a number may end in a dot.
   *
   * `1./2` divides. Reading the source a character at a time, that
   * point looked like the member dot in `o./…`, after which the `/`
   * opened a regular expression that ran to the end of the line and
   * took the import written there into itself. So a numeric literal is
   * read as one token, its own point included — which is also what
   * keeps `1..toString()` right, that spelling existing precisely
   * because the first dot belongs to the number and the second does
   * not.
   *
   * `flag?.5:{}` is the same dot one mark further left: `?.` is not
   * optional chaining when a digit follows it, so the `?` is a
   * ternary's and the `{}` answering it is an object literal rather
   * than a block — and a `/` after an object literal divides.
   *
   * Only the first five rows reproduced the failure and the rest are
   * guards, which is worth knowing before trusting the count. The
   * others were saved by something incidental — a second `/` on the
   * line closes the regular expression a first one wrongly opened
   * (`1. / 2. / 3`), and a point written before a `]`, a `)` or a `}`
   * is asked about that bracket rather than about itself. They are here
   * because the fix for one reading is the bug in the other: every row
   * puts a single `/` after the shape under test, so a misreading runs
   * to the end of the line and takes the import with it.
   */
  it.each([
    ["a number written with a trailing point", "const quotient = 1./2;"],
    ["a zero written with a trailing point", "const quotient = 0./2;"],
    ["a number written with a trailing point and a space", "const quotient = 1. / 2;"],
    ["a negated number written with a trailing point", "const quotient = -1. / 2;"],
    ["an object literal answering a ternary asked with a fraction", "const quotient = flag?.5:{} / 2;"],
    ["a number written with a trailing point, twice", "const quotient = 1. / 2. / 3;"],
    ["a number written with a trailing point inside an element", "const quotient = [1.] / 2;"],
    ["a number written with a trailing point inside a call", "const quotient = String(1.) / 2;"],
    ["a number written with a trailing point inside an object literal", "const quotient = { n: 1. } / 2;"],
    ["a number written with a point and a fraction", "const quotient = 1.5/2;"],
    ["a fraction written with no whole part", "const quotient = .5/2;"],
    ["a number's point read before a member dot", "const length = 1..toString().length/2;"],
    ["a number written in hex", "const quotient = 0x1f/2;"],
    ["a number written with an exponent", "const quotient = 1.5e-3/2;"],
    ["a bigint", "const quotient = 10n/2n;"],
    ["a member dot, which is not a number's", "const quotient = size.width/2;"],
  ])("finds an import written past a division of %s", (_shape, line) => {
    expect(linesOf(`${line} import fetch from "node-fetch";`, "node-fetch")).toEqual([1]);
  });

  /**
   * And the regular expressions that a number must not turn into
   * divisions.
   *
   * A rule that says "a number ends an operand" has to know where the
   * number ends: `1..toString()` puts a member dot immediately after
   * one, and a class may extend one. All four passed before the fix
   * above and are here to stop it becoming the opposite bug.
   */
  it.each([
    ["a class extending a number", 'class E extends 1 {} /"/.test("x");'],
    ["a statement past a number's own point", 'const n = 1.; /"/.test("x");'],
    ["a statement past a member call on a number", 'const s = 1..toString(); /"/.test("x");'],
    ["a case body past a fraction", 'switch (1) { case .5: {} /"/.test("x"); }'],
  ])("finds an import written past a regular expression after %s", (_shape, line) => {
    expect(linesOf(`${line} import fetch from "node-fetch";`, "node-fetch")).toEqual([1]);
  });

  /**
   * A `++` that begins a line is a prefix, whatever is written above it.
   *
   * JavaScript inserts a semicolon before one — `o\n++x` is two
   * statements and not one — so the thing above is not its operand, and
   * a `/` after it opens a regular expression rather than dividing.
   * Deciding postfix from the tokens alone would call this one postfix
   * and turn that regular expression into a division, which is the
   * failure above with its sign reversed. A line ending inside a
   * comment counts for semicolon insertion exactly as one in the open
   * does, which is the second row.
   *
   * Both passed before this change too, and are here for the same
   * reason the divisions above are: they are what stops the fix for
   * `n++ / 2` becoming a bug for `++n`.
   */
  it.each([
    ["a line ending", 'const o = { n: 1 };\no\n++ /"/.source.length;', 3],
    ["a comment that spans lines", 'const o = { n: 1 }; o /*\n*/ ++ /"/.source.length;', 2],
  ])("reads a ++ written past %s as a prefix", (_shape, before, line) => {
    expect(linesOf(`${before} import fetch from "node-fetch";`, "node-fetch")).toEqual([line]);
  });

  /**
   * `import.meta.resolve` reaches the loader, so it names a specifier.
   *
   * The property is read in more than one way and every way reaches the
   * same function: through a dot, through brackets, and either of those
   * written optionally. The head of it is matched literally rather than
   * as a member read, because `import.meta` is a fixed pair of tokens —
   * `import?.meta` does not parse.
   */
  it.each([
    ["a dot", 'import.meta.resolve("node-fetch");'],
    ["an optional dot", 'import.meta?.resolve("node-fetch");'],
    ["brackets", 'import.meta["resolve"]("node-fetch");'],
    ["optional brackets", 'import.meta?.["resolve"]("node-fetch");'],
    ["a template specifier", "import.meta.resolve(`node-fetch`);"],
    ["a specifier written with an escape", 'import.meta.resolve("node\\x2dfetch");'],
    ["a comment inside it", 'import.meta/*x*/.resolve("node-fetch");'],
  ])("finds an import.meta.resolve written with %s", (_shape, line) => {
    expect(linesOf(`const before = 1;\n${line}\n`, "node-fetch")).toEqual([2]);
  });

  /**
   * An optional call is the same call.
   *
   * `?.` between a callee and its bracket is two more marks and no
   * difference to the loader: `import.meta.resolve?.("node-fetch")`
   * resolves what the plain spelling resolves and gets the run refused
   * the same way, while being read as neither an import statement, an
   * `import(` call, nor an `import.meta.resolve` — so the refusal named
   * the package and pointed nowhere.
   *
   * Every way of reading the property is written here against the
   * optional call, because reaching the head of one of these is two
   * separate steps back through the tokens and either step alone was
   * enough to lose the line.
   */
  it.each([
    ["a dot", 'import.meta.resolve?.("node-fetch");'],
    ["an optional dot", 'import.meta?.resolve?.("node-fetch");'],
    ["brackets", 'import.meta["resolve"]?.("node-fetch");'],
    ["optional brackets", 'import.meta?.["resolve"]?.("node-fetch");'],
    ["a template specifier", "import.meta.resolve?.(`node-fetch`);"],
    ["a specifier written with an escape", 'import.meta.resolve?.("node\\x2dfetch");'],
    ["space around the marks", 'import.meta.resolve ?. ("node-fetch");'],
    ["a comment before the bracket", 'import.meta.resolve?./*x*/("node-fetch");'],
  ])("finds an optional import.meta.resolve call written with %s", (_shape, line) => {
    expect(linesOf(`const before = 1;\n${line}\n`, "node-fetch")).toEqual([2]);
  });

  /**
   * And a word spelled like the keyword is not the keyword.
   *
   * None of these reaches the loader, so a refusal citing one sends its
   * author to a line that resolves nothing — and enough of them push the
   * line that does past the cap entirely, which is how this same mistake
   * read `registry.import(…)` as an import.
   *
   * The optional spellings are the same list again, because a rule
   * loose enough to see past `?.` to the callee is loose enough to see
   * past it to somebody's method.
   */
  it.each([
    ["a property named meta", 'o.meta.resolve("node-fetch");'],
    ["a property named import", 'o.import.meta.resolve("node-fetch");'],
    ["a private property named import", 'this.#import.meta.resolve("node-fetch");'],
    ["another property of import.meta", 'import.meta.url("node-fetch");'],
    ["another property read through brackets", 'import.meta["url"]("node-fetch");'],
    ["a property named resolve on something else", 'o.resolve("node-fetch");'],
    ["an object with a resolve key", 'const o = { resolve: "node-fetch" };'],
    ["a method named import, called optionally", 'o.import?.("node-fetch");'],
    ["a method named resolve, called optionally", 'o.resolve?.("node-fetch");'],
    ["a private method named import, called optionally", 'this.#import?.("node-fetch");'],
    ["a property named import, reached optionally", 'o.import.meta.resolve?.("node-fetch");'],
    ["another property of import.meta, called optionally", 'import.meta.url?.("node-fetch");'],
    ["a ternary whose consequent is a fraction", 'const n = flag ? .5 : from("node-fetch");'],
  ])("does not read %s as a resolution", (_shape, line) => {
    expect(linesOf(`const before = 1;\n${line}\n`, "node-fetch")).toEqual([]);
  });

  // The same fallback the assembled `import()` gets, for the same
  // reason: the call reaches the loader, so it can be the one that got
  // the run refused, and its argument cannot be read from the source.
  it.each([
    ["a variable", "import.meta.resolve(name);"],
    ["a concatenation", 'import.meta.resolve("no" + "de-fetch");'],
    ["a template with a substitution", "import.meta.resolve(`node-${which}`);"],
    ["a variable, called optionally", "import.meta.resolve?.(name);"],
    ["a concatenation, called optionally", 'import.meta.resolve?.("no" + "de-fetch");'],
  ])("points at an import.meta.resolve whose argument is %s", (_shape, line) => {
    expect((computedImportSites(`const before = 1;\n${line}\n`) as { line: number }[]).map((site) => site.line)).toEqual([2]);
  });

  it.each([
    ['import.meta.resolve("node:os");'],
    ['o.import.meta.resolve(name);'],
    ['import.meta.resolve?.("node:os");'],
    ["o.resolve?.(name);"],
  ])("does not call %s a computed import", (line) => {
    expect(computedImportSites(line)).toEqual([]);
  });

  it("finds every place one specifier is written", () => {
    const code = ['import fetch from "node-fetch";', '// "node-fetch" again, in prose.', 'export { get } from "node-fetch";'].join("\n");
    expect(linesOf(code, "node-fetch")).toEqual([1, 3]);
  });

  // The fallback, for a specifier that is written nowhere because the
  // module built it. The `import(` that asked is the honest thing to
  // point at.
  it.each([
    ["a concatenation", 'await import("fi" + "le:///tmp/evil.mjs");'],
    ["a variable", "await import(half + suffix);"],
    ["a call", 'await import(String("node:os"));'],
    ["a template with a substitution", "await import(`node:${which}`);"],
  ])("points at an import() whose argument is %s", (_shape, line) => {
    expect((computedImportSites(`const before = 1;\n${line}\n`) as { line: number }[]).map((site) => site.line)).toEqual([2]);
  });

  it.each([['await import("node:os");'], ['await import("node:os", { with: { type: "json" } });']])("does not call %s a computed import", (line) => {
    expect(computedImportSites(line)).toEqual([]);
  });
});

/**
 * A module asking a question rather than reporting a fact (EO-76).
 *
 * Through a real host, because the whole story is one function inside
 * it: `normalize` reduced every refusal to `{ ok: false, reason }`, so a
 * module could state that something was wrong and never name what it
 * would accept. What the options then become — buttons on an escalation
 * comment — is `runBuiltin`'s doing and is covered where that lives.
 *
 * The suspicion is the point. An option is not decoration: it is a
 * button somebody clicks, the click is the text of their reply, and that
 * reply is what the next dispatch reads back. So a module's claim about
 * what it is offering is checked exactly as hard as its claim to have
 * succeeded.
 */
describe("a module that refuses with answers", () => {
  /** The reason is constant across these — what varies is what it claims to offer. */
  const refusing = (options: string) =>
    run(moduleWith(`export default async function run() { return { ok: false, reason: "CI failed on the branch.", options: ${options} }; }`));

  /** Narrows, and fails loudly if a module that was told to refuse did not. */
  function refusal(outcome: ModuleOutcome): { ok: false; reason: string; options?: string[] } {
    if (outcome.ok) throw new Error(`the module was supposed to refuse, and returned "${outcome.result}"`);
    return outcome;
  }

  it("carries the answers it named", async () => {
    expect(refusal(await refusing(`["Merge anyway", "Re-run CI", "Send it back"]`))).toEqual({
      ok: false,
      reason: "CI failed on the branch.",
      options: ["Merge anyway", "Re-run CI", "Send it back"],
    });
  });

  /**
   * The behaviour every module shipped before this story has.
   *
   * `toEqual` rather than a field check: an `options: []` appearing on a
   * refusal that never asked anything would be a question with no
   * question in it, and `runBuiltin` would have to know to ignore it.
   */
  it("is unchanged for a refusal that names none", async () => {
    const outcome = await run(moduleWith(`export default async function run() { return { ok: false, reason: "flyctl is not installed." }; }`));
    expect(outcome).toEqual({ ok: false, reason: "flyctl is not installed." });
  });

  // Not a list of non-empty strings, in every way a module gets that
  // wrong. The refusal still escalates and still says why — `reason` is
  // the part that must never be lost, and the options are the shortcut.
  it.each([`"Merge anyway"`, `[]`, `[""]`, `["   "]`, `[null]`, `[undefined]`, `[42]`, `[["Merge anyway"]]`, `{ 0: "Merge anyway" }`, `null`, `true`])(
    "drops options of %s and escalates on the reason alone",
    async (options) => {
      const outcome = refusal(await refusing(options));
      expect(outcome.reason).toBe("CI failed on the branch.");
      expect(outcome.options).toBeUndefined();
    },
  );

  // Per entry rather than all-or-nothing: a module that named three
  // answers and one stray `undefined` meant the three, and throwing them
  // away turns a small mistake into a question with no buttons at all.
  it("keeps the answers it can use and drops the rest", async () => {
    expect(refusal(await refusing(`["Merge anyway", null, "Send it back"]`)).options).toEqual(["Merge anyway", "Send it back"]);
  });

  // Whitespace is noise in a button, and noise in the text a reply is
  // compared against.
  it("trims what it offers", async () => {
    expect(refusal(await refusing(`["  Merge anyway\\n"]`)).options).toEqual(["Merge anyway"]);
  });

  it("caps how many answers one refusal may offer", async () => {
    const many = Array.from({ length: MAX_OPTIONS + 3 }, (_, index) => `"answer ${index}"`).join(", ");
    const outcome = refusal(await refusing(`[${many}]`));

    expect(outcome.options).toHaveLength(MAX_OPTIONS);
    // The first ones, not the last: a module names its answers in the
    // order it wants them read.
    expect(outcome.options?.[0]).toBe("answer 0");
  });

  /**
   * Dropped rather than truncated, which is the one deliberately lossy
   * choice here.
   *
   * The label a person clicks is the text the next run matches against.
   * Half of an option would offer an answer nobody named, and match
   * nothing when it came back.
   */
  it("drops an answer too long to be a button, and keeps one exactly at the cap", async () => {
    const exact = "x".repeat(MAX_OPTION_CHARS);
    const outcome = refusal(await refusing(`[${JSON.stringify(exact)}, ${JSON.stringify(`${exact}x`)}]`));

    expect(outcome.options).toEqual([exact]);
  });

  /**
   * An option reaches the escalation comment, and that comment is
   * mirrored to Jira — so a token in one leaves the machine, which is
   * more than `reason` and `detail` risk between them.
   */
  it("strips a secret from an answer", async () => {
    const code = `export default async function run() { return { ok: false, reason: "Which one?", options: ["retry with " + process.env.TOKEN] }; }`;
    const module = moduleWith(code, { needs: { bin: [], env: ["TOKEN"], network: false, item: false, comment: false, attach: false, create: false } });

    expect(refusal(await run(module, { env: { TOKEN: "s3cret-value" } })).options).toEqual(["retry with «TOKEN»"]);
  });

  /**
   * The cap has to hold on the string that is actually rendered, and
   * redaction is what makes that a different string.
   *
   * `redactSecrets` swaps a value for its *name*, and `ModuleNeedsSchema`
   * bounds a declared name's characters and never its length. So a
   * module declaring a very long variable holding a very short value
   * hands the host an option comfortably inside the cap and has EO
   * itself turn it into one outside — the host having already finished
   * looking. Checked on both sides for that reason, and dropped rather
   * than truncated on both, because half a label is an answer nobody
   * named.
   */
  it("drops an answer redaction pushed past the cap, and keeps one it left exactly at it", async () => {
    // «NAME» is the name plus two guillemets: a 198-character name lands
    // exactly on the cap, and a 199-character one lands past it.
    const atCap = "A".repeat(MAX_OPTION_CHARS - 2);
    const pastCap = "B".repeat(MAX_OPTION_CHARS - 1);
    const env = { [atCap]: "short-value-one", [pastCap]: "short-value-two" };
    const code = `export default async function run() {
      return { ok: false, reason: "Which one?", options: [process.env.${atCap}, process.env.${pastCap}, "Neither"] };
    }`;
    const module = moduleWith(code, { needs: { bin: [], env: [atCap, pastCap], network: false, item: false, comment: false, attach: false, create: false } });

    const outcome = refusal(await run(module, { env }));

    expect(outcome.options).toEqual([`«${atCap}»`, "Neither"]);
    expect(outcome.options?.[0]).toHaveLength(MAX_OPTION_CHARS);
    // A question can lose a button. It never loses the reason.
    expect(outcome.reason).toBe("Which one?");
  });

  /**
   * Nothing survives redaction, so there is nothing to ask with — and
   * the refusal still has to escalate on its reason.
   *
   * `runBuiltin` reads a missing `options` and an empty one differently
   * enough that "no question in it" has to arrive as the former.
   */
  it("escalates on the reason alone when redaction leaves no usable answer", async () => {
    const pastCap = "B".repeat(MAX_OPTION_CHARS - 1);
    const code = `export default async function run() { return { ok: false, reason: "Which one?", options: [process.env.${pastCap}] }; }`;
    const module = moduleWith(code, { needs: { bin: [], env: [pastCap], network: false, item: false, comment: false, attach: false, create: false } });

    expect(await run(module, { env: { [pastCap]: "short-value" } })).toEqual({ ok: false, reason: "Which one?" });
  });
});

/**
 * What the review found (see the header on `moduleHost.mjs` for what
 * this boundary is and is not).
 *
 * Each of these was a real escape or a real leak before the fix, and
 * each is written to fail against the code as it was.
 */
describe("things a module must not get away with", () => {
  // fd 4 is an inherited descriptor in the host's own process, so a
  // module reaches it through `node:fs`. Writing a plausible result and
  // exiting before the host answered made a failed deploy read as a
  // successful one.
  it("ignores a result the module writes to the result channel itself", async () => {
    const code = `
      import { writeSync } from "node:fs";
      export default async function run() {
        writeSync(4, JSON.stringify({ ok: true, result: "deployed", detail: "forged" }));
        process.exit(0);
      }`;
    const outcome = await run(moduleWith(code, { results: ["deployed"] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).not.toContain("forged");
  });

  // EO-436. The nonce stops a line the module wrote blind; it did not
  // stop a module that was *called* while the host wrote its own. The
  // host used to hand `{ nonce, payload }` to `JSON.stringify`, which
  // asks every object for a `toJSON` — through `Object.prototype`, where
  // a module can leave one. Called on the envelope it is holding the
  // nonce, and a line written under it there lands ahead of the host's.
  describe("when it is called while the host writes its answer", () => {
    // Written by hand rather than with `JSON.stringify`, which would call
    // the hook again from inside itself.
    const FORGED_PAYLOAD = `{"ok":true,"result":"deployed","detail":"FORGED"}`;
    const stealsTheNonce = `
      import { writeSync } from "node:fs";
      Object.prototype.toJSON = function () {
        if (typeof this.nonce === "string") writeSync(4, '{"nonce":"' + this.nonce + '","payload":${FORGED_PAYLOAD}}\\n');
        return this;
      };`;
    const rewritesThePayload = `
      const forged = { ok: true, result: "deployed", detail: "FORGED" };
      Object.prototype.toJSON = function () { return this === forged ? this : "payload" in this ? { nonce: this.nonce, payload: forged } : forged; };
      Array.prototype.toJSON = function () { return ["FORGED"]; };`;

    it.each([
      ["a line of its own under the nonce it was handed", stealsTheNonce],
      ["a different payload for the host to sign", rewritesThePayload],
    ])("records the host's refusal, not %s", async (_name, hook) => {
      const code = `${hook}
        export default async function run() { return { ok: false, reason: "honest" }; }`;
      const outcome = await run(moduleWith(code, { results: ["deployed"] }));
      expect(outcome).toEqual({ ok: false, reason: "honest" });
    });

    it.each([
      ["a line of its own under the nonce it was handed", stealsTheNonce],
      ["a different payload for the host to sign", rewritesThePayload],
    ])("records the result an honest success named, not %s", async (_name, hook) => {
      const code = `${hook}
        export default async function run() { return { ok: true, result: "ok", detail: "real" }; }`;
      const outcome = await run(moduleWith(code, { results: ["ok", "deployed"] }));
      expect(outcome).toEqual({ ok: true, result: "ok", detail: "real" });
    });

    // The host's own verdicts, which no module returned: a throw, and a
    // return value that is not an outcome at all.
    it("records a throw as a failure", async () => {
      const code = `${stealsTheNonce}
        export default async function run() { throw new Error("the deploy failed"); }`;
      const outcome = await run(moduleWith(code, { results: ["deployed"] }));
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toContain("the deploy failed");
    });

    it("records a return value that is not an outcome as a failure", async () => {
      const code = `${rewritesThePayload}
        export default async function run() { return { result: "deployed" }; }`;
      const outcome = await run(moduleWith(code, { results: ["deployed"] }));
      expect(outcome.ok).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain("FORGED");
    });

    it("still offers the answers a refusal named", async () => {
      const code = `${rewritesThePayload}
        export default async function run() { return { ok: false, reason: "Which one?", options: ["Staging", "Production"] }; }`;
      const outcome = await run(moduleWith(code, { results: ["deployed"] }));
      expect(outcome).toEqual({ ok: false, reason: "Which one?", options: ["Staging", "Production"] });
    });
  });

  // A comment is whitespace to the tokenizer and not to `\s`, so an
  // import written this way was read by nothing — and an absolute
  // `file://` URL resolves fine from a data: URL, so the "two mechanisms"
  // claim was one.
  it("sees an import hidden behind a comment", async () => {
    const outcome = await run(moduleWith(`import/*x*/{ a } from "file:///tmp/evil.mjs";\nexport default async function run() { return { ok: true, result: "ok" }; }`));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("file:///tmp/evil.mjs");
  });

  // Read by nothing, once: it satisfied neither the import patterns nor
  // the guard that excluded a leading quote. The loader is handed what
  // the concatenation produced, so it is now refused by name rather than
  // as "a computed import" the author had to go and find.
  it("sees a concatenated import specifier", async () => {
    const code = `export default async function run() { const m = await import("fi" + "le:///tmp/evil.mjs"); return { ok: true, result: "ok" }; }`;
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("file:///tmp/evil.mjs");
  });

  // A bare builtin name resolves to the builtin, and the rule is that a
  // module names one the long way. Refused, and told which way to write
  // it — the old refusal named the specifier and left the author to work
  // out what was wrong with it.
  it("refuses a builtin named without its node: prefix, and says how to write it", async () => {
    const outcome = await run(moduleWith(`import { sep } from "path";\nexport default async function run() { return { ok: true, result: "ok" }; }`));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('write "node:path"');
  });

  // Withheld is withheld either way it is written, and the refusal must
  // not send its author to a second one by telling them to spell it
  // `node:child_process`.
  it("does not tell a module to write a withheld builtin the long way", async () => {
    const outcome = await run(moduleWith(`import { spawn } from "child_process";\nexport default async function run() { return { ok: true, result: "ok" }; }`));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("one EO withholds");
    expect(outcome.ok === false && outcome.reason).not.toContain('write "node:child_process"');
  });

  // `startsWith("node:")` let these through. `child_process` makes
  // `needs.bin` unenforceable, and `module` reaches `createRequire`,
  // which loads npm packages and ends portability.
  it.each(["node:child_process", "node:module", "node:worker_threads", "node:vm"])("refuses %s", async (specifier) => {
    const outcome = await run(moduleWith(`import * as m from "${specifier}";\nexport default async function run() { return { ok: true, result: "ok" }; }`));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain(specifier);
  });

  // "not false" is not "true". A parsed API response that happens to
  // carry a `result` field would have routed an item on it.
  it.each([`{ result: "deployed" }`, `{ ok: 0, result: "deployed" }`, `{ ok: "yes", result: "deployed" }`])(
    "refuses a return of %s, which never said it succeeded",
    async (returned) => {
      const outcome = await run(moduleWith(`export default async function run() { return ${returned}; }`, { results: ["deployed"] }));
      expect(outcome.ok).toBe(false);
    },
  );

  /**
   * A secret in the outcome reaches `runs.error`, `runs.result` and an
   * escalation comment.
   *
   * The realistic trigger is not malice — it is
   * `return { ok: false, reason: result.tail }` after a command printed
   * the token.
   */
  it("strips a secret from a failure reason", async () => {
    const code = `export default async function run() { throw new Error("call failed: " + process.env.TOKEN); }`;
    const module = moduleWith(code, { needs: { bin: [], env: ["TOKEN"], network: false, item: false, comment: false, attach: false, create: false } });
    const outcome = await run(module, { env: { TOKEN: "s3cret-value" } });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).not.toContain("s3cret-value");
    expect(outcome.ok === false && outcome.reason).toContain("«TOKEN»");
  });

  it("strips a secret from a success detail", async () => {
    const code = `export default async function run() { return { ok: true, result: "ok", detail: "used " + process.env.TOKEN }; }`;
    const module = moduleWith(code, { needs: { bin: [], env: ["TOKEN"], network: false, item: false, comment: false, attach: false, create: false } });
    expect(await run(module, { env: { TOKEN: "s3cret-value" } })).toMatchObject({ ok: true, detail: "used «TOKEN»" });
  });

  // Redaction ran per chunk, so a secret split across a 64KB pipe
  // boundary appeared in neither chunk and in the stream. `run_events` is
  // append-only, so that leak is permanent.
  it("strips a secret that straddles two writes", async () => {
    const lines: string[] = [];
    const code = `
      export default async function run(ctx) {
        const token = process.env.TOKEN;
        process.stdout.write("x".repeat(65532) + token.slice(0, 4));
        await new Promise((r) => setTimeout(r, 50));
        process.stdout.write(token.slice(4) + "\\n");
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, result: "ok", detail: "" };
      }`;
    const module = moduleWith(code, { needs: { bin: [], env: ["TOKEN"], network: false, item: false, comment: false, attach: false, create: false } });
    await run(module, { env: { TOKEN: "s3cret-value-abcdef" }, onOutput: (text) => lines.push(text) });

    const transcript = lines.join("");
    expect(transcript).not.toContain("s3cret-value-abcdef");
    expect(transcript).toContain("«TOKEN»");
  }, 20_000);

  /**
   * A module that succeeded but left a handle open.
   *
   * `close` cannot fire while the event loop is non-empty, so it was
   * killed at the timeout and the valid result already written was
   * thrown away — parking the item for work that had finished, after
   * blocking the single concurrency slot for the full timeout.
   */
  it("keeps the result of a module that succeeded and left a timer running", async () => {
    const code = `export default async function run() { setInterval(() => {}, 1000); return { ok: true, result: "ok", detail: "done" }; }`;
    expect(await run(moduleWith(code), { timeoutMs: 1500 })).toMatchObject({ ok: true, result: "ok", detail: "done" });
  }, 20_000);
});

describe("what a module can reach", () => {
  // The promise `needs.env` makes. Asserted rather than assumed, because
  // the whole portability argument rests on a module being unable to
  // reach anything it did not declare.
  it("sees nothing of the environment it did not declare", async () => {
    process.env["EO_TEST_LEAK"] = "should-not-be-visible";
    try {
      const code = `export default async function run() { return { ok: true, result: "ok", detail: JSON.stringify({ leak: process.env.EO_TEST_LEAK ?? null, path: process.env.PATH ?? null }) }; }`;
      const outcome = await run(moduleWith(code));
      expect(outcome.ok).toBe(true);
      // PATH too: `ctx.exec` needs it, a module does not.
      expect(outcome.ok && JSON.parse(outcome.detail)).toEqual({ leak: null, path: null });
    } finally {
      delete process.env["EO_TEST_LEAK"];
    }
  });

  // Windows finds its socket and DNS provider DLLs through `SystemRoot`,
  // so emptying the environment cost a module its network (EO-613).
  describe("the one variable Windows needs", () => {
    const declaresNothing = {};

    it("keeps SystemRoot and nothing else on win32", () => {
      const host = { SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\me", HTTPS_PROXY: "http://proxy", EO_TEST_LEAK: "hidden" };
      expect(moduleEnv("win32", host, declaresNothing)).toEqual({ SystemRoot: "C:\\Windows" });
      expect(moduleEnv("win32", host, { TOKEN: "s3cret" })).toEqual({ SystemRoot: "C:\\Windows", TOKEN: "s3cret" });
    });

    it.each(["linux", "darwin"])("keeps nothing on %s", (platform) => {
      const host = { SystemRoot: "C:\\Windows", HOME: "/home/me" };
      expect(moduleEnv(platform, host, declaresNothing)).toEqual({});
      expect(moduleEnv(platform, host, { TOKEN: "s3cret" })).toEqual({ TOKEN: "s3cret" });
    });

    it("has nothing to keep when the host was not given it", () => {
      expect(moduleEnv("win32", {}, declaresNothing)).toEqual({});
    });

    // `SYSTEMROOT` is the same variable on Windows, so keeping both would
    // leave a child with whichever `spawn` happened to sort first.
    it.each(["SystemRoot", "SYSTEMROOT", "systemroot"])("lets a module's own %s win", (name) => {
      expect(moduleEnv("win32", { SystemRoot: "C:\\Windows" }, { [name]: "D:\\WINNT" })).toEqual({ [name]: "D:\\WINNT" });
    });

    it("is what EO passes the host on win32, and nothing on any other platform", () => {
      const env = { SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\me" };
      expect(systemRootEnv("win32", env)).toEqual({ SystemRoot: "C:\\Windows" });
      expect(systemRootEnv("win32", {})).toEqual({});
      expect(systemRootEnv("linux", env)).toEqual({});
      expect(systemRootEnv("darwin", env)).toEqual({});
    });

    it.runIf(process.platform === "win32")("resolves a name and hands SystemRoot to ctx.exec on a real run", async () => {
      const code = `
        import { lookup } from "node:dns/promises";
        export default async function run(ctx) {
          const { address } = await lookup("localhost");
          const child = await ctx.exec("cmd", ["/c", "echo %SystemRoot%"]);
          return { ok: true, result: "ok", detail: JSON.stringify({ address, own: process.env.SystemRoot, child: child.stdout.trim() }) };
        }`;
      const module = moduleWith(code, { needs: { bin: ["cmd"], env: [], network: true, item: false, comment: false, attach: false, create: false } });
      const outcome = await run(module);
      // The reason, not `ok`: what broke is the whole of this failing.
      expect(outcome.ok ? "ran" : outcome.reason).toBe("ran");
      const seen = outcome.ok ? (JSON.parse(outcome.detail) as { address?: string; own?: string; child?: string }) : {};
      expect(seen.address).toMatch(/^(127\.0\.0\.1|::1)$/);
      expect(seen.own).toBe(process.env["SystemRoot"]);
      expect(seen.child).toBe(process.env["SystemRoot"]);
    }, 20_000);

    it.skipIf(process.platform === "win32")("adds nothing to a module or its children anywhere else", async () => {
      process.env["SystemRoot"] = "C:\\Windows";
      try {
        const code = `export default async function run(ctx) {
          const child = await ctx.exec("env");
          return { ok: true, result: "ok", detail: JSON.stringify({ own: Object.keys(process.env), child: child.stdout.trim().split("\\n").map((line) => line.split("=")[0]).sort() }) };
        }`;
        const module = moduleWith(code, { needs: { bin: ["env"], env: ["TOKEN"], network: false, item: false, comment: false, attach: false, create: false } });
        const outcome = await run(module, { env: { TOKEN: "s3cret" } });
        expect(outcome.ok && JSON.parse(outcome.detail)).toEqual({ own: ["TOKEN"], child: ["PATH", "TOKEN"] });
      } finally {
        delete process.env["SystemRoot"];
      }
    }, 20_000);
  });

  // Reported as a comparison rather than by echoing the value: `detail`
  // reaches `runs.result` and a comment, so it is redacted like
  // everything else, and a test that echoed the token would be asserting
  // the leak rather than the delivery.
  it("receives a secret it declared", async () => {
    const code = `export default async function run() { return { ok: true, result: "ok", detail: String(process.env.TOKEN === "s3cret") }; }`;
    const module = moduleWith(code, { needs: { bin: [], env: ["TOKEN"], network: false, item: false, comment: false, attach: false, create: false } });
    expect(await run(module, { env: { TOKEN: "s3cret" } })).toMatchObject({ ok: true, detail: "true" });
  });

  it("runs a declared binary through ctx.exec", async () => {
    const code = `export default async function run(ctx) { const r = await ctx.exec("echo", ["hello"]); return { ok: true, result: "ok", detail: r.stdout.trim() }; }`;
    const module = moduleWith(code, { needs: { bin: ["echo"], env: [], network: false, item: false, comment: false, attach: false, create: false } });
    expect(await run(module)).toMatchObject({ ok: true, detail: "hello" });
  });

  // EO-655: an app opened from Finder does not inherit the person's PATH,
  // so the host is handed the one their login shell reported, and
  // `ctx.exec` finds what their terminal finds.
  it.skipIf(process.platform === "win32")("runs a declared binary only the login shell's PATH has", async () => {
    const bin = mkdtempSync(join(tmpdir(), "eo-login-bin-"));
    try {
      writeFileSync(join(bin, "eo-login-only-tool"), "#!/bin/sh\necho from the login shell\n");
      chmodSync(join(bin, "eo-login-only-tool"), 0o755);
      await resolveSearchPath({
        platform: "linux",
        shell: "/bin/sh",
        run: async () => ({ code: 0, stdout: `__EO_LOGIN_SHELL_PATH_START__\n${bin}:/usr/bin:/bin\n__EO_LOGIN_SHELL_PATH_END__\n`, timedOut: false }),
      });
      const code = `export default async function run(ctx) { const r = await ctx.exec("eo-login-only-tool"); return { ok: true, result: "ok", detail: r.stdout.trim() }; }`;
      const module = moduleWith(code, { needs: { bin: ["eo-login-only-tool"], env: [], network: false, item: false, comment: false, attach: false, create: false } });

      expect(await run(module)).toMatchObject({ ok: true, detail: "from the login shell" });
    } finally {
      resetSearchPathForTests();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  // `needs.bin` is a promise EO keeps, not documentation. Without this a
  // declaration would be a comment and an import preflight would be a
  // guess (KAN-108).
  it("refuses a binary the module did not declare", async () => {
    const code = `export default async function run(ctx) { await ctx.exec("echo", ["hello"]); return { ok: true, result: "ok" }; }`;
    const outcome = await run(moduleWith(code));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("did not declare");
  });

  /**
   * `ctx.answer()` carries what the parent worked out, and nothing else
   * (EO-183).
   *
   * Two things are proved here rather than in `registry.test.ts`, which
   * proves what the value *is*: that a run given no answer says so
   * plainly, and that what a module holds is not editable. `offered` is
   * the same object on every call, so a module that could push onto it
   * would be rewriting the question for whatever reads it next.
   */
  it("answers null on a run that carries no answer", async () => {
    const code = `export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.answer()) }; }`;
    expect(await run(moduleWith(code))).toMatchObject({ ok: true, detail: "null" });
  });

  it("hands over the answer the parent computed, and will not let a module edit it", async () => {
    const code = `export default async function run(ctx) {
      let refused = false;
      try { ctx.answer().offered.push("Something else"); } catch { refused = true; }
      return { ok: true, result: "ok", detail: JSON.stringify({ refused, held: ctx.answer() }) };
    }`;
    const answer: StepAnswer = { text: "Send it back.", offered: ["Merge anyway", "Send it back"], matched: "Send it back" };

    const outcome = await run(moduleWith(code), { answer });

    expect(JSON.parse(outcome.ok === true ? outcome.detail : "null")).toEqual({ refused: true, held: answer });
  });

  // `ctx` is the entire surface, so what is on it is the contract. The
  // two reads joined it in EO-74, the two comments in EO-75 and the
  // answer in EO-183; nothing else did.
  it("hands the module ctx and nothing else", async () => {
    const code = `export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(Object.keys(ctx).sort()) }; }`;
    const outcome = await run(moduleWith(code));
    expect(outcome.ok && JSON.parse(outcome.detail)).toEqual([
      // What somebody said since this step last asked, worked out by the
      // parent and sent on the request — null here, because this run was
      // given none (EO-183).
      "answer",
      // Files onto the item the step is running on (EO-414).
      "attach",
      "comment",
      "commentOn",
      // A work item, created by the parent and answered on fd 5 (EO-433).
      "createItem",
      "cwd",
      "exec",
      "inputs",
      // EO's own two reads, and — sorted after `inputs` — the
      // deprecated names beside them (KAN-162). All four, because a
      // module approved before the rename calls the old ones and cannot
      // be edited to call the new ones without a person approving it
      // again.
      "item",
      "itemByKey",
      // The board, searched (EO-710).
      "items",
      "log",
      // The project the item belongs to, sent with the run (EO-711).
      "project",
      // A file's bytes, an item's runs and its step moves (EO-710).
      "readAttachment",
      // The run itself — its step, attempt and what sent the item here (EO-711).
      "run",
      "runs",
      "ticket",
      "ticketByKey",
      // The ceiling this run is held to, so a module can size its own
      // waiting against a real number instead of a guess (EO-162).
      "timeoutMs",
      // An item's step moves (EO-710).
      "transitions",
      // The workspace the run is in (EO-711).
      "workspace",
    ]);
  });
});

describe("output and the transcript", () => {
  it("streams ctx.log and command output to the caller", async () => {
    const lines: string[] = [];
    const code = `export default async function run(ctx) { ctx.log("working"); await ctx.exec("echo", ["from the command"]); return { ok: true, result: "ok", detail: "" }; }`;
    const module = moduleWith(code, { needs: { bin: ["echo"], env: [], network: false, item: false, comment: false, attach: false, create: false } });
    await run(module, { onOutput: (text) => lines.push(text) });

    const transcript = lines.join("");
    expect(transcript).toContain("working");
    // Every shell-out is logged, so `needs.bin` is kept visibly.
    expect(transcript).toContain("$ echo from the command");
    expect(transcript).toContain("from the command");
  });

  // `run_events` is append-only (invariant #3), so a secret that reaches
  // the transcript has reached it permanently. This is the only moment
  // at which it can be stopped.
  it("strips a declared secret's value from everything it prints", async () => {
    const lines: string[] = [];
    const code = `export default async function run(ctx) { ctx.log("token is " + process.env.TOKEN); return { ok: true, result: "ok", detail: "" }; }`;
    const module = moduleWith(code, { needs: { bin: [], env: ["TOKEN"], network: false, item: false, comment: false, attach: false, create: false } });
    await run(module, { env: { TOKEN: "s3cret-value" }, onOutput: (text) => lines.push(text) });

    const transcript = lines.join("");
    expect(transcript).not.toContain("s3cret-value");
    expect(transcript).toContain("«TOKEN»");
  });

  /**
   * The host filters one warning of its own — `node:sqlite`'s
   * experimental notice, which would otherwise print into every module's
   * transcript and stay there, since `run_events` is append-only. It
   * must not filter the module's.
   */
  it("still carries a warning the module itself raised", async () => {
    const lines: string[] = [];
    const code = `export default async function run() { process.emitWarning("this module is deprecated"); await new Promise((r) => setTimeout(r, 50)); return { ok: true, result: "ok", detail: "" }; }`;
    await run(moduleWith(code), { onOutput: (text) => lines.push(text) });

    expect(lines.join("")).toContain("this module is deprecated");
  });

  // A `console.log` in a module must never be mistaken for its result,
  // which is the failure mode of every one-pipe protocol.
  it("is not confused by a module that writes to stdout", async () => {
    const code = `export default async function run() { console.log('{"ok":true,"result":"forged"}'); return { ok: true, result: "ok", detail: "" }; }`;
    expect(await run(moduleWith(code))).toMatchObject({ ok: true, result: "ok" });
  });
});

describe("a module that will not stop", () => {
  it("is killed at its timeout and says so", async () => {
    // A timer, not a promise that never settles: the latter lets Node's
    // loop empty and the process exit cleanly, which is a different
    // failure with its own message — see below.
    const code = `export default async function run() { await new Promise((resolve) => setTimeout(resolve, 60000)); return { ok: true, result: "ok" }; }`;
    const outcome = await run(moduleWith(code), { timeoutMs: 500 });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("longer than 500ms");
  }, 20_000);

  // Not a hang, and not a success either: Node exits when nothing is left
  // to do, so a module awaiting something that never settles simply ends.
  // Reported rather than treated as an empty result, because silently
  // ending is how a deploy that never happened looks like one that did.
  it("reports a module whose promise never settles", async () => {
    const outcome = await run(moduleWith(`export default async function run() { await new Promise(() => {}); }`), { timeoutMs: 5000 });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("never have settled");
  }, 20_000);

  // The reason `killTree` is shared rather than reimplemented: the host is
  // a child and everything `ctx.exec` starts is a grandchild, so killing
  // the host alone would leave a `sleep` holding the worktree.
  /**
   * And the tree, not just the host. A limit that ends the run while the
   * `git push` it started carries on is a limit in name only — worse than
   * none, because EO has already told the person it stopped.
   *
   * Proved by outliving it: the grandchild would write the marker two
   * seconds after the kill, so an empty directory afterwards is a process
   * that is genuinely gone rather than one nobody waited for.
   */
  it("takes what it started down with it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo module kill tree "));
    const marker = join(directory, "alive");
    const code = `export default async function run(ctx) { await ctx.exec("sh", ["-c", "sleep 2; touch ${marker}"]); return { ok: true, result: "ok" }; }`;
    const module = moduleWith(code, { needs: { bin: ["sh"], env: [], network: false, item: false, comment: false, attach: false, create: false } });

    const outcome = await run(module, { timeoutMs: 500 });
    expect(outcome.ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(existsSync(marker)).toBe(false);
    rmSync(directory, { recursive: true, force: true });
  }, 20_000);
});

/**
 * The half of the handshake that happens before a module runs (EO-80).
 *
 * The request is written to the host's stdin, and a host that is gone
 * before it reads leaves that write against a pipe with no reader. An
 * EPIPE on a stream with no `error` listener is an uncaught exception,
 * so a host that could not start took the main process with it — the
 * whole app, over one module. Electron's binary exits exactly that way
 * on a machine missing the shared libraries it links against, which is
 * how this was found.
 */
describe("a host that dies before it is handed the module", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo module host gone "));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * The module's code is padded past a pipe buffer deliberately.
   *
   * A short request fits in the kernel's buffer and counts as written
   * whether or not anybody ever reads it, so a host that exits first
   * would fail here only sometimes. One larger than the buffer cannot
   * complete until the host reads, and this host never does.
   */
  it("fails the run, rather than taking the process down with it", async () => {
    const host = join(directory, "exits.mjs");
    writeFileSync(host, "process.exit(1);\n");
    const padded = `// ${"x".repeat(1_000_000)}\nexport default async function run() { return { ok: true, result: "ok" }; }`;

    const outcome = await run(moduleWith(padded), { launcher: { execPath: process.execPath, hostPath: host, hostEnv: {} } });

    expect(outcome.ok).toBe(false);
    // Named as the handoff it was: "a promise it awaited" would send
    // somebody reading a module that never started.
    expect(outcome.ok === false && outcome.reason).toContain("could not hand this module to its host");
    expect(outcome.ok === false && outcome.reason).not.toContain("never have settled");
  }, 20_000);
});

describe("redactSecrets", () => {
  it("replaces the longest value first, so one inside another is not left half rewritten", () => {
    expect(redactSecrets("abcd and abc", { SHORT: "abc", LONG: "abcd" })).toBe("«LONG» and «SHORT»");
  });

  it("ignores an empty value, which would otherwise match everywhere", () => {
    expect(redactSecrets("untouched", { EMPTY: "" })).toBe("untouched");
  });
});

describe("resolveInputs", () => {
  it("applies the manifest's defaults", () => {
    const module = moduleWith("", { inputs: { environment: { type: "string", default: "staging" } } });
    expect(resolveInputs(module)).toEqual({ environment: "staging" });
  });

  it("lets the step override a default", () => {
    const module = moduleWith("", { inputs: { environment: { type: "string", default: "staging" } } });
    expect(resolveInputs(module, { environment: "production" })).toEqual({ environment: "production" });
  });

  // A typo in a step's configuration should not look like it worked.
  it("drops a value the manifest does not declare", () => {
    const module = moduleWith("", { inputs: { environment: { type: "string", default: "staging" } } });
    expect(resolveInputs(module, { enviroment: "production" })).toEqual({ environment: "staging" });
  });
});

/**
 * A value that is not the type the manifest declared (EO-78).
 *
 * Checked here rather than only where a step is published, because this
 * is the side that writes `ctx.inputs` — invariant #5. A manifest edited
 * after the step was saved, or a row written by something else, must not
 * be able to hand a module a string where it declared a number and let
 * it do arithmetic on it in a subprocess nobody is watching.
 */
describe("a configured value of the wrong type", () => {
  const wants = { inputs: { wait_seconds: { type: "number" as const, default: 900 } } };
  const echo = `export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.inputs) }; }`;

  it("is refused before the module is started, naming the input", async () => {
    const outcome = await run(moduleWith(echo, wants), { inputs: { wait_seconds: "ninety" } });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain("wait_seconds");
    expect(outcome.ok === false && outcome.reason).toContain("number");
    // Nothing ran, so nothing echoed: a module that had been handed the
    // value would have returned it as its detail.
    expect(outcome).not.toHaveProperty("detail");
  });

  it("names each input that is wrong", async () => {
    const outcome = await run(moduleWith(echo, { inputs: { ...wants.inputs, environment: { type: "string" } } }), {
      inputs: { wait_seconds: "ninety", environment: 3 },
    });

    expect(outcome.ok === false && outcome.reason).toContain("wait_seconds");
    expect(outcome.ok === false && outcome.reason).toContain("environment");
  });

  // The manifest decides what exists. A value left behind by an input a
  // manifest dropped is inert — `resolveInputs` never passes it — so it
  // must not stop the step.
  it("does not refuse a value for an input the manifest does not declare", async () => {
    const outcome = await run(moduleWith(echo, wants), { inputs: { retired: "left behind" } });

    expect(outcome).toMatchObject({ ok: true, detail: JSON.stringify({ wait_seconds: 900 }) });
  });
});

/**
 * Reading an item from inside a module (EO-74).
 *
 * Against a real database file, through a real host process, because the
 * whole of this story is a subprocess opening EO's database for itself:
 * a stub would assert the stub, and a helper called from the test would
 * assert everything except the part that is new.
 *
 * The manifests here declare `item: false`, deliberately. The
 * declaration is legibility rather than a gate — the host is not a
 * sandbox and `node:fs` already reaches `eo.db` — so a module that never
 * declared it still reads, and these tests are what says so.
 */
describe("what a module can read about an item", () => {
  let directory: string;
  let dbPath: string;
  let handle: DbHandle;
  let feature: Item;
  let running: Item;
  let elsewhere: Item;
  let note: Comment;
  let reply: Comment;
  let pinned: Comment;

  const dbLauncher: ModuleHostLauncher = { ...launcher, get items() { return moduleItemReader(handle.db); } };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo module host "));
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);

    feature = createTestItem(handle.db, { type: "feature", title: "Give a module a voice", stepId: "todo" });
    // Every field the shape carries is set to something distinguishable,
    // so a mapping that reached for the neighbouring column — `jira_id`
    // for `jira_key`, say — fails here instead of matching null on both
    // sides.
    running = updateItem(
      handle.db,
      createTestItem(handle.db, {
        type: "story",
        title: "Let a module read a ticket",
        body: "Two reads on ctx.",
        parentId: feature.id,
        git: { branch: "eo/EO-74" },
        stepId: "todo",
      }).id,
      { git: { pullRequest: "https://forge.example/pull/74" }, jiraKey: "KAN-74", jiraId: "10074" },
    );
    elsewhere = createTestItem(handle.db, { type: "story", title: "Somebody else's work", stepId: "todo" });

    // A thread rather than a single line: the escalation loop reads
    // replies, and a reply is only a reply by pointing at what it
    // answers.
    note = postComment(handle.db, { itemId: running.id, author: { type: "engine" }, body: "Merge anyway, or send it back?", kind: "escalation" });
    reply = postComment(handle.db, { itemId: running.id, author: { type: "human" }, parentId: note.id, body: "Send it back." });
    pinned = postComment(handle.db, { itemId: running.id, author: { type: "engine" }, body: "Releases go out on Thursdays.", kind: "decision", pinned: true });
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function runAgainstDb(code: string, item: Item = running, useDb = true) {
    return runModule(useDb ? dbLauncher : launcher, { module: moduleWith(code), item, cwd: process.cwd(), env: {} });
  }

  /** What a module returned in `detail`, which is where these tests put their answer. */
  function answered(outcome: ModuleOutcome): Record<string, unknown> {
    if (!outcome.ok) throw new Error(`the module failed: ${outcome.reason}`);
    return JSON.parse(outcome.detail) as Record<string, unknown>;
  }

  /**
   * Field by field, and the whole object at once.
   *
   * `toEqual` rather than `toMatchObject` on purpose: this is the shape
   * EO promises a module, so a field renamed by a migration, dropped, or
   * quietly added has to fail here rather than reach an installed module
   * as a surprise.
   */
  it("gives a module the running item's fields and its comments", async () => {
    const outcome = await runAgainstDb(`export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.item()) }; }`);

    const shape = {
      key: running.key,
      type: "story",
      title: "Let a module read a ticket",
      body: "Two reads on ctx.",
      parentKey: feature.key,
      branch: "eo/EO-74",
      prUrl: "https://forge.example/pull/74",
      jiraKey: "KAN-74",
      createdAt: running.createdAt,
      updatedAt: running.updatedAt,
      comments: [
        { id: note.id, parentId: null, author: { type: "engine", name: null }, kind: "escalation", body: "Merge anyway, or send it back?", pinned: false, createdAt: note.createdAt },
        { id: reply.id, parentId: note.id, author: { type: "human", name: null }, kind: "note", body: "Send it back.", pinned: false, createdAt: reply.createdAt },
        { id: pinned.id, parentId: null, author: { type: "engine", name: null }, kind: "decision", body: "Releases go out on Thursdays.", pinned: true, createdAt: pinned.createdAt },
      ],
      // What EO-709 added. The developer pack's story type declares
      // its fields; this item set none of them.
      id: running.id,
      spec: {},
      fields: expect.arrayContaining([{ name: "acceptance_criteria", kind: "string list", required: true }]),
      priority: running.priority,
      heldAt: null,
      archivedAt: null,
      trial: false,
      createdBy: expect.anything(),
      pipeline: { id: "default", name: expect.any(String) },
      step: { id: "todo", name: expect.any(String), kind: expect.any(String), ownerRole: expect.anything() },
      pipelineVersion: running.pipelineVersionId === null ? null : { id: running.pipelineVersionId, number: expect.any(Number) },
      git: { branch: "eo/EO-74", baseBranch: null, namedBranch: false, attachedAt: null, pullRequest: "https://forge.example/pull/74", reference: null, targetBranch: null },
      extensions: { git: expect.objectContaining({ branch: "eo/EO-74" }), jira: expect.objectContaining({ key: "KAN-74" }) },
      parent: { key: feature.key, title: "Give a module a voice", type: "feature", stepName: expect.any(String), finished: false },
      children: [],
      dependsOn: [],
      dependedOnBy: [],
      attachments: [],
    };
    // `ticket` beside `item`, and the same object under both keys
    // (KAN-162): a module approved before the rename reads `.ticket` off
    // the answer and its body cannot be edited without re-approval, so
    // making the shape depend on which method was called would be the
    // break the aliases exist to avoid.
    expect(answered(outcome)).toEqual({ found: true, item: shape, ticket: shape });
  });

  /** An agent's comment is signed with the agent's name, not its id. */
  it("names the agent that wrote a comment", async () => {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer");
    if (!implementer) throw new Error("the seed should have shipped an implementer");
    postComment(handle.db, { itemId: elsewhere.id, author: { type: "agent", agentId: implementer.id }, body: "Done." });

    const outcome = await runAgainstDb(
      `export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.ticketByKey(${JSON.stringify(elsewhere.key)})) }; }`,
    );

    const item = (answered(outcome)["ticket"] as { comments: { author: { type: string; name: string } }[] }).comments;
    expect(item[0]?.author).toEqual({ type: "agent", name: implementer.name });
  });

  it("reads another item by key", async () => {
    const outcome = await runAgainstDb(
      `export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.ticketByKey(${JSON.stringify(elsewhere.key)})) }; }`,
    );

    expect(answered(outcome)).toMatchObject({ found: true, ticket: { key: elsewhere.key, title: "Somebody else's work", parentKey: null, comments: [] } });
  });

  /**
   * The item's fields, and its type's definitions of them (EO-709): a
   * module merging only when `automerge` is set has to tell `true` from
   * "never set", which the spec alone cannot say.
   */
  it("gives a module the item's fields as stored and its type's field definitions", async () => {
    createItemType(handle.db, {
      projectId: running.projectId,
      packSlug: "test",
      slug: "change",
      label: "Change",
      plural: "Changes",
      container: false,
      specShape: { type: "object", properties: { automerge: { type: "boolean" }, summary: { type: "string" } }, required: ["summary"] },
    });
    const change = createTestItem(handle.db, {
      type: { packSlug: "test", slug: "change" },
      title: "Merge me",
      stepId: "todo",
      ...(running.projectId === null ? {} : { projectId: running.projectId }),
      spec: { automerge: true, summary: "A small change." },
    });

    const outcome = await runAgainstDb(
      `export default async function run(ctx) {
        const item = ctx.item().item;
        return { ok: true, result: "ok", detail: JSON.stringify({ automerge: item.spec.automerge === true, fields: item.fields }) };
      }`,
      change,
    );

    expect(answered(outcome)).toEqual({
      automerge: true,
      fields: [
        { name: "automerge", kind: "boolean", required: false },
        { name: "summary", kind: "string", required: true },
      ],
    });
  });

  /**
   * A field a project added to a pack's type (EO-735): listed in
   * `fields` whether or not it is set, and in `spec` only once it is, so
   * a module gating on it tells never-set from `false`.
   */
  it("tells an added field never set from one set to false", async () => {
    const packType = getItemType(handle.db, running.typeId)!;
    expect(isPackShipped(packType)).toBe(true);
    const packFields = specFields(packType.specShape).map(({ name, kind, required }) => ({ name, kind, required }));
    const saved = updateItemTypeCommand(handle.db, { id: packType.id, fields: [...packFields, { name: "automerge", kind: "boolean", required: false }] });
    expect(saved.problem).toBeNull();
    const file = (title: string, spec: Record<string, unknown>) =>
      createTestItem(handle.db, {
        type: running.type,
        title,
        stepId: "todo",
        ...(running.projectId === null ? {} : { projectId: running.projectId }),
        spec: { acceptance_criteria: ["It works"], ...spec },
      });
    const unset = file("Never said", {});
    const off = file("Said no", { automerge: false });
    const on = file("Said yes", { automerge: true });

    const outcome = await runAgainstDb(
      `export default async function run(ctx) {
        const read = (key) => {
          const item = ctx.itemByKey(key).item;
          return { set: "automerge" in item.spec, value: item.spec.automerge, field: item.fields.find((field) => field.name === "automerge") };
        };
        return { ok: true, result: "ok", detail: JSON.stringify({ unset: read(${JSON.stringify(unset.key)}), off: read(${JSON.stringify(off.key)}), on: read(${JSON.stringify(on.key)}) }) };
      }`,
    );

    const field = { name: "automerge", kind: "boolean", required: false };
    expect(answered(outcome)).toEqual({
      unset: { set: false, field },
      off: { set: true, value: false, field },
      on: { set: true, value: true, field },
    });
  });

  it("answers another item by key in the same shape, with where it sits and what it is related to", async () => {
    const blocker = createTestItem(handle.db, { type: "story", title: "Lay the groundwork", stepId: "todo", parentId: feature.id });
    addDependency(handle.db, running.id, blocker.id);
    addDependency(handle.db, elsewhere.id, running.id);

    const outcome = await runAgainstDb(
      `export default async function run(ctx) {
        const story = ctx.itemByKey(${JSON.stringify(running.key)}).item;
        const feature = ctx.itemByKey(${JSON.stringify(feature.key)}).item;
        return { ok: true, result: "ok", detail: JSON.stringify({ own: Object.keys(ctx.item().item).sort(), other: Object.keys(story).sort(), story, children: feature.children }) };
      }`,
      elsewhere,
    );

    const read = answered(outcome) as { own: string[]; other: string[]; story: Record<string, unknown>; children: unknown[] };
    expect(read.other).toEqual(read.own);
    const relation = (item: Item, title: string, type = "story") => ({ key: item.key, title, type, stepName: expect.any(String), finished: false });
    expect(read.story).toMatchObject({
      key: running.key,
      pipeline: { id: "default", name: expect.any(String) },
      step: { id: "todo", name: expect.any(String) },
      parent: relation(feature, "Give a module a voice", "feature"),
      children: [],
      dependsOn: [relation(blocker, "Lay the groundwork")],
      dependedOnBy: [relation(elsewhere, "Somebody else's work")],
    });
    expect(read.children).toEqual(expect.arrayContaining([relation(running, "Let a module read a ticket"), relation(blocker, "Lay the groundwork")]));
  });

  /**
   * Secret values stay limited to what a module declares (the decision
   * on EO-708): the answer is built from the item, and nothing that
   * builds it reads the secrets store or an environment.
   */
  it("puts no secret's and no environment variable's value in the answer", async () => {
    process.env["EO_709_PROBE"] = "an-environment-value-709";
    try {
      const outcome = await runModule(dbLauncher, {
        module: moduleWith(`export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify([ctx.item(), ctx.itemByKey(${JSON.stringify(feature.key)})]) }; }`),
        item: running,
        cwd: process.cwd(),
        env: { API_TOKEN: "a-secret-value-709", REGION: "a-variable-value-709" },
        variables: ["REGION"],
      });

      expect(outcome.ok).toBe(true);
      const detail = outcome.ok ? outcome.detail : "";
      expect(detail).toContain(running.key);
      for (const value of ["a-secret-value-709", "a-variable-value-709", "an-environment-value-709", "«API_TOKEN»", "«REGION»"]) expect(detail).not.toContain(value);
    } finally {
      delete process.env["EO_709_PROBE"];
    }
  });

  /**
   * The module below runs to completion and returns `ok`, which is half
   * the assertion: a throw would have come back as a failed run with a
   * stack trace, and an empty object would have read like an item that
   * exists and has no title.
   */
  it("answers a key nothing matches with a sentence rather than a throw", async () => {
    const outcome = await runAgainstDb(`export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.ticketByKey("NOPE-404")) }; }`);

    expect(answered(outcome)).toEqual({ found: false, reason: 'No ticket has the key "NOPE-404".' });
  });

  it("answers an empty key the same way, rather than reading whatever sorts first", async () => {
    const outcome = await runAgainstDb(`export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.ticketByKey("  ")) }; }`);

    expect(answered(outcome)).toMatchObject({ found: false });
    expect(String(answered(outcome)["reason"])).toContain("ticket key");
  });

  /**
   * The names a module approved before KAN-162 still calls.
   *
   * A module's body is approved by its hash, so EO cannot edit
   * `ctx.ticket()` into `ctx.item()` on its behalf — the person who read
   * that code would have to read it again. So the old names go on
   * working, answer exactly what the new ones answer, and say once in
   * the transcript that they are on a clock.
   */
  it("answers the deprecated names with what the new ones answer", async () => {
    const read = (method: string) =>
      runAgainstDb(`export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.${method}) }; }`);

    const [byItem, byTicket] = await Promise.all([read("item()"), read("ticket()")]);
    const [byItemKey, byTicketKey] = await Promise.all([read(`itemByKey(${JSON.stringify(elsewhere.key)})`), read(`ticketByKey(${JSON.stringify(elsewhere.key)})`)]);

    expect(answered(byTicket)).toEqual(answered(byItem));
    expect(answered(byTicketKey)).toEqual(answered(byItemKey));
  });

  it("puts one deprecation line in the transcript, however many times the old names are called", async () => {
    const lines: string[] = [];
    // Four calls, two of each deprecated name: the warning is per run
    // rather than per call, because a module in a loop would otherwise
    // bury its own output in the warning about it — and `run_events` is
    // append-only (invariant #3), so there is no later pass that could
    // thin it out.
    const outcome = await runModule(dbLauncher, {
      module: moduleWith(`export default async function run(ctx) {
        ctx.ticket(); ctx.ticket(); ctx.ticketByKey(${JSON.stringify(elsewhere.key)}); ctx.ticketByKey(${JSON.stringify(elsewhere.key)});
        return { ok: true, result: "ok", detail: "" };
      }`),
      item: running,
      cwd: process.cwd(),
      env: {},
      onOutput: (text) => lines.push(text),
    });

    expect(outcome.ok).toBe(true);
    const transcript = lines.join("");
    expect(transcript.match(/ctx\.ticket\(\) or ctx\.ticketByKey\(\)/g)?.length).toBe(1);
    // It names what to use instead and when the old names stop working,
    // because "deprecated" on its own gives nobody a date to plan
    // against. The version is core's — the host duplicates it, since it
    // ships unbundled, and this is what holds the two together.
    expect(transcript).toContain("ctx.item()");
    expect(transcript).toContain("ctx.itemByKey()");
    expect(transcript).toContain(`retired after v${ALIAS_RETIREMENT_VERSION}`);
  });

  it("says nothing about deprecation when a module only uses the current names", async () => {
    const lines: string[] = [];
    await runModule(dbLauncher, {
      module: moduleWith(`export default async function run(ctx) { ctx.item(); return { ok: true, result: "ok", detail: "" }; }`),
      item: running,
      cwd: process.cwd(),
      env: {},
      onOutput: (text) => lines.push(text),
    });

    expect(lines.join("")).not.toContain("deprecated");
  });

  // A build that never told the host where the database is (the v1 gate
  // drives the engine that way). Still a sentence a module can hand back,
  // rather than a crash inside a read.
  it("says so readably when this build has no database path", async () => {
    const outcome = await runAgainstDb(`export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(ctx.ticket()) }; }`, running, false);

    expect(answered(outcome)).toMatchObject({ found: false });
    expect(String(answered(outcome)["reason"])).toContain("database");
  });

  /**
   * The answer is built in the main process (EO-709), not by SQL in the
   * host: a reader that answers with something no database holds is
   * what the module is handed, and the host's source holds no query.
   */
  it("answers from the main process's reader rather than from SQL of its own", async () => {
    const asked: string[] = [];
    const stub: ModuleHostLauncher = {
      ...launcher,
      items: {
        ...moduleItemReader(handle.db),
        read: (key) => {
          asked.push(key);
          return Promise.resolve(key === "ELSE-1" ? { ...moduleItemView(handle.db, running, "release/2.4"), key: "ELSE-1", title: "Only the reader knows this" } : null);
        },
        exists: (key) => key === "ELSE-1",
      },
    };
    const outcome = await runModule(stub, {
      module: moduleWith(`export default async function run(ctx) {
        const found = ctx.itemByKey("ELSE-1");
        return { ok: true, result: "ok", detail: JSON.stringify({ title: found.item.title, target: found.item.git.targetBranch, missing: ctx.itemByKey("NOPE-1") }) };
      }`),
      item: running,
      cwd: process.cwd(),
      env: {},
    });

    expect(answered(outcome)).toEqual({ title: "Only the reader knows this", target: "release/2.4", missing: { found: false, reason: 'No ticket has the key "NOPE-1".' } });
    expect(asked).toEqual(["ELSE-1", "NOPE-1"]);
    const source = readFileSync(join(here, "moduleHost.mjs"), "utf8");
    expect(source).not.toMatch(/\bSELECT\b/);
    expect(source).not.toMatch(/from "node:sqlite"/);
  });
});

/**
 * Saying something in the thread (EO-75).
 *
 * Through the whole path, deliberately: a real host process, a real
 * `postComment` against a real database, and the assertions made on the
 * rows that came out. The point of the story is that a module's comment
 * goes where every other comment goes — mentions, Jira mirror, the push
 * to open windows — so a test that stopped at "the host emitted an
 * event" would assert the one half that was never in doubt.
 *
 * `onComment` here is wired to the same `postModuleComment` the step
 * runner uses, which is what makes these tests about the
 * shipped path rather than about a fixture.
 */
describe("what a module can say on an item", () => {
  let directory: string;
  let dbPath: string;
  let handle: DbHandle;
  let running: Item;
  let elsewhere: Item;

  const dbLauncher: ModuleHostLauncher = { ...launcher, get items() { return moduleItemReader(handle.db); } };

  // The catalog name, which is what the Settings list shows and what the
  // step runner already names in its own failures — not `manifest.name`,
  // which nothing else in EO signs anything with.
  const probe: CustomModule = { ...moduleWith("", { needs: { bin: [], env: [], network: false, item: false, comment: true, attach: false, create: false } }), name: "Release notes" };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo module comments "));
    dbPath = join(directory, "eo.db");
    handle = openDb(dbPath);
    runMigrations(handle.db, migrationsFolder);

    // Mirrored, because "the Jira mirror is queued" is one of the things
    // a comment going through `postComment` is supposed to do — and a
    // item with no repository and no Jira key would have proved
    // nothing either way.
    const repository = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" });
    running = updateItem(handle.db, createTestItem(handle.db, { type: "story", title: "Deploy it", stepId: "todo", workspaceId: repository.id }).id, { jiraKey: "KAN-75" });
    elsewhere = updateItem(handle.db, createTestItem(handle.db, { type: "story", title: "Somebody else's work", stepId: "todo", workspaceId: repository.id }).id, { jiraKey: "KAN-99" });
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function runSaying(code: string, extra: { module?: CustomModule; item?: Item; env?: Record<string, string>; onOutput?: (text: string) => void } = {}) {
    const module = extra.module ?? probe;
    const on = extra.item ?? running;
    return runModule(dbLauncher, {
      module: { ...module, code },
      item: on,
      cwd: process.cwd(),
      env: extra.env ?? {},
      ...(extra.onOutput ? { onOutput: extra.onOutput } : {}),
      onComment: (comment) => postModuleComment(handle.db, { module, item: on, runId: null }, comment),
    });
  }

  /** What the module answered, which these tests put in `detail`. */
  function answered(outcome: ModuleOutcome): Record<string, unknown> {
    if (!outcome.ok) throw new Error(`the module failed: ${outcome.reason}`);
    return JSON.parse(outcome.detail) as Record<string, unknown>;
  }

  it("posts on the item the step is running on", async () => {
    const outcome = await runSaying(`export default async function run(ctx) {
      const said = ctx.comment("Deployed to staging.");
      return { ok: true, result: "ok", detail: JSON.stringify(said) };
    }`);

    expect(answered(outcome)).toEqual({ posted: true });
    const thread = listCommentsForItem(handle.db, running.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]?.body).toContain("Deployed to staging.");
    expect(thread[0]?.authorType).toBe("module");
  });

  it("posts on another item by key", async () => {
    const outcome = await runSaying(`export default async function run(ctx) {
      const said = ctx.commentOn(${JSON.stringify(elsewhere.key)}, "Your branch is in the release.");
      return { ok: true, result: "ok", detail: JSON.stringify(said) };
    }`);

    expect(answered(outcome)).toEqual({ posted: true });
    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(0);
    expect(listCommentsForItem(handle.db, elsewhere.id)[0]?.body).toContain("Your branch is in the release.");
  });

  /**
   * The module runs to completion and returns `ok`, which is half the
   * assertion: a throw would have ended the run in a stack trace.
   */
  it("reports a key nothing matches rather than dropping the comment", async () => {
    const lines: string[] = [];
    const outcome = await runSaying(
      `export default async function run(ctx) {
        const said = ctx.commentOn("NOPE-404", "Anybody there?");
        return { ok: true, result: "ok", detail: JSON.stringify(said) };
      }`,
      { onOutput: (text) => lines.push(text) },
    );

    expect(answered(outcome)).toEqual({ posted: false, reason: 'No ticket has the key "NOPE-404".' });
    // Handed back *and* said out loud: a module is free to ignore the
    // return value, and a person reading the run should still see that
    // something was meant to be said (invariant #8).
    expect(lines.join("")).toContain("NOPE-404");
    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(0);
    expect(listCommentsForItem(handle.db, elsewhere.id)).toHaveLength(0);
  });

  /**
   * The whole reason writes do not happen in the host.
   *
   * A row inserted through the host's own handle would satisfy "the
   * comment exists" and none of these three — which is exactly the
   * comment that never reaches Jira and that no open window hears about.
   */
  it("goes through postComment, so the mirror is queued and open windows are told", async () => {
    const heard: string[] = [];
    const stop = onCommentPosted(handle.db, (comment) => heard.push(comment.body));

    await runSaying(`export default async function run(ctx) { ctx.comment("Deployed."); return { ok: true, result: "ok" }; }`);
    stop();

    expect(heard.join("")).toContain("Deployed.");
    const queued = pendingPushesForItem(handle.db, running.id, "jira").filter((entry) => entry.kind === "comment");
    expect(queued).toHaveLength(1);
    expect(String(queued[0]?.payload["body"])).toContain("Deployed.");
    expect(queued[0]?.payload["authorType"]).toBe("module");
  });

  /**
   * A module asks by refusing with options, which ends the run
   * (invariant #9). A comment that summoned somebody would be a second
   * way to stop and ask, and `!` derives from an open human mention
   * (invariant #6) — so this is what keeps one escalation path.
   */
  it("mentions nobody, whatever the body says", async () => {
    await runSaying(`export default async function run(ctx) { ctx.comment("@user @implementer this needs a look."); return { ok: true, result: "ok" }; }`);

    const comment = listCommentsForItem(handle.db, running.id)[0];
    if (!comment) throw new Error("the comment should have been posted");
    // The text is untouched — the record is not EO's to rewrite — and it
    // simply summons nobody.
    expect(comment.body).toContain("@user");
    expect(listMentionsForComment(handle.db, comment.id)).toEqual([]);
    expect(needsAttention(handle.db, running.id)).toBe(false);
  });

  /**
   * Worse than the transcript, and for a reason the transcript does not
   * have: a comment is mirrored to Jira, so an unredacted token leaves
   * the machine. Asserted on the stored row, because that is the copy
   * the mirror is built from.
   */
  it("redacts a declared secret from the stored comment, not only from the transcript", async () => {
    const module: CustomModule = { ...probe, manifest: { ...probe.manifest, needs: { bin: [], env: ["TOKEN"], network: false, item: false, comment: true, attach: false, create: false } } };
    await runSaying(`export default async function run(ctx) { ctx.comment("deployed with " + process.env.TOKEN); return { ok: true, result: "ok" }; }`, {
      module,
      env: { TOKEN: "s3cret-value" },
    });

    const comment = listCommentsForItem(handle.db, running.id)[0];
    expect(comment?.body).not.toContain("s3cret-value");
    expect(comment?.body).toContain("«TOKEN»");
    // And the copy queued for Jira is the same copy.
    const queued = pendingPushesForItem(handle.db, running.id, "jira").find((entry) => entry.kind === "comment");
    expect(String(queued?.payload["body"])).not.toContain("s3cret-value");
  });

  it("signs the comment with the module's name", async () => {
    await runSaying(`export default async function run(ctx) { ctx.comment("Deployed."); return { ok: true, result: "ok" }; }`);

    const comment = listCommentsForItem(handle.db, running.id)[0];
    expect(comment?.body).toContain("Release notes");
    // Not EO's own note and not an agent's: `engine` is EO talking about
    // its own bookkeeping and is deliberately never mirrored, and there
    // is no agent behind this.
    expect(comment?.authorType).toBe("module");
    expect(comment?.authorId).toBeNull();
  });

  /** Nobody reading KAN-99 should have to guess why a message about the other item appeared under it. */
  it("names the item a comment on another item came from", async () => {
    await runSaying(`export default async function run(ctx) { ctx.commentOn(${JSON.stringify(elsewhere.key)}, "Your branch is in the release."); return { ok: true, result: "ok" }; }`);

    const comment = listCommentsForItem(handle.db, elsewhere.id)[0];
    expect(comment?.body).toContain(running.key);
    // The one on its own item does not say it — there is nothing to
    // explain, and a line saying "from its run on this item" would be
    // noise on every comment a module ever posts.
    await runSaying(`export default async function run(ctx) { ctx.comment("Deployed."); return { ok: true, result: "ok" }; }`);
    expect(listCommentsForItem(handle.db, running.id)[0]?.body).not.toContain("from its run");
  });

  it("carries the run it was posted from", async () => {
    const run = createRun(handle.db, { itemId: running.id, agentId: null, action: "deploy", status: "running", provider: "module" });
    await runModule(dbLauncher, {
      module: { ...probe, code: `export default async function run(ctx) { ctx.commentOn(${JSON.stringify(elsewhere.key)}, "Shipped."); return { ok: true, result: "ok" }; }` },
      item: running,
      cwd: process.cwd(),
      env: {},
      onComment: (comment) => postModuleComment(handle.db, { module: probe, item: running, runId: run.id }, comment),
    });

    // The run is named structurally rather than as a UUID in prose: the
    // sentence says which item, and this says which run on it.
    expect(listCommentsForItem(handle.db, elsewhere.id)[0]?.runId).toBe(run.id);
  });

  /**
   * The transcript is buffered and bounded for exactly this; comments
   * are a row, a Jira push and a line somebody reads.
   */
  it("stops a run posting more than its share, and says so", async () => {
    const lines: string[] = [];
    const outcome = await runSaying(
      `export default async function run(ctx) {
        const answers = [];
        for (let i = 0; i < ${MAX_COMMENTS_PER_RUN + 2}; i += 1) answers.push(ctx.comment("note " + i));
        return { ok: true, result: "ok", detail: JSON.stringify(answers) };
      }`,
      { onOutput: (text) => lines.push(text) },
    );

    const answers = answered(outcome) as unknown as { posted: boolean; reason?: string }[];
    expect(answers.filter((answer) => answer.posted)).toHaveLength(MAX_COMMENTS_PER_RUN);
    expect(answers[MAX_COMMENTS_PER_RUN]?.reason).toContain(String(MAX_COMMENTS_PER_RUN));
    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(MAX_COMMENTS_PER_RUN);
    // Refused out loud, not dropped: two refusals, two lines.
    expect(lines.join("").match(/did not post a comment/g)).toHaveLength(2);
  });

  it("refuses a comment larger than one comment should be, and says how large it was", async () => {
    const outcome = await runSaying(`export default async function run(ctx) {
      const said = ctx.comment("x".repeat(${MAX_COMMENT_CHARS + 1}));
      return { ok: true, result: "ok", detail: JSON.stringify(said) };
    }`);

    expect(answered(outcome)["posted"]).toBe(false);
    expect(String(answered(outcome)["reason"])).toContain(String(MAX_COMMENT_CHARS));
    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(0);
  });

  it("refuses an empty comment rather than posting a blank line", async () => {
    const outcome = await runSaying(`export default async function run(ctx) {
      return { ok: true, result: "ok", detail: JSON.stringify(ctx.comment("   ")) };
    }`);

    expect(answered(outcome)["posted"]).toBe(false);
    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(0);
  });

  /**
   * fd 3 is an inherited descriptor in the host's own process, so a
   * module reaches it through `node:fs` — the same hole the result
   * nonce exists for. The host's own count is what lets it answer a
   * module immediately; this is the count that decides whether a row
   * exists (invariant #5).
   */
  it("holds the cap against a module writing comment events to fd 3 itself", async () => {
    const code = `
      import { writeSync } from "node:fs";
      export default async function run(ctx) {
        for (let i = 0; i < ${MAX_COMMENTS_PER_RUN + 5}; i += 1) {
          writeSync(3, JSON.stringify({ type: "comment", key: ${JSON.stringify(running.key)}, body: "smuggled " + i }) + "\\n");
        }
        return { ok: true, result: "ok" };
      }`;
    await runSaying(code);

    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(MAX_COMMENTS_PER_RUN);
  });

  /**
   * A write that fails, without the body coming out sideways.
   *
   * This runs inside the fd 3 reader, whose own catch treats a line it
   * cannot parse as text and emits it. A throw from the post would take
   * that path and print the raw event — the module's body included, and
   * before redaction. So it is caught, reported, and nothing leaks.
   */
  it("reports a failed write as a sentence, without printing the raw comment", async () => {
    const lines: string[] = [];
    await runModule(dbLauncher, {
      module: { ...probe, code: `export default async function run(ctx) { ctx.comment("token is " + process.env.TOKEN); return { ok: true, result: "ok" }; }` },
      item: running,
      cwd: process.cwd(),
      env: { TOKEN: "s3cret-value" },
      onOutput: (text) => lines.push(text),
      onComment: () => {
        throw new Error("the store went away");
      },
    });

    expect(lines.join("")).toContain("the store went away");
    expect(lines.join("")).not.toContain("s3cret-value");
    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(0);
  });

  /**
   * A run with nowhere to post. Reported rather than accepted and
   * dropped, which is the failure mode this whole path is shaped
   * against.
   */
  it("says so when the run has nowhere to post a comment", async () => {
    const lines: string[] = [];
    await runModule(dbLauncher, {
      module: { ...probe, code: `export default async function run(ctx) { ctx.comment("Anybody there?"); return { ok: true, result: "ok" }; }` },
      item: running,
      cwd: process.cwd(),
      env: {},
      onOutput: (text) => lines.push(text),
    });

    expect(lines.join("")).toContain("nowhere to post");
    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(0);
  });

  /**
   * A write that fails, without the body coming out sideways.
   *
   * This runs inside the fd 3 reader, whose own catch treats a line it
   * cannot parse as text and emits it. A throw from the post would take
   * that path and print the raw event — the module's body included, and
   * before redaction. So it is caught, reported, and nothing leaks.
   */
  it("reports a failed write as a sentence, without printing the raw comment", async () => {
    const lines: string[] = [];
    await runModule(dbLauncher, {
      module: { ...probe, code: `export default async function run(ctx) { ctx.comment("token is " + process.env.TOKEN); return { ok: true, result: "ok" }; }` },
      item: running,
      cwd: process.cwd(),
      env: { TOKEN: "s3cret-value" },
      onOutput: (text) => lines.push(text),
      onComment: () => {
        throw new Error("the store went away");
      },
    });

    expect(lines.join("")).toContain("the store went away");
    expect(lines.join("")).not.toContain("s3cret-value");
    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(0);
  });

  // A build that never told the host where the database is (the v1 gate
  // drives the engine that way). The running item is known from the
  // request, so it can still be commented on; another key cannot be
  // checked, and says so rather than guessing.
  it("still comments on the running item with no database path, and says why it cannot check another key", async () => {
    const outcome = await runModule(launcher, {
      module: {
        ...probe,
        code: `export default async function run(ctx) {
          return { ok: true, result: "ok", detail: JSON.stringify({ own: ctx.comment("Deployed."), other: ctx.commentOn("APP-2", "Hello.") }) };
        }`,
      },
      item: running,
      cwd: process.cwd(),
      env: {},
      onComment: (comment) => postModuleComment(handle.db, { module: probe, item: running, runId: null }, comment),
    });

    expect(answered(outcome)["own"]).toEqual({ posted: true });
    expect(answered(outcome)["other"]).toMatchObject({ posted: false });
    expect(listCommentsForItem(handle.db, running.id)).toHaveLength(1);
  });
});
