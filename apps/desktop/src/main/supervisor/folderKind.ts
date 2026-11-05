import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { declaredOutputs, FOLDER_KIND, type Item } from "@eo/core";
import type { Db } from "../db/client.js";
import { asFolderWorkspace, folderPathProblem, getRun, getStep } from "../db/repos/index.js";
import { fileArtifacts, filesUnder, FILESYSTEM_CLOCK_GRACE_MS, resolveWithin } from "./workspaceFiles.js";
import { ANY_ACTION, NOTHING_ATTACHED, verifier, type Artifact, type Check, type PrepareWorkspaceOutcome, type VerifiableRun, type WorkspaceKind } from "./workspaceKind.js";
import { workspaceFor } from "./workspaceResolution.js";

/** What the folder kind needs from the process in order to be built: the rows it reads, and nothing else. */
export interface FolderWorkspaceKindOptions {
  db: Db;
}

/**
 * A directory somebody already has, as a workspace kind (EO-299,
 * ARCHITECTURE.md, "The four kinds", "The gallery").
 *
 * The shared drive. A marketing manager's report is drafted from a
 * folder of CSVs; a content team works where the rest of the team can
 * see it. Nothing about that is a repository — there is no branch to
 * cut, no commit to count and no test suite to run — but it is
 * emphatically a *disk*: two runs in one folder tread on each other, so
 * it has a capacity key, and a step that says it produces `report.docx`
 * can be held to that, so it has a verifier.
 *
 * **In the core rather than in the developer pack.** A folder is not a
 * developer's idea — it is the least domain-specific place work can
 * happen — and an installation with the developer pack removed still
 * has to be able to write a report. `none` is here for the same reason
 * and by the same rule: a pack may replace either by contributing its
 * own kind under the slug, and the fold refuses two packs claiming one.
 */
export function folderWorkspaceKind(options: FolderWorkspaceKindOptions): WorkspaceKind {
  const { db } = options;

  /** The folder this item's run belongs to, or null when its workspace is of another kind or has gone. */
  const folderOf = (item: Item) => asFolderWorkspace(workspaceFor(db, item));

  return {
    slug: FOLDER_KIND,

    /**
     * The folder, or this item's drawer in it.
     *
     * `perItemSubfolder` is the whole of the choice: off, every item on
     * this workspace works in the same directory, which is what a
     * shared drive is; on, each gets `<path>/<its key>`, which is what a
     * team wants when two reports are being drafted at once. The
     * subfolder is created if it is not there — EO made that layout up,
     * so EO maintains it — and the folder itself never is, for
     * `folderPathProblem`'s reason: a path that is not there is a typo,
     * and a directory created to match one is a directory nobody will
     * look in.
     *
     * The path is checked again here rather than trusted from creation,
     * because a drive that was mounted when it was attached is not
     * necessarily mounted this morning. A refusal escalates before the
     * agent starts, which is what preparation ahead of the run row is
     * for.
     */
    async prepare(item: Item): Promise<PrepareWorkspaceOutcome> {
      const workspace = folderOf(item);
      if (!workspace) {
        return { ok: false, reason: `${item.key} is on a folder workspace that no longer exists, so there is nowhere for this run to work.` };
      }

      const problem = folderPathProblem(workspace.config.path);
      if (problem !== null) return { ok: false, reason: problem };

      if (!workspace.config.perItemSubfolder) {
        return { ok: true, workspace: { cwd: workspace.config.path, kind: FOLDER_KIND, workspaceId: workspace.id } };
      }

      const cwd = join(workspace.config.path, item.key);
      try {
        mkdirSync(cwd, { recursive: true });
      } catch (error) {
        return { ok: false, reason: `EO could not make ${item.key}'s folder in ${workspace.config.path}: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { ok: true, workspace: { cwd, kind: FOLDER_KIND, workspaceId: workspace.id } };
    },

    /**
     * Nothing.
     *
     * There is no index to hand over and no server to point at a drive.
     * The agent has the directory as its cwd and its own tools; what a
     * folder lends is the folder.
     */
    async attach() {
      return NOTHING_ATTACHED;
    },

    /**
     * Did this run leave behind what its step says it produces
     * (invariant 5)?
     *
     * Registered under `ANY_ACTION`, and that is the difference from the
     * git kind, which names `implement` and nothing else: a branch can
     * only be judged on the action that cuts commits, because `refine`
     * produces stories the engine cannot invent and `review` is the
     * reviewer's own opinion — but "is there a file called
     * `report.docx`, and did this run write it" is the same observable
     * question whatever the step was called and whoever ran it. A module
     * that claims it wrote the report is checked exactly like an agent
     * that claims it (ARCHITECTURE.md, "The interface"), and the set of actions this covers
     * could not be written down in any case: a module id is one of them.
     *
     * **Exists is not enough.** A folder is shared and usually not
     * empty: last quarter's `report.docx` is sitting right there, and a
     * check that only asked whether the file existed would pass a run
     * that did nothing at all. So each check asks both — is it there,
     * and has it changed since this run started — and the sentence says
     * which of the two failed, because "EO could not find it" and "EO
     * found last month's" send a person to look in different places.
     *
     * A step that declares no outputs is verified with no checks. That
     * is a real answer rather than a gap: EO says what it checked, and
     * a folder step that promises nothing in particular has nothing
     * mechanical to be held to.
     *
     * And the head says the same thing (EO-312): what this checks is
     * read off the step, so what it *says* it checks is read off the
     * step too. A column whose step names `report.docx` says "EO checks:
     * report.docx was produced"; a column whose step names nothing says
     * "Not checked until Approve", because that is the truth about it —
     * a fixed phrase there would have claimed a file was checked for on
     * a step where no check was ever going to run, and would have
     * offered a `verification_failed` route down a branch nothing could
     * take.
     */
    verifiers: {
      [ANY_ACTION]: verifier(
        (step) => declaredOutputs(step.inputs).map((declared) => `${declared} was produced`),
        async (item: Item, run: VerifiableRun): Promise<readonly Check[]> => {
        // The step this run was dispatched *from*, not the one the item
        // is on now. They are usually the same and occasionally are not:
        // a module can run for minutes, and a person who moves the item
        // while it runs has not changed what it was asked to produce.
        const row = getRun(db, run.id);
        const stepId = row?.stepId ?? item.stepId;
        const step = stepId === null || stepId === undefined ? undefined : getStep(db, stepId);
        const outputs = declaredOutputs(step?.inputs);
        if (outputs.length === 0) return [];

        // The moment the run began, from the row rather than the clock:
        // "changed since the run started" has to mean the run being
        // verified, and a run resumed after a person replied is still the
        // same run that was started. A row with no start time — which
        // nothing that reaches verification has — is checked on existence
        // alone rather than failed for a fact about EO's own bookkeeping.
        const startedAt = row?.startedAt ?? null;
        const cwd = run.workspace.cwd;

        return outputs.map((declared) => {
          const key = `output:${declared}`;
          const target = resolveWithin(cwd, declared);
          if (target === null) {
            return {
              key,
              passed: false,
              blocks: true,
              describes: `This step says it produces ${declared}, which is outside ${cwd}. An output is something the run wrote where it worked, so EO will not go looking for it elsewhere.`,
            };
          }

          let modifiedAt: number;
          try {
            modifiedAt = statSync(target).mtimeMs;
          } catch {
            return { key, passed: false, blocks: true, describes: `This step says it produces ${declared}, and there is no such file in ${cwd}.` };
          }

          // The grace is the two clocks, not slack in the check: see
          // `FILESYSTEM_CLOCK_GRACE_MS`.
          if (startedAt !== null && modifiedAt < startedAt - FILESYSTEM_CLOCK_GRACE_MS) {
            return {
              key,
              passed: false,
              blocks: true,
              describes: `${declared} is in ${cwd}, but it has not changed since this run started — so what is there is whatever was there before, not what this run produced.`,
            };
          }

          return { key, passed: true, blocks: true, describes: `${declared} is in ${cwd} and was written while this run was working.` };
        });
        },
      ),
    },

    /**
     * Nothing to let go of, whichever way the question is asked.
     *
     * The folder is somebody else's — it was there before EO and will be
     * there after — and the per-item subfolder holds the work itself.
     * That includes `collected`: the report being an attachment on the
     * item's output does not make the copy on the drive disposable,
     * because the drive is where the team looks for it.
     * Deleting either on settlement would be EO throwing away the
     * deliverable at the moment the item was finished with, which is the
     * opposite of what a settled item means here. The git kind releases
     * a *checkout* it made and `scratch` releases a directory it made;
     * this kind made neither.
     */
    async release() {
      return {};
    },

    /**
     * What the run produced: the files in the folder that changed while
     * it was working.
     *
     * Changed rather than every file, which is the difference between a
     * folder and a scratch directory: a shared drive holds years of
     * other people's work, and posting all of it as this run's output
     * would bury the report in it. The run's own start time is the line,
     * the same one `verify` reads.
     *
     * Files rather than text (`FileArtifact`): a report is a `.docx`,
     * and whatever posts it copies the bytes rather than reading them
     * through a string. Posting these as the item's output — a comment
     * of kind `output` with these as its attachments — is EO-298's, and
     * this is the method it posts from.
     */
    async artifacts(item: Item, run: VerifiableRun): Promise<readonly Artifact[]> {
      const startedAt = getRun(db, run.id)?.startedAt;
      if (startedAt === null || startedAt === undefined) return [];
      return fileArtifacts(await filesUnder(run.workspace.cwd, { since: startedAt }));
    },

    /**
     * The workspace, because that is the filesystem two runs would
     * share (EO-296, ARCHITECTURE.md, "The four kinds").
     *
     * The same answer in both layouts, including `perItemSubfolder`,
     * where two items genuinely have directories of their own. The cap
     * is keyed on a shared *filesystem* rather than on a shared path:
     * the subfolders sit in one drive, which may be a network mount
     * doing one thing at a time, and a cap that quietly excused them
     * would be a cap that does not mean what its name says. Two items on
     * one folder workspace therefore queue, which is the acceptance
     * criterion this answers.
     */
    capacityKeyOf(item: Item): string | null {
      return workspaceFor(db, item)?.id ?? null;
    },
  };
}
