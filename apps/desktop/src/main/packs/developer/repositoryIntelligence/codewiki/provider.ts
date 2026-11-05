import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { REPOSITORY_MCP_SERVER_NAME } from "@eo/core";
import { git } from "../../workspace/git.js";
import type { ResolveOptions } from "../binary/resolve.js";
import type {
  RepositoryIndexAnswers,
  RepositoryIndexBuild,
  RepositoryIndexHit,
  RepositoryIndexProbe,
  RepositoryIndexQuestion,
  RepositoryIndexQueryServer,
  RepositoryIndexRemoval,
  RepositoryIndexTarget,
  RepositoryIntelligenceProvider,
} from "../port.js";
import { matchesFilePattern } from "./fileMatch.js";
import { containHooks, describeHookEscape } from "./hooks.js";
import { explainOutput, readCommitSha, readFileListing, readIndexReport, readSymbolListing, readSyncReport, readVersion } from "./output.js";
import { codeWikiExecutable, runCodeWiki, type CodeWikiExecutable, type CodeWikiRunRequest, type CodeWikiRunResult } from "./run.js";

/**
 * The first implementation of the port: CodeWiki behind it, and nothing
 * of CodeWiki in front of it (EO-141).
 *
 * The division of labour, and the reason there are three files here
 * rather than one. `run.ts` runs things — it knows about argv, process
 * groups, timeouts and bounded capture, and nothing about what a
 * subcommand means. This file decides what to run and what the result
 * amounts to: that a build is two commands, that an exit status is not
 * evidence of an index, that a sync's summary is worth reading. Keeping
 * those apart is what lets the decisions be read on their own, and what
 * kept `run.ts` free of a single sentence that names a subcommand.
 *
 * Every command carries `--path <root>`, so nothing here depends on a
 * working directory. The `cwd` handed to the runner is the checkout
 * because a child process must start somewhere real, not because
 * anything is resolved against it.
 *
 * Nothing in this file throws for an outcome, and nothing in it logs.
 * A missing binary, a non-zero exit, a hang and output EO cannot read
 * are all ordinary answers with a sentence attached, because repository
 * intelligence degrades rather than blocks — an agent whose index failed
 * still has the filesystem and git tools it has always had. And what it
 * has to say, it says in what it returns, where the service can put it
 * on a row and in a comment: a provider that also logged would be a
 * second account of the same event, kept in a place nobody reads.
 *
 * On file contents: this provider never opens a source file, and it
 * never repeats what the tool printed. It asks the tool about the index
 * and git about the commit, and everything it says is composed here —
 * paths EO built, counts EO computed, and `explainOutput`'s
 * classification of a diagnostic rather than the diagnostic itself. A
 * tool that quotes the line it choked on must not be able to put that
 * line in a comment on somebody's item, and the only way to be sure of
 * that is for nothing it printed to reach a sentence. Paths and counts
 * travel; bodies do not.
 */

/** What goes in `repository_indexes.provider`. Opaque to everything above the port. */
export const CODEWIKI_PROVIDER_ID = "codewiki";

/**
 * Where the index lives, relative to the checkout it describes.
 *
 * Not configurable, and not by EO's choice: `--path` moves the index and
 * what gets indexed together, so the directory is wherever the thing
 * being indexed is.
 *
 * Exported because EO's own cleanliness checks have to step over it —
 * a worktree with an index in it is still clean — and this is the only
 * file entitled to answer what it is called (EO-163). It reaches those
 * checks the way everything else about this implementation reaches
 * anything: through the composition root, which is the one file allowed
 * to name an implementation, and out again as one of
 * `REPOSITORY_INDEX_DIRECTORIES`. Nothing between here and
 * `workspace/verify.ts` learns whose directory it is.
 *
 * The first version of this constant sat in `../indexPaths.ts` instead,
 * where the predicates that use it live. That read as tidy and was the
 * whole bug: a file whose job is to be implementation-agnostic held the
 * one string only this implementation can supply, so a second provider
 * would have had to edit the neutral layer to say what its own index is
 * called.
 */
export const CODEWIKI_INDEX_DIRECTORY = ".codewiki";

/** The file whose existence means a build got as far as creating an index. */
const INDEX_DATABASE = "codewiki.db";

/**
 * The name the query server is registered under, and so the middle of
 * every tool id the model sees: `repo`.
 *
 * Named for what it describes rather than for what built it. An agent
 * that learned to call `codewiki_*` tools would be an agent that has to
 * be retrained the day the implementation changes, which is the whole
 * thing this port exists to prevent.
 *
 * Taken from `packages/core` rather than spelled here (EO-151). The name
 * this registers under and the name the catalogue refuses a person are
 * one fact: reserving `repo` is what stops an added server shadowing
 * this one, and a reservation that could drift from the registration
 * would protect a name nobody was using.
 */
export const REPOSITORY_QUERY_SERVER_NAME = REPOSITORY_MCP_SERVER_NAME;

/**
 * The four calls this implementation would rather an agent made than a
 * `grep -rn` across the checkout (EO-165).
 *
 * **Here because this is the only file entitled to know them.** The
 * adapter that intercepts a broad search has to name the call that
 * answers it — EO-164 measured "prefer the index" as inert, and a
 * message that does not name a call is that sentence again — but the
 * calls are CodeWiki's, and an adapter spelling `codewiki_search` would
 * be the agent-facing half of the coupling `REPOSITORY_QUERY_SERVER_NAME`
 * above exists to prevent. So the words leave through the port, the
 * same way `CODEWIKI_INDEX_DIRECTORY` leaves through the composition
 * root, and nothing between here and `providers/claude.ts` learns whose
 * they are.
 *
 * **Bare names.** `mcp__repo__` is Claude's spelling of a tool id;
 * qualifying these is the adapter's business, because the next backend's
 * spelling is its own.
 *
 * **Four, and these four.** They map onto the shapes a broad search
 * actually takes rather than onto the tool list: a name (`search`), an
 * area nobody has a name for yet (`context`), what a change would reach
 * (`callers`, `impact`) and where files are (`files`). EO-164 recorded
 * that `context` is the only one of the nine ever called by anybody and
 * that `callers`, `callees` and `impact` have never been invoked once —
 * so `reach` is here precisely because it is the half a tree search
 * cannot do at all, which is the only honest reason to interrupt
 * somebody mid-grep.
 */
const CODEWIKI_ANSWERS: RepositoryIndexAnswers = {
  symbol: "codewiki_search",
  area: "codewiki_context",
  reach: ["codewiki_callers", "codewiki_impact"],
  files: "codewiki_files",
};

/** How long to wait for `--version`, which either answers immediately or is not going to. */
const VERSION_TIMEOUT_MS = 30_000;

/**
 * How long one index lookup may take before EO stops waiting for it
 * (EO-173).
 *
 * Nothing like the indexing timeout next to it, because this is nothing
 * like an indexing command: it is a read of a local SQLite database, and
 * on this repository's own index it measures 5ms warm for both shapes of
 * question. What makes the number matter is where it is spent — a tool
 * call the agent already made is parked on it — so this is the point at
 * which a wedged binary stops being EO's problem and becomes silence.
 * `broadSearch.ts` keeps a second, looser deadline for the same reason a
 * belt has a brace: this one is the provider's promise, that one holds
 * even if a provider breaks it.
 */
const LOOKUP_TIMEOUT_MS = 1_500;

/**
 * How many symbols to ask for, given the caller wants one exact name.
 *
 * More than one because the tool matches loosely and ranks: asking for
 * a single result and getting `QuotaEvent` back would look like an
 * answer to `quota` and be counted as one. Enough of them that the exact
 * match, if it exists, is in the list to be found — and not so many that
 * a common substring returns half the index.
 */
const LOOKUP_LIMIT = 25;

export interface CodeWikiProviderDeps {
  /** How to find the binary: an explicit setting first, then what EO downloaded. */
  binary: ResolveOptions;
  /**
   * The runner, injectable.
   *
   * Defaulted rather than constructed here so that a test can put a
   * stand-in binary behind the real wrapper — argument handling,
   * environment merging, capture and all — instead of mocking the
   * boundary this provider is defined by. Production never passes it.
   */
  run?: (request: CodeWikiRunRequest) => Promise<CodeWikiRunResult>;
  /** Overrides the runner's own default for indexing commands. */
  timeoutMs?: number;
  /** Injectable so a test can assert on a duration without racing the clock. */
  now?: () => number;
  /**
   * Aborted when whoever asked for this work has stopped wanting it
   * (EO-149).
   *
   * Construction-time rather than a parameter on every port method,
   * which is a deliberate choice about where the seam goes. Cancellation
   * is a property of the *caller* — a run a person stopped, an app
   * shutting down — and a provider built for that caller can carry it
   * without the port ever learning the word. The alternative was an
   * `AbortSignal` on `RepositoryIndexTarget`, which would put a
   * lifecycle concern into the thing that identifies a row.
   *
   * Without it, cancelling a run during an index left `codewiki index`
   * walking the tree behind a run the board had already called
   * cancelled — the same no-op `cancelRun` was against the pull request
   * builtin before EO-77.
   */
  signal?: AbortSignal;
}

/** A refusal that never reached the binary. */
type Refusal = { ok: false; reason: string };

/**
 * How much disk the index directory occupies, or null if EO could not
 * tell (EO-155).
 *
 * Sizes only. This walks the directory the provider itself created and
 * adds up what `stat` says; it never opens a file, and there is nothing
 * in a byte count that could carry somebody's source into a row.
 *
 * Null rather than zero on failure, and never throwing. A build that
 * worked must not be reported as failed because a directory listing
 * raced a deletion, and a zero would read as an empty index rather than
 * as an unanswered question.
 *
 * Sync rather than async, which is the same call `existsSync` and
 * `rmSync` in this file already are: the directory the pinned
 * implementation writes is a SQLite database and its two sidecars, so
 * this is four `stat`s at the end of a build that took seconds.
 */
function directorySizeBytes(path: string): number | null {
  try {
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      total += statSync(join(entry.parentPath, entry.name)).size;
    }
    return total;
  } catch {
    return null;
  }
}

export function createCodeWikiProvider(deps: CodeWikiProviderDeps): RepositoryIntelligenceProvider {
  const run = deps.run ?? runCodeWiki;
  const now = deps.now ?? (() => Date.now());

  /**
   * The version a configured binary answered with, asked once.
   *
   * Only ever needed for a path somebody set by hand — what EO
   * downloaded is the version EO pinned and resolution says so without
   * spawning anything. Memoised because `getStatus` runs on every
   * dispatch and a binary does not change version while the app is
   * open; a failure is not memoised, so a transient one does not become
   * permanent.
   */
  let confirmedVersion: string | null = null;

  function indexPathFor(target: RepositoryIndexTarget): string {
    return join(target.workspacePath, CODEWIKI_INDEX_DIRECTORY);
  }

  function indexDatabaseFor(target: RepositoryIndexTarget): string {
    return join(indexPathFor(target), INDEX_DATABASE);
  }

  /**
   * Refuses a target that names no checkout, before anything acts on
   * it.
   *
   * `remove` is why this exists rather than being left to the tool. It
   * deletes a directory tree, and a relative — or empty — workspace path
   * would compose one against whatever the process's working directory
   * happens to be at the time. Every caller in EO passes an absolute
   * worktree path; the one that does not is a bug, and it should be a
   * sentence rather than a deletion.
   */
  function unusableTarget(target: RepositoryIndexTarget): Refusal | null {
    if (target.workspacePath.trim() === "" || !isAbsolute(target.workspacePath)) {
      return { ok: false, reason: "EO was not given an absolute path to a checkout, so it did nothing to the repository index." };
    }
    return null;
  }

  function invoke(target: RepositoryIndexTarget, args: string[], env?: Record<string, string>): Promise<CodeWikiRunResult> {
    return run({
      args: [...args, "--path", target.workspacePath],
      cwd: target.workspacePath,
      binary: deps.binary,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(env === undefined ? {} : { env }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  }

  /**
   * Why a command failed, in two sentences EO wrote.
   *
   * The first is the shape of the failure, which the runner already
   * describes — a status, a timeout, a binary that would not start. The
   * second is `explainOutput`'s account of what the tool said, which is
   * a classification and never a quotation.
   *
   * Nothing in this file interpolates `stdout` or `stderr` into a
   * sentence, and `provider.test.ts` asserts that structurally rather
   * than trusting it. This message reaches
   * `repository_indexes.error_message` and a comment on the item, and
   * a tool that prints the line it choked on would otherwise put
   * somebody's source in both.
   */
  function refusal(what: string, result: CodeWikiRunResult): string {
    const problem = result.problem ?? "CodeWiki did not say what went wrong.";
    return `EO could not ${what} the repository index: ${problem} ${explainOutput(result.stdout, result.stderr)}`;
  }

  /**
   * Runs work with CodeWiki's git hooks pointed somewhere disposable,
   * and reports whether any of them reached the repository anyway.
   *
   * Wrapped around everything that might write, rather than around
   * `init` alone. `init` is the command upstream documents as
   * installing them, but "which subcommand installs hooks" is a fact
   * about a version rather than a promise, and the check costs a
   * directory listing.
   */
  async function contained<T>(target: RepositoryIndexTarget, work: (env: Record<string, string>) => Promise<T>): Promise<{ value: T; escape: string | null }> {
    const containment = await containHooks(target.workspacePath);
    let released = false;
    try {
      const value = await work(containment.env);
      released = true;
      return { value, escape: describeHookEscape(await containment.release()) };
    } finally {
      // Work that threw is exactly the case that may have left
      // something behind, so the throwaway directory and the check
      // happen either way.
      if (!released) await containment.release();
    }
  }

  async function headSha(workspacePath: string): Promise<string | null> {
    const head = await git(["rev-parse", "HEAD"], workspacePath);
    return head.ok ? readCommitSha(head.stdout) : null;
  }

  async function version(executable: CodeWikiExecutable): Promise<string | null> {
    if (executable.version !== null) return executable.version;
    if (executable.path === null) return null;
    if (confirmedVersion !== null) return confirmedVersion;

    // The checkout is not the subject of this question and may not even
    // exist any more; a temporary directory is somewhere a process can
    // always be started from.
    //
    // A binary that has to be asked its version is one EO knows nothing
    // about, including whether it answers at all, and this call sits in
    // front of every probe. So it gets its own short bound — and a
    // caller that asked for a shorter one still gets that, because a
    // deadline that some calls quietly ignore is not a deadline.
    const timeoutMs = deps.timeoutMs === undefined ? VERSION_TIMEOUT_MS : Math.min(deps.timeoutMs, VERSION_TIMEOUT_MS);
    const result = await run({ args: ["--version"], cwd: tmpdir(), binary: deps.binary, timeoutMs, ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
    if (!result.ok) return null;
    confirmedVersion = readVersion(result.stdout);
    return confirmedVersion;
  }

  /**
   * A probe, plus the sentence that goes with it when there is nothing
   * to query.
   *
   * The two are separated because the port's probe cannot carry both
   * without lying about one of them. `unavailableReason` means "EO could
   * not answer" — an absent binary, a machine with no build — and a
   * `status` that exits non-zero to say there is no index yet is an
   * answer, not an absence. But a *build* that ends at that same probe
   * has failed, and a caller reading a row that says `failed` needs to
   * know whether the tool refused, timed out or printed something
   * unreadable.
   *
   * So `problem` carries the account of the verification for whoever
   * asked for a build, `getStatus` projects it away for whoever asked
   * for a probe, and the type makes the pairing impossible to get wrong:
   * there is no way to spell "not present, and no reason why".
   */
  type Verification = { present: true; probe: RepositoryIndexProbe } | { present: false; probe: RepositoryIndexProbe; problem: string };

  /**
   * What EO can see for this target, asked of the index rather than
   * inferred from a process.
   *
   * The order is the argument. A binary that cannot be resolved is an
   * unavailability and says so. A checkout with no index database has
   * no index, whatever any command exited with — and answering that
   * from the filesystem costs nothing and spawns nothing. Only then is
   * the tool asked to describe what it has, and only its own answer —
   * a report carrying the signature `status` prints, not merely three
   * numbers — makes this `present`.
   *
   * An index reporting zero files is still present. A repository with
   * nothing indexable is a real answer about a real index; calling it
   * absent would send the service round a loop of rebuilding something
   * that is already exactly what it is going to be.
   */
  async function verify(target: RepositoryIndexTarget): Promise<Verification> {
    const indexPath = indexPathFor(target);
    const executable = codeWikiExecutable(deps.binary);
    if (executable.path === null) {
      const problem = executable.reason ?? "EO could not find a CodeWiki binary on this machine.";
      return {
        present: false,
        probe: { present: false, indexPath, providerVersion: null, indexedCommitSha: null, unavailableReason: problem },
        problem,
      };
    }

    const providerVersion = await version(executable);
    if (!existsSync(indexDatabaseFor(target))) {
      return {
        present: false,
        probe: { present: false, indexPath, providerVersion, indexedCommitSha: null, unavailableReason: null },
        problem: `CodeWiki left no index at ${indexPath}: there is no ${INDEX_DATABASE} in it.`,
      };
    }

    const result = await invoke(target, ["status"]);
    if (!result.ok) {
      const problem = `EO could not read the index at ${indexPath}: ${result.problem ?? "CodeWiki did not say what went wrong."} ${explainOutput(result.stdout, result.stderr)}`;
      // A non-zero exit is the tool answering — "no index found here" is
      // how it says there is nothing to describe — so the *probe* calls
      // it a fact about the index rather than an unavailability. A
      // timeout, a cancellation or a binary that would not start
      // produced no answer at all, and that distinction is the one a
      // caller acts on. Either way the sentence survives for a build to
      // report.
      return {
        present: false,
        probe: { present: false, indexPath, providerVersion, indexedCommitSha: null, unavailableReason: result.status === "exit" ? null : problem },
        problem,
      };
    }

    if (readIndexReport(result.stdout) === null) {
      const problem = `EO could not read CodeWiki's description of the index at ${indexPath}: ${explainOutput(result.stdout, result.stderr)}`;
      return {
        present: false,
        probe: { present: false, indexPath, providerVersion, indexedCommitSha: null, unavailableReason: problem },
        problem,
      };
    }

    return {
      present: true,
      probe: { present: true, indexPath, providerVersion, indexedCommitSha: await headSha(target.workspacePath), unavailableReason: null },
    };
  }

  /** The port's probe: what `verify` saw, with the account meant for a build left behind. */
  async function getStatus(target: RepositoryIndexTarget): Promise<RepositoryIndexProbe> {
    return (await verify(target)).probe;
  }

  /**
   * Turns a command that finished into a build that succeeded, or
   * refuses to.
   *
   * Every path that reports `ok` comes through here, and it re-reads the
   * index first. Invariant #5 is the reason: a process exiting 0 is a
   * claim, `.codewiki/codewiki.db` described by the tool itself is a
   * check, and the gap between them is exactly where a build that
   * quietly indexed nothing would otherwise be recorded as ready to
   * query.
   */
  async function confirm(
    target: RepositoryIndexTarget,
    measured: { durationMs: number; changedFileCount?: number },
  ): Promise<RepositoryIndexBuild> {
    const verified = await verify(target);
    // The verification's own account, not a sentence about it. A build
    // that ends here is one the service will write `failed` on, and
    // "there is no index" tells nobody whether the tool refused, hung or
    // answered in words EO could not read — which is the difference
    // between rebuilding, retrying and looking at the binary.
    if (!verified.present) return { ok: false, reason: verified.problem };
    const size = directorySizeBytes(verified.probe.indexPath);
    return {
      ok: true,
      indexPath: verified.probe.indexPath,
      providerVersion: verified.probe.providerVersion,
      indexedCommitSha: verified.probe.indexedCommitSha,
      durationMs: measured.durationMs,
      ...(measured.changedFileCount === undefined ? {} : { changedFileCount: measured.changedFileCount }),
      ...(size === null ? {} : { indexSizeBytes: size }),
    };
  }

  /**
   * Builds an index for a checkout that has none.
   *
   * Two commands rather than one, and the split is deliberate.
   * `init --no-index` creates `.codewiki/` and the database and records
   * the root; `index` walks the tree and fills it. Asking `init` to do
   * both would also be asking it for everything else it does on the way
   * — in the pinned version, installing git hooks into the repository —
   * so EO takes the half it wants and runs the other half itself.
   *
   * That flag is not what makes it safe, though. In v0.2.1 the hook
   * install sits after `--no-index`'s early return
   * (`crates/codewiki-cli/src/commands/init.rs`), so this pair of calls
   * does not reach it — a fact about one version, not a promise, and one
   * a person's own `configuredPath` can put out of date without telling
   * anybody. What makes it safe is `hooks.ts`: the hooks are pointed
   * somewhere disposable and the repository is then checked to see that
   * they went there.
   */
  async function initialize(target: RepositoryIndexTarget): Promise<RepositoryIndexBuild> {
    const refused = unusableTarget(target);
    if (refused) return refused;

    const started = now();
    const { value, escape } = await contained(target, async (env) => {
      const created = await invoke(target, ["init", "--no-index"], env);
      if (!created.ok) return refusal("create", created);
      const built = await invoke(target, ["index"], env);
      if (!built.ok) return refusal("build", built);
      return null;
    });
    const durationMs = now() - started;

    // The containment failure is reported ahead of the command's own,
    // even though it is the less likely of the two. A build that failed
    // costs an agent its index; a build that wrote into somebody's
    // repository is the thing this feature promised never to do, and it
    // has to be the sentence they read.
    if (escape !== null) return { ok: false, reason: escape };
    if (value !== null) return { ok: false, reason: value };
    return confirm(target, { durationMs });
  }

  /**
   * Brings an existing index up to date with the working tree.
   *
   * The duration and the changed-file count are read here and carried on
   * the result because the last story in this feature is the
   * measurement, and a measurement bolted on afterwards measures
   * whatever survived. The count comes from the tool's own summary
   * rather than from a diff EO could compute: a checkout carries
   * uncommitted work that a commit-to-commit diff would miss entirely,
   * and the thing that just walked the tree already knows.
   *
   * A summary EO cannot read is a failure, and deliberately so. It means
   * this is a version EO has not been taught, and reporting a sync as
   * successful on the strength of an exit code is the trust invariant #5
   * exists to withhold.
   */
  async function sync(target: RepositoryIndexTarget): Promise<RepositoryIndexBuild> {
    const refused = unusableTarget(target);
    if (refused) return refused;

    const started = now();
    const { value: result, escape } = await contained(target, (env) => invoke(target, ["sync"], env));
    // Measured around the command alone: the verification that follows
    // is EO checking its own work, and charging it to the sync would
    // make every recorded handover cost more than it did.
    const durationMs = now() - started;

    if (escape !== null) return { ok: false, reason: escape };
    if (!result.ok) return { ok: false, reason: refusal("update", result) };

    const report = readSyncReport(result.stdout);
    if (report === null) {
      return {
        ok: false,
        reason: `EO could not read what CodeWiki's sync did to the index at ${indexPathFor(target)}: ${explainOutput(result.stdout, result.stderr)}`,
      };
    }

    return confirm(target, { durationMs, changedFileCount: report.changedFileCount });
  }

  /** Builds one if there is none, updates one if there is. The call for a caller that does not care which. */
  async function ensureReady(target: RepositoryIndexTarget): Promise<RepositoryIndexBuild> {
    return (await verify(target)).present ? sync(target) : initialize(target);
  }

  /**
   * Throws the index away and builds it again.
   *
   * Everything it deletes is derived: `.codewiki/` and nothing else, in
   * a checkout the tool is about to walk again from source. Source
   * files, history, the working tree's own state, and everything EO
   * keeps in its database are none of this method's business — the only
   * path it names is the one it built out of the index directory's own
   * name.
   */
  async function rebuild(target: RepositoryIndexTarget): Promise<RepositoryIndexBuild> {
    const removed = await remove(target);
    if (!removed.ok) return { ok: false, reason: removed.reason };
    return initialize(target);
  }

  /**
   * Deletes the index from disk.
   *
   * Idempotent: a target with no index is removed successfully, because
   * what the caller asked for — that there be no index here — is true
   * when it returns. Called when a worktree goes and when a row is being
   * forgotten, and in both cases the alternative to succeeding quietly
   * is a failure nobody can act on.
   */
  async function remove(target: RepositoryIndexTarget): Promise<RepositoryIndexRemoval> {
    const refused = unusableTarget(target);
    if (refused) return { ok: false, reason: refused.reason };

    const indexPath = indexPathFor(target);
    try {
      rmSync(indexPath, { recursive: true, force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `EO could not delete the repository index at ${indexPath}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * A path the index answered with, as a path inside this checkout — or
   * null when it is not one (EO-173).
   *
   * Three things at once, and each of them is a way of not making a
   * suggestion:
   *
   * **It relativises.** The port promises checkout-relative paths, and
   * the caller compares them against the directories an agent named on
   * its command line. An absolute path would never match `apps`.
   *
   * **It drops what is not in this checkout.** The pinned CodeWiki
   * stores absolute paths — `isolation.test.ts` asserts that limitation
   * deliberately — so an index restored from elsewhere answers with
   * another root's paths. Those describe files this agent is not looking
   * at, and the honest thing to do with them is say nothing.
   *
   * **It drops the index's own directory.** `.codewiki/` is inside the
   * checkout and CodeWiki indexes some of what it writes there. A search
   * whose only answer is a file EO generated is a search the index
   * cannot help with, and suggesting otherwise would be the exact
   * failure this story is about.
   */
  function insideCheckout(target: RepositoryIndexTarget, path: string): string | null {
    const root = target.workspacePath.replace(/[\\/]+$/, "");
    if (root === "") return null;
    if (!path.startsWith(`${root}/`) && !path.startsWith(`${root}\\`)) return null;
    const relative = path.slice(root.length + 1).replace(/\\/g, "/").replace(/^\/+/, "");
    if (relative === "") return null;
    if (relative === CODEWIKI_INDEX_DIRECTORY || relative.startsWith(`${CODEWIKI_INDEX_DIRECTORY}/`)) return null;
    return relative;
  }

  /**
   * What the index holds that a broad search was about to look for
   * (EO-173).
   *
   * **Two questions, two subcommands.** A name goes to `query`, which
   * matches loosely and is asked for enough results that an exact match
   * is among them; a filename pattern goes to `files`, which lists what
   * the index holds and leaves the matching to `fileMatch.ts` because
   * the pinned version has no glob query. Neither is a shape the port
   * knows about, which is the arrangement every other method here has.
   *
   * **Every failure is the empty answer.** No binary, a non-zero exit, a
   * timeout, a cancelled run, output EO cannot read, a runner that threw
   * where it promised not to. The caller turns all of them into silence,
   * and that is the correct reading of every one: EO does not know that
   * the index can help, so it does not say that it can. None of this is
   * a judgement about whether repository intelligence is *available* —
   * that was settled before this server was handed over, and re-deciding
   * it here would make this the second place that answers a question
   * which is only allowed one.
   */
  async function askIndex(target: RepositoryIndexTarget, question: RepositoryIndexQuestion): Promise<RepositoryIndexHit[]> {
    if (unusableTarget(target)) return [];
    const args = question.of === "symbol" ? ["query", question.name, "--limit", String(LOOKUP_LIMIT)] : ["files"];

    let result: CodeWikiRunResult;
    try {
      result = await run({
        args: [...args, "--path", target.workspacePath],
        cwd: target.workspacePath,
        binary: deps.binary,
        // A caller-supplied ceiling can lower this and never raise it.
        // `deps.timeoutMs` is there for indexing, where minutes are
        // normal; a hook holding up a tool call cannot inherit that.
        timeoutMs: Math.min(deps.timeoutMs ?? LOOKUP_TIMEOUT_MS, LOOKUP_TIMEOUT_MS),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
    } catch {
      return [];
    }
    if (!result.ok) return [];

    const listing = question.of === "symbol" ? readSymbolListing(result.stdout) : readFileListing(result.stdout);
    if (listing === null) return [];

    const held: RepositoryIndexHit[] = [];
    for (const entry of listing) {
      const path = insideCheckout(target, entry.path);
      if (path === null) continue;
      if (question.of === "file") {
        if (!matchesFilePattern(path, question.pattern)) continue;
        // A file is held under its path, and its path is the only name
        // there is to compare a pattern against.
        held.push({ name: path, path });
        continue;
      }
      held.push({ name: entry.name, path });
    }
    return held;
  }

  /**
   * How an agent dispatched against this checkout queries the index, or
   * null when it cannot.
   *
   * `--no-watch` because EO is the only thing that writes to this index:
   * syncs happen at handovers EO chooses, and a file watcher would put a
   * second writer behind the agent's own queries. Null when there is no
   * binary or no index — an ordinary answer, and every caller handles it
   * by dispatching an agent with the tools it had before this feature
   * existed.
   */
  async function getAgentMcpConfig(target: RepositoryIndexTarget): Promise<RepositoryIndexQueryServer | null> {
    if (unusableTarget(target)) return null;
    const executable = codeWikiExecutable(deps.binary);
    if (executable.path === null) return null;
    if (!existsSync(indexDatabaseFor(target))) return null;

    return {
      name: REPOSITORY_QUERY_SERVER_NAME,
      command: executable.path,
      args: ["serve", "--mcp", "--path", target.workspacePath, "--no-watch"],
      env: {},
      answers: CODEWIKI_ANSWERS,
      // Bound to the target this server was fetched for, so the
      // interception cannot end up asking one checkout's index about
      // another checkout's search.
      knows: (question) => askIndex(target, question),
    };
  }

  return {
    id: CODEWIKI_PROVIDER_ID,
    initialize,
    sync,
    getStatus,
    ensureReady,
    getAgentMcpConfig,
    rebuild,
    remove,
  };
}
