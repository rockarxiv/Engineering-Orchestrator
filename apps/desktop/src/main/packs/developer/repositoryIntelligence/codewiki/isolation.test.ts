import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveCodeWiki, type ResolveOptions } from "../binary/resolve.js";
import type { RepositoryIndexBuild, RepositoryIndexTarget, RepositoryIntelligenceProvider } from "../port.js";
import { hookRedirectEnv } from "./hooks.js";
import { createCodeWikiProvider } from "./provider.js";
import { runCodeWiki } from "./run.js";
import { run } from "../../../../testing/git.js";

/**
 * What an index actually does when the root under it changes (EO-150).
 *
 * Every other test in this directory answers a question about EO: what
 * the provider does with a tool that exits non-zero, where the hooks
 * go, what reaches a comment. This one answers a question about the
 * *tool*, and it is the question the whole feature was designed around
 * — an index built against one filesystem root, asked about a
 * different one.
 *
 * That was settled by reading CodeWiki's source
 * (`codewiki-cli/src/commands/util.rs` composes absolute paths and the
 * display layer strips the prefix back off), and a paragraph in an
 * item is a fine place to record a decision and a poor place to
 * record a fact. Facts stop being true. So this runs it: real git
 * repositories, real worktrees, the real binary, and the answers
 * written down as assertions.
 *
 * Three of the four tests below assert a *capability* — that a sync
 * keeps up with a change, that two worktrees do not touch each other,
 * that a path out of an index is a path into the checkout it describes.
 * The last one asserts a *limitation*, on purpose, and says so at
 * length where it sits. Read that comment before deciding it is a bug.
 *
 * ── Why this is not in `provider.test.ts` ──────────────────────────
 *
 * That file proves EO's adapter is correct, with a stand-in binary, on
 * every machine. This one cannot run at all without 46 MB of Rust, so
 * folding it in would have added a large block to a file whose subject
 * is something else, under a second and differently-conditioned skip.
 * Separate file, separate subject, one skip.
 *
 * ── Cost ──────────────────────────────────────────────────────────
 *
 * The fixture is four small TypeScript files, which the pinned version
 * indexes in well under a second — a cold index of kubernetes (17,176
 * Go files) measured 55s, so four files is noise. Two bounds keep it
 * that way rather than trusting it: `INVOCATION_TIMEOUT_MS` caps any
 * single CodeWiki call at a small fraction of the runner's default, and
 * every test asserts the index holds exactly `Object.keys(FIXTURE)`
 * files — so a fixture that grew into something slow fails here rather
 * than quietly costing everybody thirty seconds a run.
 *
 * There is deliberately no assertion on elapsed milliseconds. This
 * suite runs on a hosted Windows runner where a 400ms operation can
 * take ten times that, and a wall-clock assertion would be a test about
 * the machine rather than about the fixture — which is the failure
 * three tests on this branch were already rewritten to stop having.
 */

/** Somewhere resolution reliably finds nothing, so the `cache` branch never fires by accident. */
const EMPTY_ROOT = join(tmpdir(), "eo-codewiki-no-such-root");

/**
 * The real binary, resolved the way a dispatch resolves it.
 *
 * `EO_CODEWIKI_BIN` for a path somebody has lying around,
 * `EO_CODEWIKI_ROOT` for a real managed install — the same two knobs
 * `version.test.ts` and `provider.test.ts` take, because a person who
 * has pointed one of these at a binary should not have to discover that
 * the others spell it differently.
 */
const REAL_BINARY: ResolveOptions = {
  configuredPath: process.env["EO_CODEWIKI_BIN"] ?? null,
  root: process.env["EO_CODEWIKI_ROOT"] ?? EMPTY_ROOT,
};

const found = resolveCodeWiki(REAL_BINARY);
const present = found.path !== null && existsSync(found.path);

/**
 * Why these tests did not run, in words, or null when they did.
 *
 * Skipped rather than failed: `pnpm test` must not require a 46 MB
 * download and CI must not reach the network, so "no binary" is the
 * ordinary case and a red suite would say nothing true. But a silent
 * skip is how a test stops existing without anybody deciding it should,
 * so the reason travels with it — `ctx.skip(note)` puts this sentence
 * beside the skipped test in the reporter, including the command that
 * would have run it.
 */
const SKIP_REASON: string | null = present
  ? null
  : `${found.reason ?? `nothing executable at ${found.path ?? "the configured path"}`} Run these against one with EO_CODEWIKI_BIN=/path/to/codewiki, or against a managed install with EO_CODEWIKI_ROOT=<userData>/repositoryIntelligence.`;

/**
 * How long any one CodeWiki call gets.
 *
 * Two orders of magnitude below `run.ts`'s own ten-minute default,
 * which is sized for indexing a real repository. Nothing here indexes
 * anything but four files, so a call that takes thirty seconds has not
 * been slow, it has hung — and the whole point of a bound is that the
 * suite comes back either way.
 */
const INVOCATION_TIMEOUT_MS = 30_000;

/** The bound on a whole test, which makes several calls and a few git ones. */
const TEST_TIMEOUT_MS = 120_000;

/**
 * The file the provider's `indexPath` directory holds.
 *
 * Written out here because a digest needs a file and the port only ever
 * names the directory — deliberately, since the layout is the
 * implementation's business. Knowing the filename is this directory's
 * privilege and nowhere else's, which is what
 * `architecturalInvariants.test.ts` keeps true.
 */
const INDEX_DATABASE = "codewiki.db";

/**
 * The fixture: four files, three relationships, one of them about to be
 * removed.
 *
 * Small enough to index instantly and shaped so that every assertion
 * below has something to hold on to. `alpha` calls `beta`, which is the
 * relationship a later change destroys. `gamma` is what `alpha` calls
 * instead. `untouched` is referenced by nothing and referenced *to*
 * nothing, which is what makes it the control: if a sync of one file
 * quietly re-extracted the world, this is the symbol that would move.
 */
const FIXTURE: Record<string, string> = {
  "src/alpha.ts": 'import { beta } from "./beta.js";\n\nexport function alpha(): number {\n  return beta();\n}\n',
  "src/beta.ts": "export function beta(): number {\n  return 1;\n}\n",
  "src/gamma.ts": "export function gamma(): number {\n  return 2;\n}\n",
  "src/untouched.ts": "export function untouched(): number {\n  return 7;\n}\n",
};

/**
 * `alpha` after the change: calling `gamma` where it called `beta`, and
 * with a `delta` beside it that did not exist before.
 *
 * Three separate things for the sync to get right, in one file. The
 * call it gained, the call it lost, and a symbol that is new.
 */
const CHANGED_ALPHA =
  'import { gamma } from "./gamma.js";\n\n// A comment, so the declaration below does not stay on the line it was.\nexport function alpha(): number {\n  return gamma();\n}\n\nexport function delta(): number {\n  return 4;\n}\n';

/** The same symbol, changed one way. */
const GAMMA_CALLING_BETA = 'import { beta } from "./beta.js";\n\nexport function gamma(): number {\n  return beta();\n}\n';

/** The same symbol, changed a different way, in a different worktree. */
const GAMMA_CALLING_UNTOUCHED = 'import { untouched } from "./untouched.js";\n\nexport function gamma(): number {\n  return untouched();\n}\n';

/** A file that exists in one worktree and nowhere else. */
const FIRST_ONLY = "export function firstOnly(): number {\n  return 1;\n}\n";

/**
 * Scratch space, with a space in its name.
 *
 * `gate/v1Gate.test.ts`'s recipe, and the reason is the reason this
 * codebase writes it into every fixture it can: a path with a space in
 * it is one argument to `spawn` and two to anything that built a
 * command string, so a quoting bug anywhere between here and the binary
 * shows up as a fixture that cannot be found rather than as a bug
 * somebody hits on a Mac with "Application Support" in the path.
 */
let scratch: string;

/**
 * Where redirected git hooks land, for the calls this file makes
 * directly.
 *
 * `provider.initialize` and `provider.sync` contain their own — that is
 * `hooks.ts`'s whole job and they do it whether or not a test asks. But
 * `query`, `files`, `snapshot` and `restore` are run here through the
 * bare runner, and "which subcommand installs hooks" is a fact about
 * one version rather than a promise, so they get the same redirection.
 * A test suite that installed hooks into its own fixtures would be
 * harmless; one that taught anybody it was fine to skip this would not.
 */
let decoyHooks: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo index roots "));
  decoyHooks = mkdtempSync(join(tmpdir(), "eo index hooks "));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(decoyHooks, { recursive: true, force: true });
});


/** A fixture path, from the forward-slash keys of `FIXTURE`. */
function fileIn(root: string, path: string): string {
  return join(root, ...path.split("/"));
}

/**
 * A real git repository holding the fixture, at a path with a space in
 * it.
 *
 * `gate/v1Gate.test.ts`'s recipe verbatim, `commit.gpgsign false`
 * included — without it a machine with signing configured globally
 * reaches for a key, and the fixture fails for a reason that has
 * nothing to do with what is being tested.
 */
async function makeRepository(name: string): Promise<string> {
  const root = join(scratch, name);
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [path, source] of Object.entries(FIXTURE)) writeFileSync(fileIn(root, path), source);

  await run(["init", "-b", "main"], root);
  await run(["config", "user.email", "eo@example.com"], root);
  await run(["config", "user.name", "EO Test"], root);
  await run(["config", "commit.gpgsign", "false"], root);
  await run(["config", "tag.gpgsign", "false"], root);
  await run(["add", "-A"], root);
  await run(["commit", "-m", "the fixture"], root);
  return root;
}

function providerFor(): RepositoryIntelligenceProvider {
  return createCodeWikiProvider({ binary: REAL_BINARY, timeoutMs: INVOCATION_TIMEOUT_MS });
}

/**
 * A target for a checkout.
 *
 * The two ids identify a row in `repository_indexes` and mean nothing
 * to the provider, which is told which checkout to look at and works
 * out the rest from that. Fixed strings rather than a database, because
 * a database would be a second thing this file could fail on.
 */
function target(workspacePath: string): RepositoryIndexTarget {
  return { workspaceId: "01a0-repo", itemId: "01a0-ticket", workspacePath };
}

/** A build that worked, or the reason it did not as a failure here rather than three assertions later. */
function built(result: RepositoryIndexBuild): Extract<RepositoryIndexBuild, { ok: true }> {
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/**
 * Asks the index a read-only question and gives back what it printed.
 *
 * Through `runCodeWiki` rather than a `spawn` of its own: there is one
 * file in this codebase that starts this binary, a test is not a licence
 * to be the second, and `importSites.test.ts` beside this one scans
 * test files precisely because that rule was broken by a test once
 * already.
 *
 * `--path` last, so a caller writes the subcommand and its own
 * arguments and never the root — which is also why `snapshot -o` and
 * `restore <file>` fit through here unchanged.
 */
async function ask(root: string, args: string[]): Promise<string> {
  const result = await runCodeWiki({
    args: [...args, "--path", root],
    cwd: root,
    binary: REAL_BINARY,
    timeoutMs: INVOCATION_TIMEOUT_MS,
    env: hookRedirectEnv(decoyHooks),
  });
  if (!result.ok) throw new Error(`codewiki ${args[0] ?? ""} did not answer: ${result.problem ?? "no reason given"} ${result.stderr}`);
  return result.stdout;
}

/**
 * Where a listing says a symbol is, as `<path>:<line>`, or null when it
 * does not mention it.
 *
 * A row is `KIND LANGUAGE NAME LOCATION` in columns, and the location
 * is the only field that ends in `:<digits>` — which is what tells a row
 * from the header above it without matching on the header's words. The
 * name is compared exactly, which is also what separates the `alpha`
 * row from the `alpha.ts` one that a query for `alpha` returns beside
 * it.
 *
 * Returned as an opaque string and compared to itself. Nothing here
 * asserts a literal line number: what a test wants to know is whether
 * an entry moved, survived or appeared, and pinning "3" would pin the
 * tool's line-numbering convention along with it.
 */
function locationOf(listing: string, name: string): string | null {
  for (const line of listing.split("\n")) {
    const row = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S.*:\d+)$/.exec(line.trimEnd());
    if (row && row[3] === name) return row[4] ?? null;
  }
  return null;
}

/**
 * The symbols a `callers`/`callees` answer names, other than the one
 * that was asked about.
 *
 * The first line is the subject and its location; every line after it is
 * a relationship, and the related symbol is the one thing in backticks.
 * `(none)` has no backticks and so comes back as the empty list, which
 * is the answer it means.
 *
 * The empty list is also what an answer about a symbol that is not in
 * the index would produce, so every assertion below that expects it
 * checks the subject line as well. An assertion that cannot tell "no
 * callers" from "no such symbol" is one that passes when the index has
 * been emptied.
 */
function relatedNames(answer: string): string[] {
  return answer
    .split("\n")
    .slice(1)
    .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""));
}

/**
 * Every file path a `files` listing named.
 *
 * The columns are `LANGUAGE SIZE NODES PATH`, and the path is
 * everything after the two numbers — which is how a path containing
 * spaces survives being parsed, and this fixture's paths all contain
 * one. The header, the rule under it and the "N file(s) total" footer
 * have no two integers in the middle and so match nothing.
 */
function filePathsIn(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => /^(\S+)\s+(\d+)\s+(\d+)\s+(\S.*)$/.exec(line.trimEnd()))
    .flatMap((row) => (row?.[4] === undefined ? [] : [row[4]]));
}

/** Is this path genuinely under this directory? By segments, so a sibling with a longer name is not. */
function inside(directory: string, path: string): boolean {
  const path_ = relative(directory, path);
  return path_ !== "" && !path_.startsWith("..") && !isAbsolute(path_);
}

/** The bytes of an index database, as something comparable. */
function digestOf(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function databaseOf(build: Extract<RepositoryIndexBuild, { ok: true }>): string {
  return join(build.indexPath, INDEX_DATABASE);
}

/**
 * A test that needs the binary, and says so when it does not have one.
 *
 * `describe.skipIf` is what this file's neighbours use and it would have
 * been fine, except that it skips silently — and the acceptance
 * criterion for this story is that the skip *states a reason*, because
 * a suite where the interesting half never runs and never says so is
 * one that stops being maintained without anybody choosing that.
 */
function itWithTheBinary(name: string, body: () => Promise<void>): void {
  it(
    name,
    async (ctx) => {
      if (SKIP_REASON !== null) ctx.skip(SKIP_REASON);
      await body();
    },
    TEST_TIMEOUT_MS,
  );
}

describe("what a sync does to an index that is already there", () => {
  itWithTheBinary("updates the symbol that changed, drops the relationship it lost, and leaves the rest where it was", async () => {
    const root = await makeRepository("a checkout that changes");
    const alphaFile = fileIn(root, "src/alpha.ts");
    const provider = providerFor();

    const build = built(await provider.initialize(target(root)));
    expect(filePathsIn(await ask(root, ["files"]))).toHaveLength(Object.keys(FIXTURE).length);

    // What is true before the change, recorded rather than assumed.
    // Every assertion after the sync is against one of these, so a
    // parse that silently found nothing fails here instead of agreeing
    // with everything later.
    const alphaBefore = locationOf(await ask(root, ["query", "alpha"]), "alpha");
    const untouchedBefore = locationOf(await ask(root, ["query", "untouched"]), "untouched");
    const betaBefore = locationOf(await ask(root, ["query", "beta"]), "beta");
    expect(alphaBefore).toContain(alphaFile);
    expect(untouchedBefore).toContain(fileIn(root, "src/untouched.ts"));
    expect(relatedNames(await ask(root, ["callees", "alpha"]))).toEqual(["beta"]);
    expect(relatedNames(await ask(root, ["callers", "beta"]))).toEqual(["alpha"]);
    expect(locationOf(await ask(root, ["query", "delta"]), "delta")).toBeNull();

    writeFileSync(alphaFile, CHANGED_ALPHA);
    const synced = built(await provider.sync(target(root)));
    expect(synced.changedFileCount).toBe(1);
    expect(synced.indexPath).toBe(build.indexPath);

    // The changed symbol moved with its file, and calls something else
    // now.
    const alphaAfter = locationOf(await ask(root, ["query", "alpha"]), "alpha");
    expect(alphaAfter).toContain(alphaFile);
    expect(alphaAfter).not.toBe(alphaBefore);
    expect(relatedNames(await ask(root, ["callees", "alpha"]))).toEqual(["gamma"]);

    // A symbol that did not exist before is in the index, in the file
    // that gained it.
    expect(locationOf(await ask(root, ["query", "delta"]), "delta")).toContain(alphaFile);

    // The relationship that no longer exists is gone. Asserted with the
    // subject line checked too: `beta` is still a symbol, still where it
    // was, and now has no callers — which is a different statement from
    // "the index has forgotten beta".
    const callersOfBeta = await ask(root, ["callers", "beta"]);
    expect(callersOfBeta).toContain(fileIn(root, "src/beta.ts"));
    expect(relatedNames(callersOfBeta)).toEqual([]);
    expect(locationOf(await ask(root, ["query", "beta"]), "beta")).toBe(betaBefore);

    // And the file nobody touched is exactly as it was.
    expect(locationOf(await ask(root, ["query", "untouched"]), "untouched")).toBe(untouchedBefore);
    expect(filePathsIn(await ask(root, ["files"]))).toHaveLength(Object.keys(FIXTURE).length);
  });
});

describe("two worktrees of one repository", () => {
  itWithTheBinary("each answer with their own version of the same symbol, and neither index is written by the other's", async () => {
    const root = await makeRepository("the shared repository");
    const first = join(scratch, "the first work tree");
    const second = join(scratch, "the second work tree");
    await run(["worktree", "add", "-b", "first", first], root);
    await run(["worktree", "add", "-b", "second", second], root);

    // The same symbol, changed differently in each. Written before
    // either is indexed, so each index is built from what its own
    // worktree says rather than from a change that arrived later.
    writeFileSync(fileIn(first, "src/gamma.ts"), GAMMA_CALLING_BETA);
    writeFileSync(fileIn(second, "src/gamma.ts"), GAMMA_CALLING_UNTOUCHED);

    const provider = providerFor();
    const firstDatabase = databaseOf(built(await provider.initialize(target(first))));
    const firstDigest = digestOf(firstDatabase);
    const secondDatabase = databaseOf(built(await provider.initialize(target(second))));
    const secondDigest = digestOf(secondDatabase);

    expect(firstDatabase).toBe(join(first, ".codewiki", INDEX_DATABASE));
    expect(secondDatabase).toBe(join(second, ".codewiki", INDEX_DATABASE));

    // Building the second worktree's index did not write a byte into
    // the first's. Read before anything queries either database, since
    // a query opens it and this is a question about bytes.
    expect(digestOf(firstDatabase)).toBe(firstDigest);

    // Nor does a sync in one reach the other.
    writeFileSync(fileIn(first, "src/first-only.ts"), FIRST_ONLY);
    expect(built(await provider.sync(target(first))).changedFileCount).toBe(1);
    expect(digestOf(secondDatabase)).toBe(secondDigest);

    // The digest is sensitive to a write, which is what makes the two
    // assertions above mean anything. Without this they would pass just
    // as happily against a file nothing ever writes to.
    expect(digestOf(firstDatabase)).not.toBe(firstDigest);

    // Each answers with its own version of `gamma` — same symbol, same
    // file, different relationship.
    expect(relatedNames(await ask(first, ["callees", "gamma"]))).toEqual(["beta"]);
    expect(relatedNames(await ask(second, ["callees", "gamma"]))).toEqual(["untouched"]);

    // And with its own files: what one worktree gained, the other has
    // never heard of.
    expect(locationOf(await ask(first, ["query", "firstOnly"]), "firstOnly")).toContain(fileIn(first, "src/first-only.ts"));
    expect(locationOf(await ask(second, ["query", "firstOnly"]), "firstOnly")).toBeNull();
    expect(filePathsIn(await ask(second, ["files"]))).toHaveLength(Object.keys(FIXTURE).length);
  });

  itWithTheBinary("answer with paths that are files inside the worktree that was indexed", async () => {
    const root = await makeRepository("a repository with a worktree");
    const tree = join(scratch, "the work tree that was indexed");
    await run(["worktree", "add", "-b", "indexed", tree], root);

    built(await providerFor().initialize(target(tree)));

    const paths = filePathsIn(await ask(tree, ["files"]));
    // Non-vacuous: a parse that found nothing would satisfy every
    // assertion in the loop below without executing it once.
    expect(paths).toHaveLength(Object.keys(FIXTURE).length);
    for (const path of paths) {
      expect(isAbsolute(path), path).toBe(true);
      expect(inside(tree, path), path).toBe(true);
      // The point of the criterion: not merely shaped like a path under
      // the worktree, but a file that is actually there.
      expect(existsSync(path), path).toBe(true);
      // And not the repository the worktree was created from, which
      // holds a file of the same name at the same relative path.
      expect(inside(root, path), path).toBe(false);
    }
  });
});

/**
 * ── A limitation, asserted on purpose ──────────────────────────────
 *
 * READ THIS BEFORE "FIXING" THE TEST BELOW. It asserts that CodeWiki
 * gets something *wrong*, and it is written that way deliberately.
 *
 * A snapshot exported from one root and restored into a different one
 * still describes the first root. Every path in the restored index
 * points at the checkout it was built from — a checkout the machine
 * doing the restoring may not even have. The cause is not subtle:
 * `codewiki-cli/src/commands/util.rs` composes absolute paths when it
 * builds the graph, and the CLI and MCP layers strip the root prefix
 * only when they print. Nothing in a snapshot is relative to anything.
 *
 * That fact is why this feature indexes every item worktree from
 * nothing (EO-141, EO-149). The obvious design was a baseline index per
 * repository, snapshotted once and restored into each worktree as it
 * was created; it was dropped because a restored baseline carries the
 * old root, so a sync would re-extract every file as new and leave the
 * originals behind as stale duplicates — an index that is worse than no
 * index, and silently so. A cold index of kubernetes takes 55s, so a
 * normal repository is a few seconds of CPU at worktree creation, and
 * paying it makes concurrent-item isolation free rather than
 * something to engineer.
 *
 * So the assertion is the wrong way round on purpose, and that is the
 * whole value of it. **If this test fails, nothing is broken — a newer
 * CodeWiki has started storing paths relatively, and the baseline
 * strategy has become available.** Delete the test, reopen the pinned
 * decision on EO-141, and say so; do not adjust the expectation until
 * it passes. Written as a comment instead, this would have been a
 * paragraph nobody read again, and the limitation would have quietly
 * outlived its cause.
 */
describe("a snapshot restored into a different root", () => {
  itWithTheBinary("still answers with the ORIGINAL root's paths — the limitation this feature is designed around", async () => {
    const origin = await makeRepository("the root it was built from");
    const elsewhere = await makeRepository("a different root entirely");
    const snapshot = join(scratch, "the exported snapshot.db");

    built(await providerFor().initialize(target(origin)));
    await ask(origin, ["snapshot", "-o", snapshot]);
    await ask(elsewhere, ["restore", snapshot]);

    const paths = filePathsIn(await ask(elsewhere, ["files"]));
    expect(paths).toHaveLength(Object.keys(FIXTURE).length);
    for (const path of paths) {
      // Asserting the limitation: the index restored into `elsewhere`
      // describes `origin`, and says nothing about the checkout it is
      // now sitting inside.
      expect(inside(origin, path), path).toBe(true);
      expect(inside(elsewhere, path), path).toBe(false);
    }

    // Sharpest form of the same thing. The file really is there in the
    // new root, at the same relative path, with the same contents — and
    // the index that was just restored into that root still names the
    // other one.
    expect(existsSync(fileIn(elsewhere, "src/alpha.ts"))).toBe(true);
    expect(locationOf(await ask(elsewhere, ["query", "alpha"]), "alpha")).toContain(fileIn(origin, "src/alpha.ts"));
  });
});
