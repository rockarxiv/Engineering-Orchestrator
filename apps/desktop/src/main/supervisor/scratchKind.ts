import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { SCRATCH_KIND, type Item } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItemByKey, resumableRunCwds } from "../db/repos/index.js";
import { workspaceFor } from "./workspaceResolution.js";
import { fileArtifacts, filesUnder } from "./workspaceFiles.js";
import { NOTHING_ATTACHED, type Artifact, type PrepareWorkspaceOutcome, type ReleaseRequest, type VerifiableRun, type WorkspaceKind } from "./workspaceKind.js";

/** Where the per-run directories live. `~/.eo/scratch`, beside the worktrees and the empty directories, for the same reason they are not in the repository. */
export function defaultScratchRoot(): string {
  return join(homedir(), ".eo", "scratch");
}

/** What the scratch kind needs from the process: the run rows, so that a sweep never removes a directory a person can still reply into. */
export interface ScratchWorkspaceKindOptions {
  db: Db;
  /** Where the directories are made. The default is `~/.eo/scratch`; a test passes its own. */
  root?: string;
}

/**
 * A directory per run, and nothing afterwards (EO-299,
 * ARCHITECTURE.md, "The four kinds").
 *
 * Somewhere to work when the work itself is the answer: a report
 * drafted from what the agent was told, a chart rendered to be looked
 * at, a spreadsheet built from a query. What the run produced becomes
 * the item's output, and the directory it was produced in is not a
 * place anybody should have to know about afterwards.
 *
 * Three properties, and each is the opposite of the git kind's:
 *
 * - **Per run, not per item.** Two runs never inherit each other's
 *   mess, which is what makes the null capacity key below honest.
 * - **Nothing is verified.** There is no declared output and no branch
 *   to count commits on. What a scratch run claims is judged by
 *   whoever reads its output, and EO says so rather than implying it
 *   checked something.
 * - **Everything in it is the output.** A folder is somebody's shared
 *   drive and only what *changed* there is this run's doing; a scratch
 *   directory was empty half an hour ago, so every file in it was put
 *   there by this run.
 *
 * In the core rather than in the developer pack, for `folder`'s reason:
 * a temporary directory is not a developer's idea of anything.
 */
export function scratchWorkspaceKind(options: ScratchWorkspaceKindOptions): WorkspaceKind {
  const { db, root = defaultScratchRoot() } = options;

  /** Every scratch directory currently on disk, absolute. Missing root means none, which is the ordinary state before the first scratch run. */
  const existingDirectories = (): string[] => {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name));
    } catch {
      return [];
    }
  };

  /**
   * Which item a directory was made for.
   *
   * `mkdtemp` appends exactly six random characters to the prefix, so
   * the key is what precedes the last seven — the six and the dash this
   * kind puts between them. Derived rather than recorded because the
   * alternative is a second file beside each directory that can be out
   * of step with it, and because a directory whose name EO cannot read
   * is one it refuses to delete rather than one it guesses about.
   */
  const itemKeyOf = (directory: string): string | null => {
    const name = directory.slice(root.length + 1);
    return name.length > 7 ? name.slice(0, -7) : null;
  };

  return {
    slug: SCRATCH_KIND,

    /**
     * A fresh directory, every time.
     *
     * The one kind whose `prepare` is deliberately *not* idempotent over
     * an item: preparing twice is two directories, because "a temporary
     * directory per run" is the whole of what this kind is. Nothing is
     * lost by that — a run that has already started is resumed from the
     * cwd its row records rather than by preparing again, which is the
     * path every resume takes — and a second dispatch on the same item
     * genuinely should not inherit what the first one left lying
     * around.
     */
    async prepare(item: Item): Promise<PrepareWorkspaceOutcome> {
      try {
        mkdirSync(root, { recursive: true });
        const cwd = mkdtempSync(join(root, `${item.key}-`));
        // The *resolved* workspace, which for an item with none of its
        // own is the first its project spans — the same row the
        // supervisor looked this kind up by. `none` answers null here
        // because there is no row at all; a scratch run has one, even
        // though nothing on it is read.
        return { ok: true, workspace: { cwd, kind: SCRATCH_KIND, workspaceId: workspaceFor(db, item)?.id ?? null } };
      } catch (error) {
        return { ok: false, reason: `EO could not make a scratch directory for ${item.key} in ${root}: ${error instanceof Error ? error.message : String(error)}` };
      }
    },

    /** Nothing. A scratch run reaches whatever it reaches through its own servers and its connectors. */
    async attach() {
      return NOTHING_ATTACHED;
    },

    /**
     * No checks, and an empty record is how that is said (EO-297).
     *
     * There is nothing here EO can check independently: no declared
     * output, because a step that names one wants a folder it can find
     * the file in afterwards; no commit to count; no tree to compare
     * against. What the run produced is posted as the output and read by
     * a person, and the column head says as much (ARCHITECTURE.md, "What 'EO checks' means on a
     * step") rather than
     * leaving anybody to assume EO looked. A verifier that always
     * passed would be that lie written down.
     */
    verifiers: {},

    /**
     * Every file in the directory, as the item's output.
     *
     * Everything rather than what changed, which is the difference from
     * the `folder` kind: this directory was made empty for this run, so
     * there is no older work in it to tell apart from the new.
     *
     * **The directory is still here when this returns, and that is
     * deliberate.** The design says artifacts "posts the files and
     * deletes the directory"; in the interface EO-295 settled on, this
     * method *returns* what the run produced and the supervisor does
     * the copying. Deleting here would hand back a list of paths to
     * files that no longer exist. So the removal is the other half of
     * the same act — `release({ what: "collected" })`, which the
     * supervisor calls the moment the files are in EO's attachment
     * store and the output comment is posted. The sweep below is the
     * backstop for a run that never got that far.
     */
    async artifacts(item: Item, run: VerifiableRun): Promise<readonly Artifact[]> {
      return fileArtifacts(await filesUnder(run.workspace.cwd));
    },

    /**
     * The directories go, once nothing can return to them.
     *
     * A settled item's own, immediately: it has reached a terminal step
     * and will not be dispatched again, so whatever was in its scratch
     * directories has been posted or was never going to be.
     *
     * And the sweep, which is what makes "the directory is gone
     * afterwards" true for an item that is still moving through a
     * pipeline. It asks a sharper question than the one it is handed:
     * the supervisor offers *which item keys still have an active run*,
     * and `active` there is queued or running — which a run parked on a
     * question is not. Deleting that run's directory would break the
     * resume a person's reply is about to trigger (EO-177), so this
     * keeps every directory a resumable run records as its cwd, and
     * uses the supervisor's predicate on top of it to cover the moment
     * between `prepare` and the run row that will name it.
     *
     * **And only directories this installation's items account for.**
     * The root is one path under `~/.eo`, which means a second
     * installation — or a test run beside a running app — is looking at
     * the same directory listing as the app. A sweep that deleted
     * whatever it did not recognise would be one EO deleting another
     * EO's live work, so a directory whose item key this database has
     * never heard of is left alone. The cost is a directory left behind
     * by an item somebody deleted (KAN-30), which is one empty folder
     * rather than somebody else's report.
     */
    async release(request: ReleaseRequest) {
      // The directory this run worked in, now that what was in it is
      // EO's (EO-299). Exactly that one, and only if it is one of ours:
      // `release` is handed a prepared workspace, and a kind that
      // removed a path it had not made would be a kind that deletes
      // whatever the last dispatch happened to point at.
      if (request.what === "collected") {
        const cwd = request.workspace.cwd;
        if (cwd.startsWith(`${root}${sep}`)) {
          try {
            rmSync(cwd, { recursive: true, force: true });
          } catch (error) {
            console.error(`[eo] could not remove the scratch directory ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return {};
      }

      const resumable = new Set(resumableRunCwds(db));

      for (const directory of existingDirectories()) {
        const itemKey = itemKeyOf(directory);
        if (itemKey === null) continue;
        if (request.what === "settled" ? itemKey !== request.item.key : request.hasActiveRun(itemKey)) continue;
        if (resumable.has(directory)) continue;
        if (!getItemByKey(db, itemKey)) continue;
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch (error) {
          // Reported rather than thrown: the sweep runs behind a
          // reconciliation nobody is waiting on, and a directory EO
          // could not remove is a note for whoever reads the log rather
          // than a reason to stop releasing the others.
          console.error(`[eo] could not remove the scratch directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return {};
    },

    /**
     * In no bucket at all (EO-296, ARCHITECTURE.md, "The four kinds").
     *
     * Two scratch runs are two directories that did not exist a moment
     * ago and share nothing, so there is no filesystem for them to
     * collide in — which is exactly the ground the cap stands on. The
     * global cap still applies and invariant 10 still holds: concurrency
     * is 1, and this changes what the cap is keyed on rather than how
     * much runs at once.
     */
    capacityKeyOf(): string | null {
      return null;
    },
  };
}
