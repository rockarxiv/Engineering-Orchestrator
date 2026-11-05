import { branchNameFor, worktreePathFor, type WorktreeConfig } from "./worktrees.js";
import { git, statusPorcelain } from "./git.js";
import { withoutRepositoryIndex } from "../repositoryIntelligence/index.js";
import { runCommand } from "../../../process/runCommand.js";

/** Long enough for a real suite, short enough that a hang doesn't wedge EO for the afternoon. */
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

export interface VerificationStep {
  name: string;
  ok: boolean;
  /** One line a human can read without opening the logs. */
  detail: string;
  output?: string;
  timedOut?: boolean;
}

export interface VerificationResult {
  ok: boolean;
  steps: VerificationStep[];
  /** The step that failed, if any — what the engine comment leads with. */
  failedStep?: string;
}

export interface CheckCommands {
  test?: string | null;
  lint?: string | null;
  build?: string | null;
}

export interface VerifyOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  /**
   * What the rebase-before-review step rebases onto — `config.baseBranch`
   * by default. The caller (`implementationVerifier.ts`) resolves this
   * fresh on every call, per EO-10 / KAN-42: a story stacked on a
   * still-unmerged same-feature dependency rebases onto *that* branch
   * instead, and the moment the dependency merges, back onto the base
   * branch — never the value from whenever the worktree was first cut.
   *
   * A *ref*, not a branch name: the caller resolves it on the remote
   * (`origin/main`, or a dependency's pushed tip), so review meets what
   * actually landed rather than whatever the human's local branch of that
   * name happens to point at.
   */
  rebaseTarget?: string;
  /**
   * What "has commits beyond the base" is measured against —
   * `config.baseBranch` by default, and the remote-resolved ref for it
   * when the caller has one. Separate from `rebaseTarget` because a
   * stacked story rebases onto its dependency while still being judged
   * against the base branch.
   */
  baseRef?: string;
  /**
   * The item's actual branch. The caller (`implementationVerifier.ts`)
   * always passes the item's stored `branch` here once it has one —
   * never recomputed from the item's current prefix/jiraKey, which
   * could have changed since the branch was actually cut (EO-16: no
   * rename on a later prefix change or Jira link). Defaults to
   * `branchNameFor(itemKey)` only for an item that has no stored
   * branch yet, which should not happen for anything reaching
   * verification but is a safe fallback rather than a thrown error.
   */
  branch?: string;
  /**
   * How `baseRef` is named in what the step list says, when the ref
   * itself would mean nothing to a reader — a bare commit, for a branch
   * a person named (EO-365). Defaults to the ref.
   */
  baseLabel?: string;
  /**
   * Skip the rebase, saying this instead (EO-365). Set for a branch a
   * person named, which EO never rewrites: rebasing it here would
   * rewrite their history in the worktree, and the next push would
   * either fail or need the force EO never uses.
   */
  noRebase?: string;
}

function fail(steps: VerificationStep[], step: VerificationStep): VerificationResult {
  steps.push(step);
  return { ok: false, steps, failedStep: step.name };
}

/**
 * Mechanically verifies what an implementer claims, before the item is
 * allowed to move to review (the original design: "never accept 'I'm
 * done' from the implementer; check the branch and run the tests
 * yourself").
 *
 * Stops at the first failing step. Each one is a precondition for the
 * next — there's no point rebasing a branch with no commits, and no
 * point running a suite against a tree that failed to rebase — and a
 * single clear cause is more useful to the agent's next attempt than a
 * cascade of derived failures.
 */
export async function verifyImplementation(
  config: WorktreeConfig,
  itemKey: string,
  commands: CheckCommands,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const rebaseTarget = options.rebaseTarget ?? config.baseBranch;
  const baseRef = options.baseRef ?? config.baseBranch;
  const baseLabel = options.baseLabel ?? baseRef;
  const branch = options.branch ?? branchNameFor(itemKey);
  const worktreePath = worktreePathFor(itemKey, config.worktreeRoot);
  const steps: VerificationStep[] = [];

  // 1. The branch exists and actually contains work.
  const revList = await git(["rev-list", "--count", `${baseRef}..${branch}`], config.repoPath);
  if (!revList.ok) {
    return fail(steps, { name: "branch", ok: false, detail: `Branch "${branch}" could not be inspected: ${revList.error}` });
  }
  const commitCount = Number.parseInt(revList.stdout, 10);
  if (!Number.isFinite(commitCount) || commitCount === 0) {
    return fail(steps, {
      name: "branch",
      ok: false,
      detail: `Branch "${branch}" has no commits beyond ${baseLabel}. The run reported success, but nothing was committed.`,
    });
  }
  steps.push({ name: "branch", ok: true, detail: `${commitCount} commit(s) on ${branch} beyond ${baseLabel}.` });

  // 2. Nothing left uncommitted — half-committed work would pass the
  //    checks below and then vanish when the worktree is released.
  const status = await statusPorcelain(worktreePath);
  if (!status.ok) {
    return fail(steps, { name: "clean", ok: false, detail: `Could not read the worktree status: ${status.error}` });
  }
  // The generated repository index sits in the worktree and is EO's own
  // output, not the run's work — `repositoryIndex.ts` says why it is
  // stepped over here rather than excluded inside somebody's repository.
  // Everything else still counts, and the output attached below names
  // only what actually needs committing.
  const uncommitted = withoutRepositoryIndex(status.stdout);
  if (uncommitted !== "") {
    return fail(steps, {
      name: "clean",
      ok: false,
      detail: "The worktree has uncommitted changes. Everything the run produced must be committed.",
      output: uncommitted,
    });
  }
  steps.push({ name: "clean", ok: true, detail: "Worktree is clean." });

  // 3. Rebase onto the current target — the repository's base branch, or a
  //    still-unmerged same-feature dependency's branch when this story is
  //    stacked on one (EO-10 / KAN-42). This is where a branch that was
  //    fine in isolation meets what landed while it was being written.
  //    Never a branch a person named (EO-365), which is said instead.
  const rebase = options.noRebase !== undefined ? ({ ok: true, stdout: "" } as const) : await git(["rebase", rebaseTarget], worktreePath);
  if (!rebase.ok) {
    const conflicts = await git(["diff", "--name-only", "--diff-filter=U"], worktreePath);
    const paths = conflicts.ok && conflicts.stdout !== "" ? conflicts.stdout.split("\n") : [];
    // Leave the worktree usable for the next attempt rather than parked
    // mid-rebase, which would fail every subsequent git command.
    await git(["rebase", "--abort"], worktreePath);
    return fail(steps, {
      name: "rebase",
      ok: false,
      detail:
        paths.length > 0
          ? `Rebase onto ${rebaseTarget} hit conflicts in ${paths.length} file(s): ${paths.join(", ")}`
          : `Rebase onto ${rebaseTarget} failed.`,
      output: paths.length > 0 ? paths.join("\n") : rebase.error,
    });
  }
  steps.push({ name: "rebase", ok: true, detail: options.noRebase ?? `Rebased cleanly onto ${rebaseTarget}.` });

  // 4. The configured checks. An unconfigured command is skipped rather
  //    than treated as passing — nothing was proven either way, and the
  //    step list says so.
  for (const name of ["test", "lint", "build"] as const) {
    const command = commands[name];
    if (!command) {
      steps.push({ name, ok: true, detail: `No ${name} command configured — skipped.` });
      continue;
    }

    const outcome = await runCommand(command, { cwd: worktreePath, timeoutMs, maxOutputChars });
    if (!outcome.ok) {
      return fail(steps, {
        name,
        ok: false,
        detail: outcome.timedOut
          ? `\`${command}\` was killed after ${timeoutMs}ms without finishing.`
          : `\`${command}\` exited with code ${outcome.exitCode}.`,
        output: outcome.output,
        ...(outcome.timedOut ? { timedOut: true } : {}),
      });
    }
    steps.push({ name, ok: true, detail: `\`${command}\` passed.` });
  }

  return { ok: true, steps };
}

/** Renders a result as the body of the engine's comment (ARCHITECTURE.md, "One channel") — the failing step first, then its output. */
export function formatVerificationComment(itemKey: string, result: VerificationResult): string {
  const failed = result.steps.find((step) => !step.ok);
  const lines = [
    `Verification failed for ${itemKey}, so it did not move to review.`,
    "",
    `**${failed?.name ?? "unknown"}** — ${failed?.detail ?? "no detail"}`,
  ];

  if (failed?.output) {
    lines.push("", "```", failed.output, "```");
  }

  const passed = result.steps.filter((step) => step.ok).map((step) => step.name);
  if (passed.length > 0) {
    lines.push("", `Passed before this: ${passed.join(", ")}.`);
  }

  return lines.join("\n");
}
