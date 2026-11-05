import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_KIND, GIT_WORKTREE_KIND, LOCAL_PERSON_ID, NONE_KIND, NO_WORKSPACE, STEP_OUTPUTS_INPUT, saysWhatIsChecked, verificationLine, type StepInputs, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createPerson, createStep, createWorkspace, getStep } from "../db/repos/index.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { folderWorkspaceKind } from "../supervisor/folderKind.js";
import { noneWorkspaceKind } from "../supervisor/noneKind.js";
import { fakeWorkspaceKind } from "../supervisor/testWorkspaceKinds.js";
import { verifier } from "../supervisor/workspaceKind.js";
import { useWorkspaceKinds } from "../workspaceKinds.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { activeProjectId } from "./repositoryCommands.js";

/**
 * What a column head says stands behind it (EO-312, ARCHITECTURE.md,
 * "What 'EO checks' means on a step", "The board", "The interface").
 *
 * Invariant 5 is "verify, don't trust", and the product must neither
 * weaken that quietly nor overstate it — "EO verifies" on a Draft column
 * would be read as "the numbers were checked". So the question this file
 * asks is the one a person asks of a board: *is anything checking this,
 * and what*.
 *
 * The answer is assembled in two halves that must agree. The main
 * process resolves which kind each step runs on and asks that kind what
 * it checks; the renderer turns the answer into a line. Both halves are
 * exercised here — the resolution against the real `none` kind and a
 * stand-in for the repository, and the words the git kind itself
 * registers in `gitKind.test.ts`, where they sit beside the checks they
 * stand for.
 */
let handle: DbHandle;

/**
 * The shape of the developer's installation: a kind that checks
 * `implement` and nothing else, and nowhere as the other option.
 *
 * A stand-in rather than the git kind itself, because what this file is
 * about is the *resolution* — which kind each step runs on, and what the
 * board makes of the answer — and because nothing outside the pack's own
 * allowlist may import the pack. The sentences the git kind actually
 * registers are snapshotted in `gitKind.test.ts`, beside the checks they
 * stand for.
 */
function installedKinds(): void {
  useWorkspaceKinds(
    new Map([
      [
        GIT_WORKTREE_KIND,
        {
          ...fakeWorkspaceKind({ slug: GIT_WORKTREE_KIND }),
          verifiers: { implement: verifier(["commits", "tests ran"], async () => []) },
        },
      ],
      [NONE_KIND, noneWorkspaceKind("/tmp/eo/nowhere")],
    ]),
  );
}

beforeEach(() => {
  handle = openMigratedTestDb();
  attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: "/tmp/eo/the repo" });
  installedKinds();
});

afterEach(() => {
  handle.close();
  // Left as this process found it: the map is installed once by the
  // composition root in the app, and a test that walked away having
  // installed one would decide the next file's answers.
  useWorkspaceKinds(new Map());
});

function board(): ReturnType<typeof listPipelineStepViews> {
  return listPipelineStepViews(handle.db, { pipelineId: "default" });
}

/** The head each column would draw, in board order. */
function heads(): string[] {
  const { steps, verification } = board();
  if (!saysWhatIsChecked(steps, verification)) return [];
  return steps.map((step) => verificationLine(step, verification));
}

describe("a board that says what is checked", () => {
  it("says nothing on a pipeline whose every step stands on a workspace EO can vouch for", () => {
    // The developer's own board, which is the criterion phase 6 keeps
    // returning to: nothing a developer sees changes when this ships.
    // Its `review` step has no verifier — a reviewer's opinion is not
    // something to check — but the workspace under it is one EO speaks
    // for, so there is nothing here to explain.
    const { steps, verification } = board();
    expect(steps.length).toBeGreaterThan(0);
    expect(verification.every((entry) => entry.stepId !== "" && entry.kindVerifies === (getStep(handle.db, entry.stepId)?.type !== "user"))).toBe(true);
    expect(saysWhatIsChecked(steps, verification)).toBe(false);
    expect(heads()).toEqual([]);
  });

  it("makes every column say where it stands as soon as one step works nowhere", () => {
    // One step on no disk at all — a support pack's "ask the helpdesk",
    // the case the design exists for — and the whole board starts explaining
    // itself, because a line on one column and silence on the next would
    // read as the second column being unfinished.
    createStep(handle.db, {
      id: "ask",
      pipelineId: "default" as Uuid,
      position: 99,
      name: "Ask",
      type: "agent",
      ownerRole: "implementer",
      entryAction: "implement",
      workspaceId: NO_WORKSPACE,
    });

    const { steps, verification } = board();
    expect(saysWhatIsChecked(steps, verification)).toBe(true);
    // Every column, not only the one that made it appear.
    expect(heads()).toHaveLength(steps.length);
    expect(verificationLine({ id: "ask", type: "agent" }, verification)).toBe("Not checked until Approve");
  });

  it("says what the step's kind checks, in that kind's own words", () => {
    createStep(handle.db, {
      id: "ask",
      pipelineId: "default" as Uuid,
      position: 99,
      name: "Ask",
      type: "agent",
      ownerRole: "implementer",
      entryAction: "implement",
      workspaceId: NO_WORKSPACE,
    });

    const { steps, verification } = board();
    const implementing = steps.find((step) => step.entryAction === "implement" && step.id !== "ask");
    expect(implementing).toBeDefined();
    // The sentences on the head are exactly the `describes` of the
    // verifier registered for this step's action, joined — which is the
    // acceptance criterion, and is snapshotted against the git kind's
    // real words in `gitKind.test.ts`.
    expect(verificationLine(implementing!, verification)).toBe("EO checks: commits, tests ran");
  });

  it("says nothing is checked on an action no verifier answers for", () => {
    createStep(handle.db, { id: "ask", pipelineId: "default" as Uuid, position: 99, name: "Ask", type: "agent", entryAction: "implement", workspaceId: NO_WORKSPACE });

    const { steps, verification } = board();
    const reviewing = steps.find((step) => step.entryAction === "review");
    expect(reviewing).toBeDefined();
    // A git step, on a workspace EO speaks for — and still not checked,
    // because `review` is the reviewer's own opinion. The honest line is
    // the one that says so rather than one implying the branch was
    // looked at.
    expect(verificationLine(reviewing!, verification)).toBe("Not checked until Approve");
    expect(verification.find((entry) => entry.stepId === reviewing!.id)?.verifiesAction).toBe(false);
  });
});

/**
 * The kind whose answer is not the same on every column (EO-312).
 *
 * The folder kind checks the files a step *declares* it produces, so
 * what it would check is a fact about the step rather than about the
 * kind. A head that read a fixed phrase off the kind said "EO checks: a
 * file was produced" over a step that declares nothing — a column where
 * no check was ever going to run — and the editor offered a route for a
 * failed check that could never fail.
 */
describe("a folder column, which is checked for what its step declares", () => {
  /** A drive beside the repository, and a step working on it. A real directory, because the workspace refuses a path that is not there. */
  let drivePath: string;

  function folderStep(id: string, inputs: StepInputs): string {
    const projectId = activeProjectId(handle.db);
    const drive = createWorkspace(handle.db, { projectId: projectId as Uuid, kind: FOLDER_KIND, config: { path: drivePath }, position: 1 });
    createStep(handle.db, { id, pipelineId: "default" as Uuid, position: 97, name: "Draft", type: "module", entryAction: "draft-module", workspaceId: drive.id, inputs });
    return id;
  }

  beforeEach(() => {
    drivePath = mkdtempSync(join(tmpdir(), "eo-drive-"));
    // The real folder kind, which lives in the core rather than in the
    // pack — a folder is not a developer's idea — so this is the kind
    // the app installs and not a stand-in.
    useWorkspaceKinds(new Map([[FOLDER_KIND, folderWorkspaceKind({ db: handle.db })], [NONE_KIND, noneWorkspaceKind("/tmp/eo/nowhere")]]));
  });

  afterEach(() => {
    rmSync(drivePath, { recursive: true, force: true });
  });

  it("says which file it checks for, where the step names one", () => {
    const step = folderStep("draft", { [STEP_OUTPUTS_INPUT]: "report.docx" });

    const { verification } = board();
    expect(verificationLine({ id: step, type: "module" }, verification)).toBe("EO checks: report.docx was produced");
    expect(verification.find((entry) => entry.stepId === step)?.verifiesAction).toBe(true);
  });

  it("says nothing is checked where the step names none, and offers no route for a check that cannot fail", () => {
    // The verifier returns no checks for this step — there is nothing it
    // was asked to look for — so the head must not imply one, and
    // `verification_failed` must not be offered: nothing could ever
    // report it.
    const step = folderStep("draft", {});

    const { verification } = board();
    const entry = verification.find((candidate) => candidate.stepId === step);
    expect(entry?.checks).toEqual([]);
    expect(entry?.verifiesAction).toBe(false);
    expect(verificationLine({ id: step, type: "module" }, verification)).toBe("Not checked until Approve");
  });
});

describe("a human column's head", () => {
  /** An approval column, owned by somebody or by nobody. */
  function approvalStep(ownerPersonId: Uuid | null): string {
    createStep(handle.db, { id: "approve", pipelineId: "default" as Uuid, position: 98, name: "Approve", type: "user", ownerPersonId });
    return "approve";
  }

  beforeEach(() => {
    // So the board has something to explain at all; a head says nothing
    // on a pipeline EO can speak for end to end.
    createStep(handle.db, { id: "ask", pipelineId: "default" as Uuid, position: 99, name: "Ask", type: "agent", entryAction: "implement", workspaceId: NO_WORKSPACE });
  });

  it("names you where nobody is named", () => {
    const step = approvalStep(null);

    const { verification } = board();
    expect(verificationLine({ id: step, type: "user" }, verification)).toBe("You approve here");
  });

  it("names the person the step waits on, once there is somebody else to name", () => {
    const anna = createPerson(handle.db, { name: "Anna Ruiz" });
    const step = approvalStep(anna.id);

    const { verification } = board();
    expect(verificationLine({ id: step, type: "user" }, verification)).toBe("Anna Ruiz · approves here");
  });

  it("stays quiet about the one person there is", () => {
    // Solo mode names nobody anywhere else on this screen (EO-305), and
    // a head naming the only pair of hands there is would be EO telling
    // somebody about themselves.
    const step = approvalStep(LOCAL_PERSON_ID);

    const { verification } = board();
    expect(verification.find((entry) => entry.stepId === step)?.waitsOn).toBeNull();
    expect(verificationLine({ id: step, type: "user" }, verification)).toBe("You approve here");
  });

  it("says nothing about a workspace on a step nothing runs on", () => {
    // A human step has no action for a kind to answer for. Reporting
    // "Not checked" there would be describing a run that never happens.
    const step = approvalStep(null);

    const entry = board().verification.find((candidate) => candidate.stepId === step);
    expect(entry).toMatchObject({ checks: [], verifiesAction: false, kindVerifies: false });
  });
});
