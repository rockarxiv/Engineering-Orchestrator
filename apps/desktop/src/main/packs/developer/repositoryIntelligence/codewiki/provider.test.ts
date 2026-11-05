import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../../db/client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../../db/testHelpers.js";
import { samePath } from "../../workspace/git.js";
import type { ResolveOptions } from "../binary/resolve.js";
import type { RepositoryIndexBuild, RepositoryIndexTarget } from "../port.js";
import { createRepositoryIntelligenceService } from "../service.js";
import { CODEWIKI_HOOK_MARKER } from "./hooks.js";
import { createCodeWikiProvider, REPOSITORY_QUERY_SERVER_NAME } from "./provider.js";
import { runCodeWiki, type CodeWikiRunRequest, type CodeWikiRunResult } from "./run.js";
import { CODEWIKI_SHIM } from "./testShim.js";
import { readTree } from "../../../../testing/tree.js";
import { run } from "../../../../testing/git.js";
import { removeScratch } from "../../../../testing/scratch.js";

/**
 * The CodeWiki provider (EO-146).
 *
 * Real repositories, real git, real child processes. What stands in for
 * the binary is a Node script that behaves like v0.2.1 — same
 * subcommands, same summary lines, same habit of installing git hooks
 * wherever git tells it the hooks live — reached through the real
 * `runCodeWiki` wrapper, so argument handling, environment merging,
 * capture and timeouts are the production ones rather than a mock's.
 * None of it needs the 46 MB download, and none of it touches the
 * network; the last block in this file runs the same ground against the
 * real binary when there is one to run, and skips when there is not.
 *
 * The stand-in is deliberately *worse behaved* than the pinned version
 * in one respect. v0.2.1 installs its hooks after the `--no-index` early
 * return, so `init --no-index` never reaches them — meaning a test
 * against the real binary would pass the git-hook criterion without the
 * containment doing anything at all. The stand-in installs them
 * unconditionally, which is what the item describes and what a future
 * version could go back to. A guard proven only against software that
 * does not need it is not proven.
 */

const here = dirname(fileURLToPath(import.meta.url));
const mainSrcRoot = join(here, "..", "..");

/** Somewhere resolution reliably finds nothing, so the `cache` branch never fires by accident. */
const EMPTY_ROOT = join(tmpdir(), "eo-codewiki-no-such-root");

/** The real thing, when somebody has pointed the suite at one. */
const REAL_BINARY: ResolveOptions = {
  configuredPath: process.env["EO_CODEWIKI_BIN"] ?? null,
  root: process.env["EO_CODEWIKI_ROOT"] ?? EMPTY_ROOT,
};

let shims: string;

/** Exits 0 and does nothing whatsoever — the claim with nothing behind it. */
const SILENT_SHIM = `process.exit(0)`;

/** Fails the way a tool fails: an explanation on stderr and a non-zero status. */
const FAILING_SHIM = `process.stderr.write("no tree-sitter grammar for brainfuck at " + process.argv[3] + "\\n"); process.exit(3)`;

/** Never finishes. */
const HANGING_SHIM = `setInterval(() => {}, 1000)`;

/** Exits 0 with output that says nothing EO knows how to read. */
const GARBLED_SHIM = `process.stdout.write("all done!\\n"); process.exit(0)`;

/**
 * A tool that prints the line it choked on.
 *
 * The failure mode the whole no-source-content rule exists for, and not
 * a hypothetical one: a parser that cannot read a file has the offending
 * line in its hand, and printing it is the helpful thing for a parser to
 * do. It goes to both streams, because "we only quote stderr" is not a
 * rule about where source can appear. `EO_SHIM_EXIT` picks whether it
 * fails outright or exits 0 with output nothing can read — the two
 * different ways this output reaches a returned sentence.
 */
const LEAKY_SHIM = `
import { readFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const marker = argv.indexOf("--path");
const root = marker === -1 ? "." : argv[marker + 1];
let line = "";
try {
  line = readFileSync(join(root, "src", "alpha.ts"), "utf8").split("\\n")[0];
} catch {}
const complaint = "error: could not parse " + join(root, "src", "alpha.ts") + ":1\\n  |  " + line + "\\n";
process.stderr.write(complaint);
process.stdout.write(complaint);
process.exit(Number(process.env.EO_SHIM_EXIT || "3"));
`;

/**
 * Exits 0 printing three counter-shaped lines and no status block.
 *
 * What a build script, a linter or a binary that is not CodeWiki might
 * print. Nothing about it says an index was described, and reading it as
 * one is how a checkout with no index reaches READY.
 */
const COUNTERS_SHIM = `process.stdout.write("Files: 1\\nNodes: 2\\nEdges: 3\\n"); process.exit(0)`;

/**
 * Every command succeeds except the one that describes the index.
 *
 * The verification path on its own. `EO_SHIM_STATUS` picks how `status`
 * fails — refusing outright, or exiting 0 with something unreadable —
 * because those are two different things to tell a person and a build
 * that reported "there is no index" for both would have told them
 * neither.
 */
const BLIND_SHIM = `
const argv = process.argv.slice(2);
const command = argv[0];
const marker = argv.indexOf("--path");
const root = marker === -1 ? "." : argv[marker + 1];
if (command === "sync") {
  process.stdout.write("Sync complete: 0 added, 1 modified, 0 removed (2 ms)\\n");
  process.exit(0);
}
if (command === "status") {
  const mode = process.env.EO_SHIM_STATUS || "refuse";
  if (mode === "refuse") {
    process.stderr.write("no index found at " + root + "/.codewiki/codewiki.db; run \`codewiki init\` first\\n");
    process.exit(1);
  }
  process.stdout.write("Files: 1\\nNodes: 2\\nEdges: 3\\n");
  process.exit(0);
}
process.exit(0);
`;

/**
 * Answers with paths that are not this checkout's to give (EO-173).
 *
 * Three rows, of which one is real. A file in another root entirely,
 * because the pinned CodeWiki stores absolute paths and an index
 * restored from elsewhere goes on describing where it was built; and a
 * file inside `.codewiki/`, because the index sits in the checkout and
 * holds some of what it writes there. Neither is a file the agent was
 * searching for, and a suggestion made on the strength of one is the
 * suggestion this story exists to stop.
 */
const STRAY_PATHS_SHIM = `
const argv = process.argv.slice(2);
const marker = argv.indexOf("--path");
const root = argv[marker + 1];
const rows = [root + "/src/alpha.ts", "/somewhere/else/src/alpha.ts", root + "/.codewiki/routes/react/src/alpha.ts"];
if (argv[0] === "query") {
  process.stdout.write("KIND         LANGUAGE     NAME                                     LOCATION\\n");
  process.stdout.write("-".repeat(80) + "\\n");
  for (const row of rows) process.stdout.write("function     typescript   " + "alpha".padEnd(41) + row + ":1\\n");
  process.exit(0);
}
if (argv[0] === "files") {
  process.stdout.write("LANGUAGE         SIZE  NODES  PATH\\n");
  process.stdout.write("-".repeat(60) + "\\n");
  for (const row of rows) process.stdout.write("TypeScript        128      1  " + row + "\\n");
  process.stdout.write("\\n" + rows.length + " file(s) total.\\n");
  process.exit(0);
}
process.exit(0);
`;

let honest: string;
let silent: string;
let failing: string;
let hanging: string;
let garbled: string;
let leaky: string;
let counters: string;
let blind: string;
let strayPaths: string;

beforeAll(() => {
  shims = mkdtempSync(join(tmpdir(), "eo-codewiki-shims-"));
  const write = (name: string, source: string): string => {
    const path = join(shims, `${name}.mjs`);
    writeFileSync(path, source);
    return path;
  };
  honest = write("codewiki", CODEWIKI_SHIM);
  silent = write("silent", SILENT_SHIM);
  failing = write("failing", FAILING_SHIM);
  hanging = write("hanging", HANGING_SHIM);
  garbled = write("garbled", GARBLED_SHIM);
  leaky = write("leaky", LEAKY_SHIM);
  counters = write("counters", COUNTERS_SHIM);
  blind = write("blind", BLIND_SHIM);
  strayPaths = write("stray-paths", STRAY_PATHS_SHIM);
});

afterAll(() => {
  rmSync(shims, { recursive: true, force: true });
});

let scratch: string;
let workspace: string;
let logPath: string;
let target: RepositoryIndexTarget;


beforeEach(async () => {
  // A space in the path, because a repository path is user-controlled
  // and this one reaches argv, an environment variable and git.
  scratch = mkdtempSync(join(tmpdir(), "eo codewiki work "));
  workspace = join(scratch, "checkout");
  // Outside the checkout: a log file inside it would be a source file as
  // far as any indexer is concerned, and every count in this file would
  // be one out.
  logPath = join(scratch, "invocations.log");
  mkdirSync(workspace, { recursive: true });

  await run(["init", "-b", "main"], workspace);
  await run(["config", "user.email", "eo@example.com"], workspace);
  await run(["config", "user.name", "EO Test"], workspace);
  await run(["config", "commit.gpgsign", "false"], workspace);
  await run(["config", "tag.gpgsign", "false"], workspace);
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha() {\n  return 1;\n}\n");
  writeFileSync(join(workspace, "src", "beta.ts"), 'import { alpha } from "./alpha.js";\nexport const beta = alpha();\n');
  writeFileSync(join(workspace, "README.md"), "# a checkout\n");
  await run(["add", "-A"], workspace);
  await run(["commit", "-m", "first"], workspace);

  target = { workspaceId: "01a0-repo", itemId: "01a0-ticket", workspacePath: workspace };
});

afterEach(() => {
  removeScratch(scratch);
});

/**
 * A provider whose binary is one of the stand-ins above.
 *
 * The stand-in is reached through the `configured` branch of resolution
 * and the real wrapper, which is exactly what that branch is for: what
 * runs here is what a dispatch would have run, with a different
 * executable at the end of it.
 */
function providerFor(shim: string, options: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const binary: ResolveOptions = { root: EMPTY_ROOT, configuredPath: process.execPath };
  const run = (request: CodeWikiRunRequest): Promise<CodeWikiRunResult> =>
    runCodeWiki({
      ...request,
      binary,
      args: [shim, ...request.args],
      env: { ...request.env, ...options.env, EO_SHIM_LOG: logPath },
    });
  return createCodeWikiProvider({
    binary,
    run,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/** Every invocation the stand-in recorded, in order. */
function invocations(): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { argv?: string[] })
    .flatMap((entry) => (entry.argv ? [entry.argv] : []));
}

/** Where the stand-in reported putting hooks, if it put any anywhere. */
function hookTargets(): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { installedHooksIn?: string })
    .flatMap((entry) => (entry.installedHooksIn ? [entry.installedHooksIn] : []));
}

/**
 * A file's code with its comments taken out.
 *
 * `run.test.ts`'s helper, for its reason: an assertion about what a
 * module does must not be satisfied — or broken — by prose that happens
 * to discuss the thing being asserted about.
 */
function executableSource(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/** Narrows a build to the successful shape, and reports the reason when it is not one. */
function built(result: RepositoryIndexBuild): Extract<RepositoryIndexBuild, { ok: true }> {
  if (!result.ok) throw new Error(`expected a build, got a refusal: ${result.reason}`);
  return result;
}

/** The other way round: the sentence a refusal carried. */
function refused(result: { ok: boolean; reason?: string }): string {
  if (result.ok) throw new Error("expected a refusal, got a build");
  return result.reason ?? "";
}

/** Every hook file in the checkout's own hooks directory, with its contents. */
function repositoryHooks(): string[] {
  const hooks = join(workspace, ".git", "hooks");
  return readdirSync(hooks).map((name) => readFileSync(join(hooks, name), "utf8"));
}

/** The whole checkout except the index: every path, and every file's bytes. */
function checkoutContents(): Record<string, string> {
  return readTree(workspace, { skip: [".codewiki"] });
}

describe("the port, implemented", () => {
  it("answers every method the port declares, and nothing else", () => {
    const provider = providerFor(honest);

    expect(Object.keys(provider).sort()).toEqual(["ensureReady", "getAgentMcpConfig", "getStatus", "id", "initialize", "rebuild", "remove", "sync"]);
    expect(provider.id).toBe("codewiki");
  });

  it("stops the process it started when the caller's signal is aborted (EO-149)", async () => {
    // The indexing step owns a run a person can cancel, and until the
    // signal reached this the cancel was the no-op `cancelRun` was
    // against the pull request builtin before EO-77: the board called
    // the run cancelled while the tool went on walking the tree.
    //
    // A hanging stand-in, so the only thing that can end this call is
    // the abort — no timeout is set, and the shim never exits on its
    // own. If the signal were dropped the test would hang rather than
    // fail on an assertion, which is the honest shape for this one:
    // there is no "wrong answer" here, only "never answered".
    const controller = new AbortController();
    const building = providerFor(hanging, { signal: controller.signal }).initialize(target);
    // Long enough for the process to be up and the abort to be a kill
    // rather than a pre-emption.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();

    const outcome = await building;

    // Refused rather than thrown, and refused rather than reported as a
    // built index: everything in this port answers.
    expect(outcome.ok).toBe(false);
    expect(refused(outcome)).toMatch(/cancel/i);
    // And nothing was left claiming to be an index.
    expect(existsSync(join(workspace, ".codewiki", "codewiki.db"))).toBe(false);
  });

  it("is the only implementation of the port in the tree", () => {
    // A function that hands back a `RepositoryIntelligenceProvider` is
    // an implementation of it, wherever it lives. There is meant to be
    // one, and the day there are two is the day something outside this
    // directory has started to care which one it has.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (extname(full) === ".ts" && !full.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(mainSrcRoot);

    const implementations = files.filter((file) => /\)\s*:\s*RepositoryIntelligenceProvider\s*\{/.test(readFileSync(file, "utf8"))).map((file) => relative(mainSrcRoot, file));

    expect(implementations).toEqual([join("repositoryIntelligence", "codewiki", "provider.ts")]);
    // Non-vacuous: the scan reached a source tree rather than an empty
    // directory, which is the one failure mode this kind of test must
    // not have.
    expect(files.length).toBeGreaterThan(50);
  });

  it("never reaches for EO's own records", () => {
    // `remove` deletes derived state and nothing else — not items, not
    // comments, not runs, not repository configuration. The strongest
    // form of that promise is structural: nothing in this directory can
    // reach the database at all, so there is no path from here to a row.
    const files = readdirSync(here).filter((name) => name.endsWith(".ts"));
    const reaching = files.filter((name) => /from\s+["'][^"']*\/db\//.test(readFileSync(join(here, name), "utf8")) && !name.endsWith(".test.ts"));

    expect(reaching).toEqual([]);
    expect(files.length).toBeGreaterThan(3);
  });
});

describe("initialize", () => {
  it("runs init --no-index and then index, both scoped by --path", async () => {
    const build = built(await providerFor(honest).initialize(target));

    // The two commands, in order, each carrying the root. Nothing here
    // depends on a working directory.
    expect(invocations().filter((argv) => argv[0] === "init" || argv[0] === "index")).toEqual([
      ["init", "--no-index", "--path", workspace],
      ["index", "--path", workspace],
    ]);
    expect(build.indexPath).toBe(join(workspace, ".codewiki"));
    expect(existsSync(join(workspace, ".codewiki", "codewiki.db"))).toBe(true);
  });

  it("reports where the index is, what built it, and what it was built from", async () => {
    const head = await run(["rev-parse", "HEAD"], workspace);

    const build = built(await providerFor(honest).initialize(target));

    expect(build.indexPath).toBe(join(workspace, ".codewiki"));
    expect(build.providerVersion).toBe("0.2.1");
    expect(build.indexedCommitSha).toBe(head);
    expect(build.durationMs).toBeGreaterThan(0);
  });

  /**
   * How much disk the index takes, measured by the only layer entitled
   * to (EO-155).
   *
   * The measurement story asks for three numbers and this is the one
   * nothing was recording. It is asserted against the directory rather
   * than against a constant, because what belongs to "the index" is
   * this file's own decision — a version that wrote a second database
   * beside the first would still be answering correctly, and a test
   * pinned to one file's size would call that a regression.
   *
   * Sizes only, and never a byte of content: the walk `stat`s and does
   * not open.
   */
  it("reports how much disk the index it just built occupies", async () => {
    const build = built(await providerFor(honest).initialize(target));

    const onDisk = readdirSync(join(workspace, ".codewiki"), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .reduce((total, entry) => total + statSync(join(entry.parentPath, entry.name)).size, 0);

    expect(build.indexSizeBytes).toBe(onDisk);
    expect(build.indexSizeBytes).toBeGreaterThan(0);
  });

  /**
   * The acceptance criterion this story turns on.
   *
   * Not "no hooks were installed" — the stand-in installs them on every
   * `init`, and the assertion is that they went somewhere disposable
   * instead of into the repository. Both halves are checked: the
   * repository carries no marker, and the tool reports having written
   * hooks to a directory that is not the repository's.
   */
  it("leaves no file in the repository's .git/hooks carrying CodeWiki's marker", async () => {
    const before = repositoryHooks();

    const build = built(await providerFor(honest).initialize(target));

    expect(build.ok).toBe(true);
    expect(repositoryHooks().some((contents) => contents.includes(CODEWIKI_HOOK_MARKER))).toBe(false);
    // Unchanged, not merely unmarked: git's own samples are still
    // exactly as git wrote them.
    expect(repositoryHooks()).toEqual(before);

    // And the hooks really were installed somewhere — a redirection that
    // silently did nothing would pass the assertion above for the wrong
    // reason.
    expect(hookTargets()).toHaveLength(1);
    expect(hookTargets()[0]).not.toContain(workspace);
    expect(existsSync(join(hookTargets()[0] ?? "", "post-commit"))).toBe(false); // the throwaway directory is gone
  });

  it("puts the repository back and refuses the build when hooks land there anyway", async () => {
    // A tool that ignores `core.hooksPath` — upstream changing its mind,
    // or somebody's own build. The index is fine; EO refuses it anyway,
    // because a repository EO wrote into is the thing this feature
    // promised would never happen and a silent repair every dispatch is
    // how that promise rots.
    const provider = providerFor(honest, { env: { EO_SHIM_HOOKS: "repository" } });

    const reason = refused(await provider.initialize(target));

    expect(reason).toContain("installed git hooks into this repository");
    expect(reason).toContain(join(workspace, ".git", "hooks", "post-commit"));
    expect(repositoryHooks().some((contents) => contents.includes(CODEWIKI_HOOK_MARKER))).toBe(false);
    expect(existsSync(join(workspace, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("refuses a checkout where nothing was indexed, however cleanly the process exited", async () => {
    const reason = refused(await providerFor(silent).initialize(target));

    expect(reason).toContain(join(workspace, ".codewiki"));
    expect(existsSync(join(workspace, ".codewiki"))).toBe(false);
  });
});

describe("getStatus", () => {
  it("reads the index's own report of itself", async () => {
    const provider = providerFor(honest);
    await provider.initialize(target);

    const probe = await provider.getStatus(target);

    expect(probe).toMatchObject({ present: true, indexPath: join(workspace, ".codewiki"), providerVersion: "0.2.1", unavailableReason: null });
    expect(probe.indexedCommitSha).toBe(await run(["rev-parse", "HEAD"], workspace));
    expect(invocations().some((argv) => argv[0] === "status")).toBe(true);
  });

  it("does not call a checkout indexed because a process exited 0", async () => {
    const provider = providerFor(silent);

    expect(await provider.getStatus(target)).toMatchObject({ present: false, unavailableReason: null });
  });

  it("does not call an index present because a database file exists", async () => {
    // The file is there and the tool cannot describe it. `present` is
    // the tool's answer about the index, never the filesystem's about a
    // path.
    mkdirSync(join(workspace, ".codewiki"), { recursive: true });
    writeFileSync(join(workspace, ".codewiki", "codewiki.db"), "not a database");

    const probe = await providerFor(honest).getStatus(target);

    expect(probe.present).toBe(false);
    // The tool answered — "there is no index here" — so this is a fact
    // about the index rather than a machine that cannot answer.
    expect(probe.unavailableReason).toBeNull();
  });

  it("does not read three counter-shaped lines as an index", async () => {
    // Numbers in the right shape are not a status block. A build script,
    // a linter, or a binary somebody configured that is not CodeWiki at
    // all can print `Files: 1`; only `codewiki status` prints its own
    // signature above it, and without that anchor an exit-0 process that
    // never touched the index would be carried all the way to READY.
    await providerFor(honest).initialize(target);

    const probe = await providerFor(counters).getStatus(target);

    expect(probe.present).toBe(false);
    expect(probe.unavailableReason).toContain("could not read CodeWiki's description of the index");
  });

  it("tells a machine that cannot answer apart from a checkout with no index", async () => {
    mkdirSync(join(workspace, ".codewiki"), { recursive: true });
    writeFileSync(join(workspace, ".codewiki", "codewiki.db"), "{}");

    const probe = await providerFor(hanging, { timeoutMs: 750 }).getStatus(target);

    expect(probe.present).toBe(false);
    expect(probe.unavailableReason).toContain("did not finish");
  });

  it("says why when this machine has no binary at all", async () => {
    const provider = createCodeWikiProvider({ binary: { root: EMPTY_ROOT, platform: "darwin", arch: "x64" } });

    const probe = await provider.getStatus(target);

    expect(probe).toMatchObject({ present: false, providerVersion: null, indexedCommitSha: null });
    expect(probe.unavailableReason).toContain("Intel Macs");
    // Answered even when there is nothing: EO writes `index_path` on the
    // row before the build that would fill it.
    expect(probe.indexPath).toBe(join(workspace, ".codewiki"));
  });

  /**
   * The same criterion one layer up, where the word READY exists.
   *
   * The provider reports what it can see; the service decides what that
   * means. This is the whole path: a command that exits 0 and produces
   * nothing leaves a row saying `failed` with the reason on it, and
   * `resolveStatus` never answers `ready`.
   */
  it("leaves a row that never reaches ready when a clean exit produced no index", async () => {
    let handle: DbHandle | undefined;
    try {
      handle = openMigratedTestDb();
      const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: workspace, baseBranch: "main" });
      const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id });
      const service = createRepositoryIntelligenceService({ db: handle.db, provider: providerFor(silent) });
      const indexed = { workspaceId: repository.id, itemId: item.id, workspacePath: workspace };

      const outcome = await service.ensureIndexed(indexed);

      expect(outcome.ok).toBe(false);
      expect(await service.resolveStatus(indexed)).toBe("failed");
      expect(service.describe(indexed)?.errorMessage).toContain(join(workspace, ".codewiki"));
    } finally {
      handle?.close();
    }
  });
});

/**
 * What a build says when its own verification cannot see an index.
 *
 * Every build ends by re-reading the index, and that read can fail three
 * ways which are three different things to do next: the tool refused,
 * the tool answered in words EO cannot read, or there is no index
 * database at all. A build that reported them all as "there is no index"
 * would leave a row saying `failed` with nothing on it worth acting on.
 */
describe("a build whose verification fails says why", () => {
  it("carries a refusing status command through to the failure", async () => {
    await providerFor(honest).initialize(target);
    writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha() {\n  return 5;\n}\n");

    const reason = refused(await providerFor(blind).sync(target));

    expect(reason).toContain("could not read the index at");
    expect(reason).toContain(join(workspace, ".codewiki"));
    expect(reason).toContain("exited with status 1");
    // The recognised diagnostic, in EO's words rather than the tool's.
    expect(reason).toContain("no index in that directory yet");
  });

  it("carries a malformed status answer through to the failure", async () => {
    await providerFor(honest).initialize(target);
    writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha() {\n  return 6;\n}\n");

    const reason = refused(await providerFor(blind, { env: { EO_SHIM_STATUS: "counters" } }).sync(target));

    expect(reason).toContain("could not read CodeWiki's description of the index");
    expect(reason).toContain(join(workspace, ".codewiki"));
    expect(reason).toContain("3 lines EO does not recognise");
  });

  it("puts that reason on the row the service marks failed", async () => {
    // The whole path, one layer up, where FAILED is a word that exists.
    // A person reading the board gets the sentence rather than a status.
    await providerFor(honest).initialize(target);
    let handle: DbHandle | undefined;
    try {
      handle = openMigratedTestDb();
      const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: workspace, baseBranch: "main" });
      const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id });
      const service = createRepositoryIntelligenceService({ db: handle.db, provider: providerFor(blind) });
      const indexed = { workspaceId: repository.id, itemId: item.id, workspacePath: workspace };

      const outcome = await service.ensureIndexed(indexed);

      expect(outcome.ok).toBe(false);
      expect(await service.resolveStatus(indexed)).toBe("failed");
      expect(service.describe(indexed)?.errorMessage).toContain("exited with status 1");
      expect(service.describe(indexed)?.errorMessage).toContain(join(workspace, ".codewiki"));
    } finally {
      handle?.close();
    }
  });
});

describe("sync", () => {
  it("records how long it took and how many files changed", async () => {
    const provider = providerFor(honest);
    await provider.initialize(target);
    writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha() {\n  return 2;\n}\n");

    const build = built(await provider.sync(target));

    expect(build.changedFileCount).toBe(1);
    expect(build.durationMs).toBeGreaterThan(0);
    expect(invocations().filter((argv) => argv[0] === "sync")).toEqual([["sync", "--path", workspace]]);
  });

  it("sees work that has not been committed", async () => {
    // A worktree carries uncommitted work, which is exactly what a
    // reviewer is about to read. A commit-to-commit diff would miss all
    // of it, which is why the count comes from the tool rather than from
    // git.
    const provider = providerFor(honest);
    await provider.initialize(target);
    writeFileSync(join(workspace, "src", "gamma.ts"), "export const gamma = 3;\n");

    expect(built(await provider.sync(target)).changedFileCount).toBe(1);
    expect(await run(["status", "--porcelain"], workspace)).toContain("gamma.ts");
  });

  it("counts nothing when nothing changed, and still calls that a sync", async () => {
    const provider = providerFor(honest);
    await provider.initialize(target);

    const build = built(await provider.sync(target));

    expect(build.changedFileCount).toBe(0);
    expect(build.durationMs).toBeGreaterThan(0);
  });

  it("refuses output it cannot read rather than reporting a sync it did not understand", async () => {
    await providerFor(honest).initialize(target);

    const reason = refused(await providerFor(garbled).sync(target));

    expect(reason).toContain("could not read what CodeWiki's sync did");
    expect(reason).toContain(join(workspace, ".codewiki"));
  });
});

describe("ensureReady", () => {
  it("builds when there is nothing, and updates when there is", async () => {
    const provider = providerFor(honest);

    expect(built(await provider.ensureReady(target)).indexPath).toBe(join(workspace, ".codewiki"));
    expect(invocations().map((argv) => argv[0])).toContain("index");

    writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha() {\n  return 3;\n}\n");
    const updated = built(await provider.ensureReady(target));

    expect(updated.changedFileCount).toBe(1);
    expect(invocations().filter((argv) => argv[0] === "index")).toHaveLength(1);
  });
});

describe("rebuild", () => {
  it("replaces the index and leaves the checkout exactly as it found it", async () => {
    const provider = providerFor(honest);
    await provider.initialize(target);
    // Something recognisable inside the index, to prove the directory
    // was thrown away rather than written over.
    writeFileSync(join(workspace, ".codewiki", "stale-leftover"), "from the last build\n");
    // Work in progress, staged and unstaged, so "unchanged" means
    // something stronger than "the committed files are still there".
    writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha() {\n  return 4;\n}\n");
    writeFileSync(join(workspace, "untracked.md"), "notes\n");
    await run(["add", "src/alpha.ts"], workspace);

    const contents = checkoutContents();
    const history = await run(["log", "--format=%H %s"], workspace);
    const status = await run(["status", "--porcelain"], workspace);

    const build = built(await provider.rebuild(target));

    expect(build.indexPath).toBe(join(workspace, ".codewiki"));
    expect(existsSync(join(workspace, ".codewiki", "codewiki.db"))).toBe(true);
    expect(existsSync(join(workspace, ".codewiki", "stale-leftover"))).toBe(false);
    expect(checkoutContents()).toEqual(contents);
    expect(await run(["log", "--format=%H %s"], workspace)).toBe(history);
    expect(await run(["status", "--porcelain"], workspace)).toBe(status);
  });
});

describe("remove", () => {
  it("deletes the index and nothing else", async () => {
    const provider = providerFor(honest);
    await provider.initialize(target);
    const contents = checkoutContents();
    const history = await run(["log", "--format=%H %s"], workspace);
    const config = readFileSync(join(workspace, ".git", "config"), "utf8");

    expect(await provider.remove(target)).toEqual({ ok: true });

    expect(existsSync(join(workspace, ".codewiki"))).toBe(false);
    expect(checkoutContents()).toEqual(contents);
    expect(await run(["log", "--format=%H %s"], workspace)).toBe(history);
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).toBe(config);
    expect(existsSync(workspace)).toBe(true);
  });

  it("succeeds when there was nothing to delete", async () => {
    // What the caller asked for is true when this returns, and a
    // worktree being torn down has no use for a failure it cannot act
    // on.
    expect(await providerFor(honest).remove(target)).toEqual({ ok: true });
  });

  it("refuses a target that names no checkout rather than deleting something relative", async () => {
    const provider = providerFor(honest);

    const outcome = await provider.remove({ workspaceId: "r", itemId: "t", workspacePath: "" });

    expect(outcome).toEqual({ ok: false, reason: "EO was not given an absolute path to a checkout, so it did nothing to the repository index." });
    expect(refused(await provider.initialize({ workspaceId: "r", itemId: "t", workspacePath: "relative/path" }))).toContain("absolute path");
  });
});

describe("every way this can fail is an answer, not an exception", () => {
  it("reports a machine upstream publishes no build for", async () => {
    const provider = createCodeWikiProvider({ binary: { root: EMPTY_ROOT, platform: "darwin", arch: "x64" } });

    expect(refused(await provider.initialize(target))).toContain("Intel Macs");
    expect(refused(await provider.sync(target))).toContain("Intel Macs");
    expect(refused(await provider.ensureReady(target))).toContain("Intel Macs");
    expect(refused(await provider.rebuild(target))).toContain("Intel Macs");
    expect(await provider.getAgentMcpConfig(target)).toBeNull();
  });

  it("reports a binary EO has not downloaded", async () => {
    const provider = createCodeWikiProvider({ binary: { root: EMPTY_ROOT } });

    expect(refused(await provider.initialize(target))).toContain("has not downloaded");
  });

  it("reports a non-zero exit, and accounts for what the tool said without repeating it", async () => {
    const reason = refused(await providerFor(failing).initialize(target));

    expect(reason).toContain("exited with status 3");
    // The shape of what it said — which stream, how much — rather than
    // the words. `output.test.ts` covers the other half: a diagnostic EO
    // recognises comes back as EO's own sentence about it.
    expect(reason).toContain("1 line on stderr that EO does not recognise");
    expect(reason).not.toContain("brainfuck");
  });

  it("reports a hang as a hang, distinguishably from a failure", async () => {
    const reason = refused(await providerFor(hanging, { timeoutMs: 750 }).initialize(target));

    expect(reason).toContain("did not finish");
    expect(reason).not.toContain("exited with status");
  });

  it("reports output it cannot read", async () => {
    // An index exists, and this build's tool describes it in words EO
    // does not know. Every command exited 0; nothing about that is
    // evidence, which is the whole of invariant #5 applied to a
    // subprocess.
    await providerFor(honest).initialize(target);

    const reason = refused(await providerFor(garbled).initialize(target));

    expect(reason).toContain("could not read CodeWiki's description of the index");
    expect(reason).toContain(join(workspace, ".codewiki"));
  });

  it("reports a clean exit that produced no index at all", async () => {
    const reason = refused(await providerFor(garbled).initialize(target));

    expect(reason).toContain("left no index");
    expect(reason).toContain(join(workspace, ".codewiki"));
    expect(reason).toContain("codewiki.db");
  });
});

describe("what EO says about a repository, and what it never says", () => {
  const SECRET = "SUPER_SECRET_TOKEN_abc123_that_lives_only_in_a_source_file";

  /** A checkout whose first source line is worth never repeating. */
  async function withASecret(): Promise<void> {
    writeFileSync(join(workspace, "src", "alpha.ts"), `export const key = "${SECRET}";\n`);
    await run(["commit", "-am", "a secret"], workspace);
  }

  it("carries paths and counts through every ordinary call, and never a line of anybody's source", async () => {
    await withASecret();

    const results: unknown[] = [];
    const working = providerFor(honest);
    results.push(await working.initialize(target));
    writeFileSync(join(workspace, "src", "alpha.ts"), `export const key = "${SECRET}"; // touched\n`);
    results.push(await working.sync(target));
    results.push(await working.getStatus(target));
    results.push(await working.getAgentMcpConfig(target));
    results.push(await working.rebuild(target));
    results.push(await working.remove(target));

    const stringsIn = (value: unknown): string[] => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.flatMap(stringsIn);
      if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
      return [];
    };
    const values = results.flatMap(stringsIn);
    // Compare filesystem identity, not JSON escaping, separators or the
    // long/8.3 spelling Windows happened to return.
    expect(values.some((value) => isAbsolute(value) && (samePath(value, workspace) || samePath(dirname(value), workspace)))).toBe(true);
    const said = results.map((result) => JSON.stringify(result));
    for (const line of said) expect(line).not.toContain(SECRET);
  });

  /**
   * The case the rule exists for: a tool that prints the line it choked
   * on.
   *
   * A parser that cannot read a file has the offending line in its hand,
   * and quoting it is the helpful thing for a parser to do — upstream
   * today or a binary somebody configured tomorrow. Whatever it prints,
   * none of it may reach `repository_indexes.error_message`, because
   * that message becomes a comment on an item.
   *
   * Both routes are covered, because they reach a returned sentence
   * through different code: a command that failed, and a command that
   * exited 0 with output the verification could not read.
   */
  it("never repeats a source line the tool printed, however the failure reached it", async () => {
    await withASecret();

    const failed = refused(await providerFor(leaky).initialize(target));
    expect(failed).not.toContain(SECRET);
    // Still actionable: which operation, what became of the process, and
    // an account of what it had to say.
    expect(failed).toContain("could not create the repository index");
    expect(failed).toContain("exited with status 3");
    expect(failed).toContain("does not recognise");

    // And through the verification, where the output is not a failure at
    // all until EO tries to read it.
    await providerFor(honest).initialize(target);
    const unread = refused(await providerFor(leaky, { env: { EO_SHIM_EXIT: "0" } }).initialize(target));
    expect(unread).not.toContain(SECRET);
    expect(unread).toContain("could not read CodeWiki's description of the index");

    // Nor does it reach a probe, which is what the service reads.
    const probe = await providerFor(leaky, { env: { EO_SHIM_EXIT: "0" } }).getStatus(target);
    expect(JSON.stringify(probe)).not.toContain(SECRET);
  });

  /**
   * The same rule, on the one value that outlives the call.
   *
   * Everything else a reader returns is a number or a sentence EO wrote,
   * and both die with the result. `providerVersion` is written to
   * `repository_indexes.provider_version` and shown on a card, so a
   * binary somebody configured that answers `--version` with a line of
   * source would put it in front of a person and leave it there. The
   * whole path is asserted, not just the parser: the build, the probe,
   * and the row the service writes.
   */
  it("never stores a version a configured binary made up out of source", async () => {
    await withASecret();
    const lying = { EO_SHIM_VERSION: `codewiki 1.2.3-${SECRET}` };

    const build = built(await providerFor(honest, { env: lying }).initialize(target));
    // The build still succeeds: an unreadable version is "no opinion",
    // not a failure — a machine that cannot name its binary can still
    // index a checkout.
    expect(build.providerVersion).toBeNull();
    expect(JSON.stringify(build)).not.toContain(SECRET);

    const probe = await providerFor(honest, { env: lying }).getStatus(target);
    expect(probe.providerVersion).toBeNull();
    expect(JSON.stringify(probe)).not.toContain(SECRET);

    let handle: DbHandle | undefined;
    try {
      handle = openMigratedTestDb();
      const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: workspace, baseBranch: "main" });
      const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id });
      const service = createRepositoryIntelligenceService({ db: handle.db, provider: providerFor(honest, { env: lying }) });
      const indexed = { workspaceId: repository.id, itemId: item.id, workspacePath: workspace };

      const outcome = await service.ensureIndexed(indexed);

      expect(outcome.ok).toBe(true);
      const row = service.describe(indexed);
      expect(row?.providerVersion).toBeNull();
      expect(JSON.stringify(row)).not.toContain(SECRET);
    } finally {
      handle?.close();
    }
  });

  it("still stores the version a binary answers with properly", async () => {
    // Non-vacuous: the refusal above is about the shape of the answer,
    // not about the provider having quietly stopped reading versions.
    expect(built(await providerFor(honest).initialize(target)).providerVersion).toBe("0.2.1");
  });

  it("cannot repeat one, by construction", () => {
    // The behavioural tests above cover the failures anyone thought of.
    // This one covers the next message somebody adds: the two streams a
    // subprocess writes are read in exactly one way in this file — handed
    // to a reader in `output.ts`, which returns numbers, a validated
    // token or EO's own sentences — so there is nowhere for captured
    // output to become part of a message in the first place. git's
    // output counts too: a commit sha is read and shape-checked by the
    // same module rather than trusted because of where it came from.
    //
    // The two listing readers EO-173 added are the one place where
    // something the tool printed does travel — names and paths out of an
    // index — and the guarantee about them is a different one, asserted
    // separately below: what they return decides a boolean and never
    // reaches a sentence, a comment or a row.
    const readers = /\b(readIndexReport|readSyncReport|readVersion|readCommitSha|readSymbolListing|readFileListing|explainOutput)\([^)]*\)/g;
    const source = executableSource(join(here, "provider.ts"));

    expect(source).toMatch(/\.(stdout|stderr)\b/);
    expect(source.replace(readers, "")).not.toMatch(/\.(stdout|stderr)\b/);
  });
});

describe("the query server an agent is given", () => {
  it("is a stdio command pointed at this checkout, with the watcher off", async () => {
    const provider = providerFor(honest);
    await provider.initialize(target);

    const server = await provider.getAgentMcpConfig(target);

    expect(server).toEqual({
      name: REPOSITORY_QUERY_SERVER_NAME,
      command: process.execPath,
      args: ["serve", "--mcp", "--path", workspace, "--no-watch"],
      env: {},
      // EO-165. The one thing in the server that is not the generic
      // shape of an stdio command: the words an adapter needs to answer
      // a broad `grep -rn` by naming a call rather than a capability.
      answers: { symbol: "codewiki_search", area: "codewiki_context", reach: ["codewiki_callers", "codewiki_impact"], files: "codewiki_files" },
      // EO-173. Naming those calls is only advice worth giving when
      // there is something behind them, and this is how the one place
      // that decides finds out.
      knows: expect.any(Function),
    });
    // Named for what it describes rather than for what built it: an
    // agent that learned `codewiki_*` tool ids would have to be
    // retrained the day the implementation changed.
    expect(REPOSITORY_QUERY_SERVER_NAME).toBe("repo");
  });

  it("is null when there is no index to query, which is not an error", async () => {
    expect(await providerFor(honest).getAgentMcpConfig(target)).toBeNull();
  });
});

/**
 * Asking the index what it holds, before anything suggests querying it
 * (EO-173).
 *
 * The provider's half of the story. Everything here goes through the
 * real `runCodeWiki` to a stand-in that prints v0.2.1's own tables, so
 * what is under test is the whole path — argv, capture, parsing and the
 * judgement about which paths belong to this checkout — rather than a
 * mocked return value.
 *
 * The rule every case shares: this answers, and never throws. A caller
 * holding up a tool call cannot be handed an exception, and every empty
 * answer here becomes a suggestion that is not made.
 */
describe("what the index says it holds", () => {
  const askingOf = async (shim: string, options: { timeoutMs?: number } = {}) => {
    const provider = providerFor(shim, options);
    await providerFor(honest).initialize(target);
    const server = await provider.getAgentMcpConfig(target);
    if (server?.knows === undefined) throw new Error("expected a server that can be asked");
    return server.knows;
  };

  it("answers a name it holds with that name and a path inside the checkout", async () => {
    const knows = await askingOf(honest);

    expect(await knows({ of: "symbol", name: "alpha" })).toEqual([{ name: "alpha", path: "src/alpha.ts" }]);
    // Relative, which is what the port promises and what the one caller
    // compares against the directories an agent named on its command
    // line. An absolute path would never match `src`.
    for (const hit of await knows({ of: "symbol", name: "beta" })) expect(isAbsolute(hit.path)).toBe(false);
  });

  it("reports a loose match as the name the index actually holds", async () => {
    // The `quota` → `QuotaEvent` case, which is the whole reason the port
    // carries a name at all. The tool ranks near misses; this must hand
    // back what it was given rather than the word that was asked, because
    // only the caller can decide that a near miss is not an answer — and
    // it can only decide that if it can see one.
    const knows = await askingOf(honest);

    expect(await knows({ of: "symbol", name: "alph" })).toEqual([{ name: "alpha", path: "src/alpha.ts" }]);
  });

  it("answers nothing for a name it does not hold", async () => {
    const knows = await askingOf(honest);

    expect(await knows({ of: "symbol", name: "transitionItem" })).toEqual([]);
  });

  it("answers a filename pattern with the files that match it, and nothing for one that matches none", async () => {
    const knows = await askingOf(honest);

    expect((await knows({ of: "file", pattern: "*.ts" })).map((hit) => hit.path).sort()).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(await knows({ of: "file", pattern: "README.*" })).toEqual([{ name: "README.md", path: "README.md" }]);
    expect(await knows({ of: "file", pattern: "src/**/*.ts" })).toHaveLength(2);
    expect(await knows({ of: "file", pattern: "*.rs" })).toEqual([]);
    // A walk that named nothing asks whether the index holds any files
    // at all, and this one does.
    expect(await knows({ of: "file", pattern: "*" })).toHaveLength(3);
  });

  it("drops what is not in this checkout, and the index's own directory with it", async () => {
    // Two answers nobody asked for. The pinned CodeWiki stores absolute
    // paths — `isolation.test.ts` asserts that limitation deliberately —
    // so an index restored from elsewhere describes another root; and
    // `.codewiki/` sits inside the checkout and holds files EO generated.
    // Suggesting a call because it can find one of those is the failure
    // this story exists to stop.
    const knows = await askingOf(strayPaths);

    expect(await knows({ of: "symbol", name: "alpha" })).toEqual([{ name: "alpha", path: "src/alpha.ts" }]);
    expect(await knows({ of: "file", pattern: "*.ts" })).toEqual([{ name: "src/alpha.ts", path: "src/alpha.ts" }]);
  });

  it("answers nothing, rather than throwing, however the tool fails", async () => {
    for (const [shim, why] of [
      [failing, "a non-zero exit"],
      [silent, "an exit 0 that printed nothing"],
      [counters, "output that is not a listing at all"],
      [garbled, "output EO cannot read"],
    ] as const) {
      const knows = await askingOf(shim);
      expect(await knows({ of: "symbol", name: "alpha" }), why).toEqual([]);
      expect(await knows({ of: "file", pattern: "*.ts" }), why).toEqual([]);
    }
  });

  it("gives up on a tool that will not answer, because a tool call is waiting on it", async () => {
    // The deadline is the point. A wedged binary must cost a suggestion
    // and not a stalled agent, so this returns rather than hangs — and a
    // test that got this wrong would hang rather than fail, which is the
    // honest shape for it.
    const knows = await askingOf(hanging, { timeoutMs: 200 });

    expect(await knows({ of: "symbol", name: "alpha" })).toEqual([]);
  }, 20_000);

  it("asks about the checkout it was fetched for and no other", async () => {
    const knows = await askingOf(honest);
    const invocations = readFileSync(logPath, "utf8");

    await knows({ of: "symbol", name: "alpha" });

    const asked = readFileSync(logPath, "utf8").slice(invocations.length).trim().split("\n").map((line) => JSON.parse(line) as { argv: string[] });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.argv).toEqual(["query", "alpha", "--limit", "25", "--path", workspace]);
  });

  it("never lets what the tool printed become a sentence", async () => {
    const SECRET = "SUPER_SECRET_TOKEN_xyz789_that_lives_only_in_a_source_file";
    // The other half of "cannot repeat one, by construction". These two
    // readers are the one place where output travels rather than being
    // counted, so the guarantee has to be about where it travels *to*:
    // a name and a path, and no field a person ever reads.
    writeFileSync(join(workspace, "src", "alpha.ts"), `export function alpha() {\n  return "${SECRET}";\n}\n`);
    const knows = await askingOf(honest);

    const held = [...(await knows({ of: "symbol", name: "alpha" })), ...(await knows({ of: "file", pattern: "*" }))];

    expect(held.length).toBeGreaterThan(0);
    expect(JSON.stringify(held)).not.toContain(SECRET);
    for (const hit of held) expect(Object.keys(hit).sort()).toEqual(["name", "path"]);
  });
});

/**
 * The same ground, against the real binary.
 *
 * Skipped rather than failed when there is none, because `pnpm test`
 * must not require a 46 MB download and CI must not reach the network.
 * Point it at one to make it run:
 *
 *     EO_CODEWIKI_BIN=/path/to/codewiki pnpm exec vitest run --root apps/desktop \
 *       src/main/packs/developer/repositoryIntelligence/codewiki/provider.test.ts
 */
const realBinaryPath = process.env["EO_CODEWIKI_BIN"];
const hasRealBinary = realBinaryPath !== undefined && existsSync(realBinaryPath);

describe.skipIf(!hasRealBinary)("against the real binary", () => {
  it("indexes a checkout, describes it, syncs a change and leaves the repository's hooks alone", async () => {
    const provider = createCodeWikiProvider({ binary: REAL_BINARY });
    const before = repositoryHooks();

    const build = built(await provider.initialize(target));
    expect(build.indexPath).toBe(join(workspace, ".codewiki"));
    expect(build.providerVersion).toBeTruthy();
    expect(existsSync(join(workspace, ".codewiki", "codewiki.db"))).toBe(true);
    expect(repositoryHooks()).toEqual(before);
    expect(repositoryHooks().some((contents) => contents.includes(CODEWIKI_HOOK_MARKER))).toBe(false);

    expect(await provider.getStatus(target)).toMatchObject({ present: true, unavailableReason: null });

    writeFileSync(join(workspace, "src", "alpha.ts"), "export function alpha() {\n  return 9;\n}\n");
    const synced = built(await provider.sync(target));
    expect(synced.changedFileCount).toBe(1);
    expect(synced.durationMs).toBeGreaterThan(0);

    expect(built(await provider.rebuild(target)).indexPath).toBe(join(workspace, ".codewiki"));
    expect(await provider.remove(target)).toEqual({ ok: true });
    expect(existsSync(join(workspace, ".codewiki"))).toBe(false);
  }, 120_000);

  it("answers what it holds, off the real tool's own tables (EO-173)", async () => {
    // The one thing the stand-in cannot prove. Everything above parses
    // tables EO wrote the fixtures for, and a parser tested only against
    // output its author imagined is a parser that agrees with its
    // author — this module's own doc comment says so. So the shapes are
    // read back off v0.2.1 itself.
    const provider = createCodeWikiProvider({ binary: REAL_BINARY });
    built(await provider.initialize(target));
    const server = await provider.getAgentMcpConfig(target);
    const knows = server?.knows;
    expect(knows, "the real binary produced no server to ask").toBeDefined();
    if (knows === undefined) return;

    // A declared name, answered under that name and at a path inside
    // this checkout.
    expect(await knows({ of: "symbol", name: "alpha" })).toContainEqual({ name: "alpha", path: "src/alpha.ts" });

    // A name nothing is declared under. `No matches.` is a sentence
    // rather than a table, and reading it as unparseable output would
    // work by accident — both answer empty — while hiding that EO had
    // stopped understanding the tool.
    expect(await knows({ of: "symbol", name: "transitionItem" })).toEqual([]);

    // The loose matching this whole story turns on: asked for a
    // substring, the real tool ranks near misses, and what comes back
    // must be the names it actually holds rather than the word asked
    // for. If this ever returns nothing, the tool stopped matching
    // loosely and `worthSuggesting`'s exact-name rule has become dead
    // weight rather than a filter.
    const loose = await knows({ of: "symbol", name: "alph" });
    expect(loose.some((hit) => hit.name === "alpha")).toBe(true);

    // Files, and the footer and blank line the listing ends with.
    const ts = await knows({ of: "file", pattern: "*.ts" });
    expect(ts.map((hit) => hit.path).sort()).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(await knows({ of: "file", pattern: "*.rs" })).toEqual([]);
    expect((await knows({ of: "file", pattern: "*" })).length).toBeGreaterThanOrEqual(2);

    // And every path relative, never absolute, whatever the tool
    // printed.
    for (const hit of [...ts, ...loose]) expect(isAbsolute(hit.path)).toBe(false);
  }, 120_000);
});
