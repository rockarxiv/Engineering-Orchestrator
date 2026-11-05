import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GIT_WORKTREE_KIND, type Agent, type Item } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { getGitWorkspace, stepForItem } from "../../../db/repos/index.js";
import { emitPush } from "../../../ipc/push.js";
import { verifier } from "../../../supervisor/workspaceKind.js";
import type { Artifact, Check, PreparedWorkspace, ReferenceCheckoutRequest, VerifiableRun, WorkspaceAttachment, WorkspaceKind, ReleaseRequest } from "../../../supervisor/workspaceKind.js";
import { workspaceFor } from "../../../supervisor/workspaceResolution.js";
import {
  repositoryQueryServerFor,
  syncRepositoryIndexAtHandover,
  type RepositoryIntelligenceFactory,
} from "../repositoryIntelligence/index.js";
import { borrowedFromSiblings } from "./borrowed.js";
import { createWorktreeWorkspace, forgetIndexesForReleasedWorktrees, releaseStaleWorktrees, releaseWorktreeFor } from "./dispatchWorkspace.js";
import { git, statusPorcelain } from "./git.js";
import { referenceCheckoutFor, releaseReferenceCheckouts, releaseStaleReferenceCheckouts } from "./referenceCheckouts.js";
import { createImplementationVerifier, createVerifiedRange } from "./implementationVerifier.js";
import type { VerificationResult, VerifyOptions } from "./verify.js";

/** What the git kind needs from the process in order to be built. */
export interface GitWorkspaceKindOptions {
  db: Db;
  /** Where item worktrees are cut. `~/.eo/worktrees` when nobody says. */
  worktreeRoot?: string;
  /**
   * How a repository index is resolved (EO-149).
   *
   * One spelling, shared with the builtin that builds an index: the
   * step that builds one, the dispatch that hands one to an agent and
   * the sync at handover must not be able to disagree about which index
   * exists.
   */
  intelligenceFor: RepositoryIntelligenceFactory;
  /** The wrapper that bounds a delivered MCP server's life by the backend that started it (EO-151). */
  mcpServerSupervisorPath?: string;
  /**
   * How long the implementation check's commands may take, and how much
   * of their output is kept.
   *
   * A seam for a test that cannot wait ten minutes to watch a hung
   * command fail. The app passes nothing and gets `verify.ts`'s own
   * defaults, which are sized for a real suite.
   */
  verifyOptions?: VerifyOptions;
  /**
   * How the working tree's state is read, for the plan-mode check.
   *
   * A seam of the same kind `createWorktreeWorkspace` takes a `CliRunner`
   * for: what the check *decides* given a dirty tree is worth testing
   * without building one.
   */
  readStatus?: typeof statusPorcelain;
  /**
   * Whether a directory is inside a Git repository, for the question
   * asked before every turn (EO-386).
   *
   * The same kind of seam as `readStatus`, for a test whose worktree is
   * a path that names one without one existing. The app passes nothing
   * and the disk is read.
   */
  isGitRepository?: (cwd: string) => boolean;
}

/**
 * A repository EO drives, as a workspace kind (EO-295,
 * ARCHITECTURE.md, "The four kinds", "The interface").
 *
 * Nothing below is new behaviour. Every method wraps functions this
 * directory already had — the ones that were eight options on the run
 * supervisor, each typed on a worktree path — and the whole of the
 * change is that they are now five methods on a value the supervisor
 * looks up by the slug an item's workspace row names. A dispatch on a
 * workspace of any other kind never reaches any of this.
 *
 * Two modes, not two kinds (EO-296, ARCHITECTURE.md, "The four kinds"). **Isolated** is a branch
 * cut
 * per item, a worktree of its own, verification against that tree.
 * **Read** is the repository's own checkout handed over as it stands,
 * which Discussions, the assistant and a container item have always
 * worked in; `prepare` is where the two part company, and everything
 * else here is written for either. A person attached one repository and
 * thinks of it as one repository, so it is one kind with a segmented
 * control on the step rather than two entries in a picker.
 */
export function gitWorkspaceKind(options: GitWorkspaceKindOptions): WorkspaceKind {
  const { db, worktreeRoot, intelligenceFor } = options;
  const insideRepository = options.isGitRepository ?? isInsideGitRepository;
  const verifyImplementation = createImplementationVerifier(db, worktreeRoot, options.verifyOptions ?? {});
  const verifiedRange = createVerifiedRange(db, worktreeRoot);

  return {
    slug: GIT_WORKTREE_KIND,

    /**
     * `~/.eo/worktrees/<KEY>` on `eo/<KEY>`, cut from the right start
     * point and recorded on the item (G-01).
     *
     * A refusal here — a dirty base repository, a clashing branch, a
     * dependency whose stack target EO will not guess at — escalates
     * before any agent starts, which is the whole reason preparation
     * happens ahead of the run row.
     */
    prepare: createWorktreeWorkspace(db, worktreeRoot),

    /**
     * The repository index, and what keeps it describing the code the
     * next agent will read (EO-151, EO-153).
     *
     * Three supervisor hooks until this story: the query server, the
     * sentence to post when there is none, and the sync at handover.
     * They were always one thing — what this checkout lends the agent
     * working in it — and the gate is inside the factory, so with the
     * feature off this resolves no binary, reads no row and posts no
     * comment.
     *
     * The server is deliberately not part of what a provider is cached
     * on: a provider is cached per agent and this is per item, so it
     * rides on the turn.
     */
    async attach(item: Item, agent: Agent, workspace: PreparedWorkspace): Promise<WorkspaceAttachment> {
      const delivery = await repositoryQueryServerFor(intelligenceFor, {
        db,
        item,
        worktreePath: workspace.cwd,
        agentName: agent.name,
        // EO's own answer to "no orphan survives" (EO-151). Without it a
        // delivered server outlives its backend whenever that backend
        // was killed rather than asked to stop, which is what a cancel
        // and the wall-clock guard both do.
        ...(options.mcpServerSupervisorPath ? { superviseWith: options.mcpServerSupervisorPath } : {}),
      });
      return {
        mcpServers: delivery.server === null ? [] : [delivery.server],
        // Not this kind's to lend, and deliberately: the worktree skills
        // a Codex agent reads are written into the checkout by the
        // adapter at spawn, out of the agent's own attachments (EO-207).
        skills: [],
        notices: delivery.notice === null ? [] : [delivery.notice],
        sync: (signal) => syncRepositoryIndexAtHandover(intelligenceFor, { db, item, worktreePath: workspace.cwd, agentName: agent.name, signal }),
      };
    },

    /**
     * What a branch can be asked for itself, against the one action a
     * branch can answer for.
     *
     * `implement` and nothing else. That is the transition the design
     * identifies as the one the engine can check for itself — a branch,
     * commits, a rebase, a test suite are observable facts. `refine`
     * produces stories the engine cannot invent or judge and `review` is
     * the reviewer's own opinion, so claiming to verify either would be
     * theatre. Until EO-297 that was `if (run.action !== "implement")` at
     * the top of one method and again at the top of the verifier beneath
     * it; it is a key in a table now, which is the same decision said
     * once and said where something other than this function can read it.
     */
    verifiers: {
      /**
       * Three checks: the mechanical verification of the implementation
       * (G-02), whether the tree was left alone by a run that was asked
       * only to propose (KAN-18), and whether any file on the branch was
       * copied out of another item's unmerged work (KAN-27). Three hooks
       * until EO-295, fired at three different moments and in three
       * different voices.
       *
       * The phrases are what a column head says (EO-312): one per thing
       * looked at, in the order they are looked at, so "EO checks:
       * commits, tests ran, the tree is clean, nothing borrowed from
       * another ticket" is a true account of this function rather than a
       * slogan about it. "tests ran" covers the configured test, lint
       * and build commands, and an installation that configured none has
       * a head saying more than it should — which is the argument for
       * naming what is checked here rather than what was found.
       */
      implement: verifier(["commits", "tests ran", "the tree is clean", "nothing borrowed from another ticket"], async (item: Item, run: VerifiableRun): Promise<readonly Check[]> => {
        // An `implement` the dispatched role defined for itself is not
        // the action this entry vouches for (EO-422). It answered in the
        // role's own shape and promised no commits, so holding it to a
        // branch would fail work for not being something it never
        // claimed to be — and plan mode, which the clean-tree check
        // below polices, was never asked of it.
        if (run.packAction === false) return [];

        // A run that stopped to ask has claimed nothing, so there is
        // nothing to verify — but plan mode's whole bargain is that the
        // proposal came *instead of* the work, and a prompt is a request
        // rather than a constraint (KAN-18).
        if (run.ended === "escalated") {
          const check = await cleanTreeCheck(db, item, run.workspace, options.readStatus ?? statusPorcelain);
          return check === null ? [] : [check];
        }

        const verified = await verifyImplementation(item);
        const implementation: Check = verified.ok
          ? { key: "implementation", passed: true, blocks: true, describes: describeVerified(verified.verification), ...evidence(verified.verification) }
          : {
              key: "implementation",
              passed: false,
              blocks: true,
              describes: verified.reason,
              ...(verified.comment ? { comment: verified.comment } : {}),
              ...evidence(verified.verification),
            };
        // Stopped at the first failing check, for the reason
        // `verifyImplementation` stops at its own first failing step: a
        // tree that failed verification is not a tree worth reporting
        // borrowed files from, and the supervisor did not run either
        // report on a failed run before this story either.
        if (!implementation.passed) return [implementation];

        const checks: Check[] = [implementation];
        // Read off the verification rather than asked of git a second
        // time: "nothing left uncommitted" is one of the steps it just
        // ran, and a branch that passed it is clean by the same evidence.
        const clean = verified.verification?.steps.find((step) => step.name === "clean");
        if (clean) checks.push({ key: "clean-tree", passed: true, describes: `Nothing was left uncommitted in ${item.key}'s worktree.` });
        checks.push(await borrowedCheck(db, item, run.workspace, worktreeRoot));
        return checks;
      }),
    },

    /**
     * A finished item lets go of its checkout without waiting for a
     * relaunch (G-03), and the sweep collects what nothing is working in
     * any more (E-04).
     *
     * The branch is untouched either way — that is the deliverable — and
     * a worktree with uncommitted work in it is kept and said out loud
     * rather than removed.
     */
    async release(request: ReleaseRequest) {
      // A branch is the deliverable and a worktree holds it, so nothing
      // here is EO's to throw away because a run's output was copied
      // out (EO-299). Said explicitly rather than left to fall through
      // to the sweep below, which is what an unhandled third kind of
      // request would have done.
      if (request.what === "collected") return {};

      if (request.what === "settled") {
        const outcome = await releaseWorktreeFor(db, request.item, worktreeRoot);
        if (outcome.released) {
          console.log(`[eo] released the worktree for ${request.item.key}`);
          emitPush("config:changed", {}); // an open settings screen would otherwise still list it
        }
        return "reason" in outcome ? { keptReason: outcome.reason } : {};
      }

      const { removed, keptWithChanges, removalFailed } = await releaseStaleWorktrees(db, request.hasActiveRun, worktreeRoot);
      if (removed.length > 0) console.log(`[eo] released stale worktrees: ${removed.join(", ")}`);
      if (keptWithChanges.length > 0) console.log(`[eo] kept worktrees with uncommitted work: ${keptWithChanges.join(", ")}`);
      // Said apart from the line above, and in different words: these
      // hold no unsaved work as far as anyone knows — they are
      // checkouts EO could not get rid of, still on disk, and the
      // reason names what to do about it (issue #131).
      for (const failed of removalFailed) console.error(`[eo] could not release the worktree for ${failed.itemKey}, and it is still on disk: ${failed.reason}`);

      // And the records for checkouts that are already gone (EO-174).
      // A release forgets its own record now, so this is here for the
      // ones released before it did — and for a worktree somebody
      // removed by hand while EO was not running. After the releases
      // above, so a tree freed on this pass is judged by what is on
      // disk now rather than by what was there when the app started.
      // Reference checkouts of finished and deleted items (EO-632). Not
      // the item folder's business: they live in each repository's git
      // directory, so the worktree sweep above never sees them.
      const references = await releaseStaleReferenceCheckouts(db);
      if (references.length > 0) console.log(`[eo] removed reference checkouts: ${references.join(", ")}`);

      const forgotten = forgetIndexesForReleasedWorktrees(db, worktreeRoot);
      if (forgotten.length > 0) {
        console.log(`[eo] forgot index records for released worktrees: ${forgotten.join(", ")}`);
        emitPush("config:changed", {}); // the settings screen lists these, and reconciliation can run under an open one
      }
      return {};
    },

    /**
     * What the run produced: the diff of the branch over the range the
     * implementation check measured (EO-298).
     *
     * Three dots rather than two, which is the difference between "what
     * this ticket did" and "what this ticket did plus everything the
     * base branch has done since" — the second is not this run's work
     * and would be unreadable on a base that has moved.
     *
     * Only `implement`, which is the same action `verifiers` above has
     * an entry for and the same judgement behind it. Asked inside the
     * method rather than declared as a table, because unlike a check
     * there is nothing here for a *caller* to read off: EO-297 made the
     * verifiers a table so that the supervisor could ask "does this kind
     * vouch for this action at all" before reading a route for a branch
     * that could never be taken, and nothing asks that question of an
     * artifact. If something ever does, this is the line it becomes a
     * table for.
     *
     * A reviewer's run works in the same worktree on the same branch, so
     * asking git what that branch did would answer with the
     * implementer's diff a second time — and posting it would supersede
     * the implementer's output with a copy of itself, over a review
     * whose product is an opinion rather than a change. `refine` and the
     * conversational actions produce nothing on disk at all.
     *
     * The supervisor posts what this returns as the item's output, which
     * is what puts the change in front of the reviewer as a thing on the
     * ticket rather than as something it has to go and derive.
     */
    async artifacts(item: Item, run: VerifiableRun): Promise<readonly Artifact[]> {
      // `packAction` for the verifier's reason (EO-422): a role's own
      // `implement` was not checked against the branch, and the diff is
      // the output of the action that was.
      if (run.action !== "implement" || run.packAction === false || run.workspace.workspaceId === null) return [];
      const workspace = getGitWorkspace(db, run.workspace.workspaceId);
      const range = await verifiedRange(item);
      if (!workspace || range === null) return [];

      const diff = await git(["diff", `${range.from}...${range.to}`], workspace.config.repoPath);
      if (!diff.ok || diff.stdout === "") return [];
      return [{ kind: "diff", name: `${item.key}.diff`, mediaType: "text/x-diff", body: diff.stdout }];
    },

    /**
     * The checkout, in either mode (EO-296, ARCHITECTURE.md, "Capacity and concurrency").
     *
     * One checkout, one index, one set of refs: that is what two
     * concurrent runs would collide in, and it is the workspace rather
     * than the item. Read mode answers the same way even though nothing
     * it does can conflict — the runs share a *tree*, and a cap keyed on
     * a shared filesystem that quietly excused the readers would be a
     * cap that does not mean what its name says.
     *
     * The *resolved* workspace, so an item with none of its own is in
     * the bucket of the checkout it actually reads rather than in no
     * bucket. That resolution used to be the empty-string bucket every
     * item with no repository shared, on the grounds that they all ran
     * in the same process directory. Nothing runs there any more.
     *
     * The row rather than the whole resolution, deliberately: this is
     * asked for every item on every tick, and which bucket a run is in
     * does not depend on how the workspace is used.
     */
    capacityKeyOf(item: Item): string | null {
      return workspaceFor(db, item)?.id ?? null;
    },

    /**
     * A turn on a repository runs inside one, in either mode (EO-386).
     *
     * `prepare` hands over a worktree it cut or the repository's own
     * checkout, so this only ever refuses when something has gone wrong
     * between then and now: a worktree removed by hand while its run was
     * parked, a repository moved after it was attached, a run row whose
     * directory is not the one this item's checkout is in. Each of those
     * is an agent about to be let loose in some other directory, and
     * which backend it runs on has nothing to do with whether that is
     * acceptable.
     */
    refusesTurn(item: Item, workspace: PreparedWorkspace): string | null {
      if (insideRepository(workspace.cwd)) return null;
      return (
        `${item.key} works in a Git repository, and the directory this turn was to run in is not inside one: ` +
        `\`${workspace.cwd}\`. Nothing was started there. Check that the repository attached to this ticket's project ` +
        `is still where EO expects it and that the ticket's worktree has not been removed, then reply to retry.`
      );
    },

    /**
     * A detached checkout of a branch of any repository on the item's
     * project, its own included (EO-632). `referenceCheckouts.ts` says
     * where it lives and why it is detached.
     */
    referenceCheckout(item: Item, request: ReferenceCheckoutRequest) {
      return referenceCheckoutFor(db, item, request);
    },

    /** Removes them when the item settles, saying on it what was written to any (EO-632). */
    async releaseReferenceCheckouts(item: Item) {
      await releaseReferenceCheckouts(db, item);
    },
  };
}

/**
 * Is this directory inside a Git repository?
 *
 * Read the way `codex exec` read it, since that is the check this
 * replaces: a `.git` entry — a directory, or the file a linked worktree
 * has — in the directory or in any parent. No `git` process, because
 * this is asked before every turn.
 */
export function isInsideGitRepository(cwd: string): boolean {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) return true;
    if (dirname(directory) === directory) return false;
  }
}

/** The verification result, where there is one, as the evidence a check carries onto the run row. */
function evidence(verification: VerificationResult | undefined): { evidence?: Record<string, unknown> } {
  return verification === undefined ? {} : { evidence: verification as unknown as Record<string, unknown> };
}

/** One sentence for a verification that passed, naming the steps it actually ran. */
function describeVerified(verification: VerificationResult | undefined): string {
  if (verification === undefined) return "Nothing was checked: this ticket has no repository to check against.";
  return `Checked the branch — ${verification.steps.map((step) => step.name).join(", ")} — and every step passed.`;
}

/**
 * Was a run that was asked to propose left without writing anything
 * (KAN-18)?
 *
 * Null when the question does not arise: outside plan mode nobody asked
 * the implementer to hold off, and an item on no project has no step to
 * read the setting from. An unreadable status is not evidence of a
 * violation, so it passes.
 *
 * It reports rather than reverts. Throwing the work away would be a
 * second surprise on top of the first, and the person reading the plan
 * is the one who should decide.
 */
async function cleanTreeCheck(db: Db, item: Item, workspace: PreparedWorkspace, readStatus: typeof statusPorcelain): Promise<Check | null> {
  if (item.projectId === null || item.stepId === null || !stepForItem(db, item)?.planMode) return null;

  const status = await readStatus(workspace.cwd);
  if (!status.ok || status.stdout === "") {
    return { key: "clean-tree", passed: true, describes: `${item.key}'s worktree was left alone, which is what plan mode asked for.` };
  }
  return {
    key: "clean-tree",
    passed: false,
    describes: `This run was asked to propose without changing anything, and ${item.key}'s worktree is not clean.`,
    comment:
      `This project is in plan mode, so this run was asked to propose without changing anything — but its worktree is not clean.\n\n` +
      `Uncommitted changes in the worktree:\n\n\`\`\`\n${status.stdout.trim()}\n\`\`\`\n\n` +
      `Nothing has been discarded. Read the plan above with this in mind: what is described may not be all that was done.`,
  };
}

/**
 * Did this story copy another item's unmerged work (KAN-27)?
 *
 * The worktree is where an implementer is pointed, not a fence it is
 * held behind — it can read every other item's checkout, and a real run
 * showed it will: one story vendored a file verbatim out of a sibling's
 * unmerged branch, cited the commit, and passed review.
 *
 * Reports rather than blocks, like every other check here that is not
 * the verification itself. Copying can be the right answer — two
 * repositories with no registry between them leave few options — but it
 * should never be discovered later. What makes it worth saying is *what*
 * was copied from: work nobody has approved, which can still change or
 * be dropped entirely.
 */
async function borrowedCheck(db: Db, item: Item, prepared: PreparedWorkspace, worktreeRoot?: string): Promise<Check> {
  const workspace = prepared.workspaceId === null ? undefined : getGitWorkspace(db, prepared.workspaceId);
  if (!workspace) return borrowedFilesCheck([]);
  return borrowedFilesCheck(
    await borrowedFromSiblings({
      worktreePath: prepared.cwd,
      itemKey: item.key,
      baseBranch: workspace.config.baseBranch,
      ...(worktreeRoot ? { worktreeRoot } : {}),
    }),
  );
}

/**
 * The sentence, apart from the scan that finds the files.
 *
 * Split so that what a person reads can be tested without a worktree to
 * copy out of, and so that `borrowed.ts` — which decides what counts as
 * borrowed — stays the one place that knows how to look.
 */
export function borrowedFilesCheck(borrowed: readonly { path: string; fromItemKey: string }[]): Check {
  if (borrowed.length === 0) {
    return { key: "borrowed-files", passed: true, describes: "No file on this branch is byte-identical to another ticket's unmerged work." };
  }

  const sources = [...new Set(borrowed.map((file) => file.fromItemKey))];
  return {
    key: "borrowed-files",
    passed: false,
    describes:
      `${borrowed.length === 1 ? "A file" : `${borrowed.length} files`} on this branch ` +
      `${borrowed.length === 1 ? "is" : "are"} byte-identical to ${sources.join(", ")}'s unmerged work.`,
    comment:
      `${borrowed.length === 1 ? "A file" : `${borrowed.length} files`} on this branch ` +
      `${borrowed.length === 1 ? "is" : "are"} byte-identical to ${sources.join(", ")}'s working copy:\n` +
      `${borrowed.map((file) => `- ${file.path} (from ${file.fromItemKey})`).join("\n")}\n\n` +
      `That work is not merged and may still change or be dropped. Copying across repositories is sometimes the only option — ` +
      `but if this outlives what it was copied from, it is now the only copy, and nobody decided that.`,
  };
}
