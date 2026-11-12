import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLDER_KIND, isPreviewAgent, moduleInputProblems, type ModuleManifest, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  approveModule,
  asFolderWorkspace,
  createAgent,
  createPerson,
  createProject,
  getItem,
  getMcpServerByName,
  getPipeline,
  getPipelineOrigin,
  itemTypesFor,
  listAgents,
  listJobs,
  listPipelines,
  listProjects,
  listStepsForPipeline,
  projectWorkspaceList,
  localPerson,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { listPipelineViews } from "../ipc/domainQueries.js";
import { setActiveProjectCommand } from "../ipc/projectCommands.js";
import { activeProjectId } from "../ipc/repositoryCommands.js";
import { galleryNeedsCommand, listGalleryCommand, previewGalleryCommand, useGalleryCommand } from "../ipc/galleryCommands.js";
import { parseScheduleAnswer } from "./commands.js";
import { forgetListed } from "./session.js";
import type { ServerClient } from "../managed/serverClient.js";
import { bundledTemplates } from "./templates.js";
import { loadTemplateHistory } from "./history.js";
import { backfillPipelineOrigins } from "./origins.js";
import { applyTemplateUpdates } from "./templateUpdates.js";

/**
 * "Use this" (EO-316, `ARCHITECTURE.md`, "The gallery" into "The needs check").
 *
 * "Submitting creates the project, workspace, pipeline, agents, job and
 * item types in one step and lands on the needs check." One step,
 * because a person who answered three questions and got a project with
 * no pipeline on it has been left halfway through something they cannot
 * finish by hand.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
/**
 * A keychain stand-in. The gallery never writes a secret; what needs one
 * is the preflight behind every card's "what this needs" list, which
 * reads the names it already holds.
 */
const NO_SECRETS = {
  directory: join(tmpdir(), "eo-gallery-no-secrets"),
  store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
};

let handle: DbHandle;
let folder: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  folder = mkdtempSync(join(tmpdir(), "eo weekly reports "));
  // What a previous case listed is held in a module, and these cases
  // never list — so each starts from nothing rather than from whatever
  // ran before it in this worker.
  forgetListed();
});

afterEach(() => {
  handle.close();
  rmSync(folder, { recursive: true, force: true });
});

function context() {
  return { directory: GALLERY_DIRECTORY, moduleSecrets: NO_SECRETS, signedInBackends: [] as string[] };
}

/** The form's answers: a folder, a Monday schedule and a prefix. */
function monday() {
  return { slug: "weekly-report", answers: { folder, schedule: "monday 08:00", keyPrefix: "REP" }, roleSlots: {} };
}

describe("Use this on \"Weekly report\", with a folder and a Monday schedule", () => {
  it("creates the project, the folder workspace, the pipeline and the job in one step", async () => {
    const answer = await useGalleryCommand(handle.db, context(), monday());

    expect(answer.problem).toBeNull();
    const project = listProjects(handle.db).find((candidate) => candidate.id === answer.projectId);
    expect(project?.name).toBe("Weekly report");
    expect(project?.keyPrefix).toBe("REP");

    // A `folder` workspace, on the project, at the path that was typed.
    const workspaces = projectWorkspaceList(handle.db, answer.projectId as Uuid);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.kind).toBe(FOLDER_KIND);
    expect(asFolderWorkspace(workspaces[0]!)?.config.path).toBe(folder);

    // The pipeline, whole: four steps, not a name with nothing under it.
    const pipeline = listPipelines(handle.db, answer.projectId as Uuid).find((candidate) => candidate.id === answer.pipelineId);
    expect(pipeline?.name).toBe("Weekly report");
    expect(listStepsForPipeline(handle.db, answer.pipelineId!).map((step) => step.name)).toEqual(["Gather", "Draft", "Approve", "Filed"]);

    // The item types the pack ships, on the project it created — without
    // them the job below could not file anything.
    expect([...itemTypesFor(handle.db, answer.projectId as Uuid).values()].some((type) => type.slug === "report")).toBe(true);

    // And the role, as an agent: unbound, because nothing is signed in
    // here, which is what the design says an unstaffed role looks like.
    const reporter = listAgents(handle.db).find((agent) => agent.role === "reporter");
    expect(reporter).toBeDefined();
    expect(reporter?.enabled).toBe(false);
  });

  /**
   * The first project made from another template has its own pipeline and
   * no other (EO-766): the seeded Delivery, which holds no work, is
   * archived rather than shown to it.
   */
  it("archives the seeded Delivery when it makes the first project, and lists only its own pipeline", async () => {
    const answer = await useGalleryCommand(handle.db, context(), monday());

    expect(getPipeline(handle.db, "default")?.archivedAt).not.toBeNull();
    expect(listPipelineViews(handle.db, { projectId: answer.projectId }).pipelines.map((pipeline) => pipeline.id)).toEqual([answer.pipelineId]);
  });

  it("makes the schedule job, owned by the local person", async () => {
    const answer = await useGalleryCommand(handle.db, context(), monday());

    const jobs = listJobs(handle.db, answer.projectId as Uuid);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.id).toBe(answer.jobId);
    expect(job.name).toBe("Weekly report");
    expect(job.pipelineId).toBe(answer.pipelineId);
    // Monday, 08:00, in this machine's zone — Sunday is 0, so Monday is 1.
    expect(job.trigger).toMatchObject({ kind: "schedule", schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 } });
    // ARCHITECTURE.md, "Controls": a job's occurrences land in somebody's inbox and draw on
    // their budget. In solo mode that somebody is the one person there is.
    expect(job.ownerId).toBe(localPerson(handle.db).id);
  });

  /**
   * And the window is looking at it (EO-316).
   *
   * `activeProjectId` keeps whatever is stored as long as it still
   * resolves, so on an installation that already had a project the one
   * just created was not the one on screen: the sidebar listed somebody
   * else's pipelines and "Go to the board" opened their board. A person
   * who has just answered three questions about a template is looking at
   * that template next.
   */
  it("makes the project it created the one the window is on", async () => {
    // Somebody's existing project, and the one EO is showing.
    const theirs = createProject(handle.db, { name: "Acme API", keyPrefix: "ACME" });
    setActiveProjectCommand(handle.db, { id: theirs.id });
    expect(activeProjectId(handle.db)).toBe(theirs.id);

    const answer = await useGalleryCommand(handle.db, context(), monday());

    expect(answer.problem).toBeNull();
    expect(activeProjectId(handle.db)).toBe(answer.projectId);
  });

  /** And a refusal leaves it where it was, because the write is in the transaction. */
  it("leaves the window where it was when the install is refused", async () => {
    const theirs = createProject(handle.db, { name: "Acme API", keyPrefix: "ACME" });
    setActiveProjectCommand(handle.db, { id: theirs.id });

    const answer = await useGalleryCommand(handle.db, context(), {
      ...monday(),
      answers: { ...monday().answers, schedule: "whenever" },
    });

    expect(answer.problem).not.toBeNull();
    expect(activeProjectId(handle.db)).toBe(theirs.id);
  });

  it("lands on the needs check, with a line per thing still missing", async () => {
    const answer = await useGalleryCommand(handle.db, context(), monday());

    const lines = Object.fromEntries(answer.needs.map((need) => [need.key, need]));
    // Green: the folder was chosen on the form.
    expect(lines["workspace"]?.met).toBe(true);
    // Red: nothing is signed in, so the role the pack named has nobody
    // in it and there is no backend to put there.
    expect(lines["role:reporter"]?.met).toBe(false);
    expect(lines["backend"]?.met).toBe(false);
  });

  it("assigns the human step to the one person there is, and asks nobody", async () => {
    const answer = await useGalleryCommand(handle.db, context(), monday());

    const approve = listStepsForPipeline(handle.db, answer.pipelineId!).find((step) => step.name === "Approve");
    // "In solo mode the approver slot is pre-filled with 'you' and
    // hidden" — and `roleSlots` above is empty, which is what the hidden
    // picker sends.
    expect(approve?.ownerPersonId).toBe(localPerson(handle.db).id);
  });

  /**
   * And leaves the terminal step alone, which is the other half of the
   * same rule (ARCHITECTURE.md, "The gallery").
   *
   * "Filed" is a `user` step and is not a decision: nothing is routed
   * out of it and nobody presses anything on it. Solo mode fills every
   * slot with the one person there is, so a terminal step counted as a
   * slot would quietly acquire an owner — on a column with nothing to
   * own. The shipped Delivery pipeline has never put one on
   * `ready_to_merge`, and the gallery must not start.
   */
  it("puts nobody on the terminal step, which is where the report comes to rest", async () => {
    const answer = await useGalleryCommand(handle.db, context(), monday());

    const filed = listStepsForPipeline(handle.db, answer.pipelineId!).find((step) => step.name === "Filed");
    expect(filed?.isTerminal).toBe(true);
    expect(filed?.ownerPersonId).toBeNull();
  });
});

describe("the form's refusals", () => {
  it("will not proceed on an unanswered required blank", async () => {
    const answer = await useGalleryCommand(handle.db, context(), { slug: "weekly-report", answers: { schedule: "monday 08:00", keyPrefix: "REP" }, roleSlots: {} });

    expect(answer.problem).toContain("Where the material lives");
    expect(listProjects(handle.db)).toHaveLength(0);
  });

  it("will not proceed on a folder that is not there", async () => {
    const answer = await useGalleryCommand(handle.db, context(), {
      slug: "weekly-report",
      answers: { folder: join(folder, "nope"), schedule: "monday 08:00", keyPrefix: "REP" },
      roleSlots: {},
    });

    expect(answer.problem).toContain("does not exist");
    expect(listProjects(handle.db)).toHaveLength(0);
  });

  it("will not proceed on a schedule it could not honour", async () => {
    const answer = await useGalleryCommand(handle.db, context(), {
      slug: "weekly-report",
      answers: { folder, schedule: "whenever", keyPrefix: "REP" },
      roleSlots: {},
    });

    // The one thing on this form a person would not discover for a week.
    expect(answer.problem).toContain("not a day and a time");
    expect(listProjects(handle.db)).toHaveLength(0);
  });

  it("will not take a prefix another project is numbering by", async () => {
    await useGalleryCommand(handle.db, context(), monday());
    const again = await useGalleryCommand(handle.db, context(), monday());

    expect(again.problem).toContain("already in use");
    expect(listProjects(handle.db)).toHaveLength(1);
  });
});

/**
 * The rehearsal must not be mistaken for staffing, and must not touch
 * anybody's configuration — see `PREVIEW_AGENT_KEY` in core.
 *
 * Previewing gives the pack's roles a `fake` agent so the walk can
 * happen at all. The question is what that row means afterwards, and
 * the answer is `staffsItem`: it runs previews and nothing else, so it
 * fills no line on a needs check, silences no warning, and is never
 * picked for a real item. Nothing has to be cleaned up, which is why
 * "Use this" no longer removes anything — see the case below about a
 * preview still in flight.
 */
describe("after a preview", () => {
  /** A reporter somebody set up and then switched off for the afternoon. */
  function switchedOff() {
    return createAgent(handle.db, {
      name: "Anna's reporter",
      role: "reporter",
      provider: "claude",
      model: "sonnet",
      instructions: "Write it the way Anna likes it.",
      enabled: false,
    });
  }

  it("does not report a role as staffed by the agent a preview needed", async () => {
    const preview = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    expect(preview.problem).toBeNull();
    const staffed = listAgents(handle.db).find((agent) => agent.role === "reporter" && isPreviewAgent(agent));
    expect(staffed?.provider).toBe("fake");
    expect(staffed?.enabled).toBe(true);

    const answer = await useGalleryCommand(handle.db, context(), monday());

    // Red, with the preview's own agent sitting right there — which is
    // the point: it is not this project's staffing.
    expect(answer.needs.find((need) => need.key === "role:reporter")?.met).toBe(false);
    expect(listAgents(handle.db).some((agent) => agent.role === "reporter" && isPreviewAgent(agent) && agent.archivedAt === null)).toBe(true);
  });

  /**
   * And the import still writes a real one, which the archiving used to
   * be what made possible.
   *
   * `writeRoles` skips a role somebody already has an agent in. A
   * preview's own is not somebody having one, so the project that asked
   * for this pack gets a row of its own, unbound because nothing here is
   * signed in — which is what the design says an unstaffed role looks like.
   */
  it("still writes the project a real agent for the role, beside the preview's", async () => {
    await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    await useGalleryCommand(handle.db, context(), monday());

    const reporters = listAgents(handle.db).filter((agent) => agent.role === "reporter" && agent.archivedAt === null);
    expect(reporters).toHaveLength(2);
    const real = reporters.find((agent) => !isPreviewAgent(agent));
    expect(real?.enabled).toBe(false);
    expect(real?.instructions).toContain("weekly report");
  });

  /**
   * The bug this pair exists for.
   *
   * An earlier cut reached for whatever agent already held the role
   * whenever it was not *currently* dispatchable — switched off, or
   * waiting for a backend — rewrote it onto `fake` and marked it, and
   * then archived it on the next "Use this". Somebody's configured
   * reporter, with their own prompt and their own backend, deleted by
   * pressing Preview and then Use this. A rehearsal may add a row of its
   * own; it may not edit one it did not make.
   */
  it("leaves an agent somebody switched off exactly as it was, and adds its own beside it", async () => {
    const theirs = switchedOff();

    await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });

    const after = listAgents(handle.db).find((agent) => agent.id === theirs.id);
    expect(after).toMatchObject({ provider: "claude", model: "sonnet", enabled: false, archivedAt: null });
    expect(after?.instructions).toBe("Write it the way Anna likes it.");
    expect(isPreviewAgent(after!)).toBe(false);
    // And the preview still walked, because it made a row of its own.
    expect(listAgents(handle.db).some((agent) => agent.role === "reporter" && isPreviewAgent(agent))).toBe(true);
  });

  it("leaves it alone through a Use this as well", async () => {
    const theirs = switchedOff();

    await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    const answer = await useGalleryCommand(handle.db, context(), monday());

    expect(answer.problem).toBeNull();
    const after = listAgents(handle.db).find((agent) => agent.id === theirs.id);
    expect(after?.archivedAt).toBeNull();
    expect(after?.provider).toBe("claude");
    expect(after?.enabled).toBe(false);
  });

  /**
   * A preview still walking keeps the agent it is walking on (EO-316).
   *
   * The sequence is an ordinary one: press Preview, like what you see,
   * press Use this a moment later while the rehearsal is still moving.
   * An earlier cut archived every marked row at that moment, and
   * `isDispatchable` then refused the archived agent — so the preview on
   * screen stopped at its next agent step and stayed there, with nothing
   * anywhere to say why. Nothing is removed now, because nothing needs
   * to be.
   */
  it("leaves an unfinished preview able to carry on", async () => {
    const preview = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    const agentId = listAgents(handle.db).find((agent) => agent.role === "reporter" && isPreviewAgent(agent))?.id;
    expect(agentId).toBeDefined();

    await useGalleryCommand(handle.db, context(), monday());

    const after = listAgents(handle.db).find((agent) => agent.id === agentId);
    expect(after?.archivedAt).toBeNull();
    expect(after?.enabled).toBe(true);
    // And the item it was made for is still there to be walked.
    expect(getItem(handle.db, preview.itemId as Uuid)?.previewAt).not.toBeNull();
  });

  /** The same rule from the other side: an agent that can already run is not duplicated. */
  it("adds nothing when the role already has an agent that can be dispatched", async () => {
    createAgent(handle.db, { name: "Anna's reporter", role: "reporter", provider: "claude", instructions: "Hers.", enabled: true });

    await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });

    expect(listAgents(handle.db).filter((agent) => agent.role === "reporter")).toHaveLength(1);
  });
});

/**
 * Who a role slot names is checked before anything is written (ARCHITECTURE.md, "The gallery").
 *
 * `pipeline_steps.owner_person_id` is a foreign key, so an id EO does
 * not have used to arrive as a constraint failure at the *end* of the
 * install — after the project, the workspace and the pipeline existed.
 */
describe("the people a role slot names", () => {
  /**
   * A second person, which is what stops this installation being solo —
   * and so what makes the picker, and everything it can be given, real.
   * In solo mode the main process fills every slot with the one person
   * there is and ignores whatever arrived, which is a defence of its own
   * and the reason this has to be set up deliberately to test at all.
   */
  let priya: ReturnType<typeof createPerson>;

  beforeEach(() => {
    priya = createPerson(handle.db, { name: "Priya" });
  });

  it("refuses somebody EO does not know, and writes nothing at all", async () => {
    const answer = await useGalleryCommand(handle.db, context(), { ...monday(), roleSlots: { approve: "Priya" } });

    // A sentence rather than "FOREIGN KEY constraint failed", and before
    // the project rather than after it.
    expect(answer.problem).toContain("Choose a person from the list");
    expect(listProjects(handle.db)).toHaveLength(0);
    expect(listPipelines(handle.db, null)).toHaveLength(2);
  });

  it("refuses a slot the template does not have", async () => {
    const answer = await useGalleryCommand(handle.db, context(), { ...monday(), roleSlots: { nonesuch: priya.id } });

    expect(answer.problem).toContain("no step called");
    expect(listProjects(handle.db)).toHaveLength(0);
  });

  it("puts a real person on the step they were chosen for", async () => {
    const answer = await useGalleryCommand(handle.db, context(), { ...monday(), roleSlots: { approve: priya.id } });

    expect(answer.problem).toBeNull();
    const approve = listStepsForPipeline(handle.db, answer.pipelineId!).find((step) => step.name === "Approve");
    expect(approve?.ownerPersonId).toBe(priya.id);
  });

  it("leaves the step waiting for anybody when nobody was chosen", async () => {
    const answer = await useGalleryCommand(handle.db, context(), { ...monday(), roleSlots: { approve: "" } });

    expect(answer.problem).toBeNull();
    const approve = listStepsForPipeline(handle.db, answer.pipelineId!).find((step) => step.name === "Approve");
    expect(approve?.ownerPersonId).toBeNull();
  });
});

/**
 * After an organisation sign-in in first run (EO-661): the local table
 * holds only this machine's own person, so without the organisation's
 * list the picker would be hidden as solo and offer nobody.
 */
describe("the people a role slot names, on a desktop signed in to an organisation", () => {
  const dana = { id: "019a0000-0000-7000-8000-00000000da0a", name: "Dana", email: "dana@acme.com", isAdmin: true, invitedAt: 1, acceptedAt: 2, credentialKind: "password" };
  /** Signed in; `reachable` says whether the organisation answers this time. */
  const signedIn = (reachable = true) => ({
    ...context(),
    managed: {
      client: () => ({
        address: "https://eo.acme.com",
        request: (() =>
          Promise.resolve(
            reachable
              ? { ok: true, data: { people: [dana], groups: [], fromServer: false } }
              : { ok: false, error: { message: "EO could not reach https://eo.acme.com" } },
          )) as ServerClient["request"],
      }),
    },
  });

  it("lists the organisation's people and shows the picker", async () => {
    const listed = await listGalleryCommand(handle.db, signedIn());

    expect(listed.people).toEqual([{ id: dana.id, name: "Dana" }]);
    expect(listed.templates.every((template) => !template.solo)).toBe(true);
  });

  it("puts a colleague off that list on the step they were chosen for", async () => {
    const answer = await useGalleryCommand(handle.db, signedIn(), { ...monday(), roleSlots: { approve: dana.id } });

    expect(answer.problem).toBeNull();
    const approve = listStepsForPipeline(handle.db, answer.pipelineId!).find((step) => step.name === "Approve");
    expect(approve?.ownerPersonId).toBe(dana.id);
  });

  /**
   * The server goes away between the list and the submission (EO-661
   * review). The local table still holds only this machine's person,
   * which used to read as solo mode and put them on every slot instead.
   */
  it("keeps the chosen colleague when the server is lost after the list was drawn", async () => {
    await listGalleryCommand(handle.db, signedIn(true));
    const answer = await useGalleryCommand(handle.db, signedIn(false), { ...monday(), roleSlots: { approve: dana.id } });

    expect(answer.problem).toBeNull();
    const approve = listStepsForPipeline(handle.db, answer.pipelineId!).find((step) => step.name === "Approve");
    expect(approve?.ownerPersonId).toBe(dana.id);
  });

  it("is not solo while the server cannot be reached, so the picker stays and nobody is put on a slot for them", async () => {
    await listGalleryCommand(handle.db, signedIn(true));
    const listed = await listGalleryCommand(handle.db, signedIn(false));
    expect(listed.templates.every((template) => !template.solo)).toBe(true);
    expect(listed.people).toEqual([{ id: dana.id, name: "Dana" }]);

    const answer = await useGalleryCommand(handle.db, signedIn(false), { ...monday(), roleSlots: { approve: "" } });
    const approve = listStepsForPipeline(handle.db, answer.pipelineId!).find((step) => step.name === "Approve");
    expect(approve?.ownerPersonId).toBeNull();
  });

  it("refuses, creating nothing, a colleague it cannot name while the server cannot be reached", async () => {
    const answer = await useGalleryCommand(handle.db, signedIn(false), { ...monday(), roleSlots: { approve: dana.id } });

    expect(answer.problem).toContain("could not reach your organisation");
    expect(listProjects(handle.db)).toHaveLength(0);
  });
});

/**
 * One submission is one transaction (ARCHITECTURE.md, "The gallery").
 *
 * The case that cannot be checked in advance: a pipeline with no entry
 * step imports perfectly and then refuses to carry a job, which happens
 * after the project, the workspace and the graph have all been written.
 * Rolled back whole, because an installation holding a project and a
 * pipeline for a template it was told it had not installed is a
 * half-made thing nobody asked for and nobody can finish by hand.
 */
describe("a write that fails half way", () => {
  let gallery: string;

  beforeEach(() => {
    gallery = mkdtempSync(join(tmpdir(), "eo broken gallery "));
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((candidate) => candidate.slug === "weekly-report")!;
    const pack = JSON.parse(JSON.stringify(weekly.document)) as Record<string, unknown>;
    // Nothing for a job to file work onto, and nothing `useTemplate`
    // could have known before `createJob` said so.
    pack["pipeline"] = { ...(pack["pipeline"] as Record<string, unknown>), entryStepId: null };
    writeFileSync(join(gallery, "weekly-report.json"), JSON.stringify(pack));
  });

  afterEach(() => {
    rmSync(gallery, { recursive: true, force: true });
  });

  it("leaves no project, no workspace and no pipeline behind", async () => {
    const answer = await useGalleryCommand(handle.db, { ...context(), directory: gallery }, monday());

    expect(answer.problem).toContain("no step for new work to start on");
    expect(listProjects(handle.db)).toHaveLength(0);
    // The two the installation ships, and nothing imported beside them.
    expect(listPipelines(handle.db, null)).toHaveLength(2);
    expect(listJobs(handle.db, null)).toHaveLength(0);
  });
});

describe("the schedule a person typed", () => {
  it("reads a weekday and a time, and refuses anything else", () => {
    expect(parseScheduleAnswer("monday 08:00")).toEqual({ kind: "weekly", weekday: 1, hour: 8, minute: 0 });
    expect(parseScheduleAnswer("Sunday 17:30")).toEqual({ kind: "weekly", weekday: 0, hour: 17, minute: 30 });
    expect(parseScheduleAnswer("daily 6:05")).toEqual({ kind: "daily", hour: 6, minute: 5 });
    expect(parseScheduleAnswer("someday 08:00")).toBeNull();
    expect(parseScheduleAnswer("monday 25:00")).toBeNull();
    expect(parseScheduleAnswer("")).toBeNull();
  });
});

describe("the templates that ask for other things", () => {
  it("asks the software template only for a prefix, and leaves the workspace to the needs check", async () => {
    const template = bundledTemplates(GALLERY_DIRECTORY).find((candidate) => candidate.slug === "software-feature-to-merge")!;
    expect(template.template.blanks.map((blank) => blank.kind)).toEqual(["keyPrefix"]);

    const answer = await useGalleryCommand(handle.db, context(), {
      slug: "software-feature-to-merge",
      answers: { keyPrefix: "ACME" },
      roleSlots: {},
    });

    expect(answer.problem).toBeNull();
    expect(answer.jobId).toBeNull();
    expect(answer.needs.find((need) => need.key === "workspace")?.met).toBe(false);
  });

  it("lands the inbox template's connector disconnected, as a red line", async () => {
    const answer = await useGalleryCommand(handle.db, context(), { slug: "inbox-triage", answers: { keyPrefix: "MSG" }, roleSlots: {} });

    expect(answer.problem).toBeNull();
    // "Connectors land disconnected" (ARCHITECTURE.md, "Import is the needs check") — a need rather
    // than a report.
    expect(answer.needs.find((need) => need.key === "connector:mailbox")).toMatchObject({ met: false });
  });

  /**
   * And that red line is one somebody can turn green (EO-315,
   * ARCHITECTURE.md, "What a person sees first").
   *
   * A bundled template that named a server and shipped no way to connect
   * it would put a permanently red line on the one screen a
   * non-developer starts from — the dead end EO-315's own gate exists to
   * refuse. So the pack carries the setup, and the import writes a row
   * the Connect button can finish: the name the value is stored under is
   * declared here rather than told to somebody out of band.
   */
  it("ships the inbox template's mailbox as something a person can connect", async () => {
    await useGalleryCommand(handle.db, context(), { slug: "inbox-triage", answers: { keyPrefix: "MSG" }, roleSlots: {} });

    const mailbox = getMcpServerByName(handle.db, "mailbox");
    expect(mailbox?.connector).toMatchObject({ label: "Mailbox", kind: "token", secretNames: ["MAILBOX_API_TOKEN"] });
    // Declared on the server too, or the Connect button would store a
    // value under a name the delivery path never reads.
    expect(mailbox?.envNames).toEqual(["MAILBOX_API_TOKEN"]);
  });
});

/**
 * A module's inputs keep the types its manifest declared (EO-316).
 *
 * `pipeline_steps.inputs` holds `string | number | boolean`, and
 * `moduleInputProblems` refuses a value that is not what the manifest
 * says — both when a pipeline is published and again when a module
 * actually runs. The form answers in text, so without a parse in
 * between the gallery wrote `"900"` where the manifest said `900`: the
 * install reported success, the needs check was green, and the step's
 * first real run was refused for a type mismatch nobody could trace
 * back to a form they filled in a week earlier.
 */
describe("a template whose module declares typed inputs", () => {
  let gallery: string;

  /** The weekly report with a module step that waits a number of seconds and may post a draft. */
  function withModule(): Record<string, unknown> {
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((candidate) => candidate.slug === "weekly-report")!;
    const pack = JSON.parse(JSON.stringify(weekly.document)) as Record<string, unknown>;
    pack["modules"] = [
      {
        slug: "post",
        name: "Post it",
        description: "Puts the approved report where people read it.",
        code: "export default async function run() { return { result: 'posted' }; }",
        manifest: {
          name: "Post it",
          description: "Puts the approved report where people read it.",
          inputs: {
            channel: { type: "string", default: "#general" },
            wait: { type: "number", description: "Seconds to wait before posting.", default: 900 },
            draft: { type: "boolean", description: "Post it as a draft.", default: true },
          },
          needs: { bin: [], env: [], network: true, item: false, comment: false, attach: false, create: false },
          results: ["posted", "failed"],
        },
        originalScript: null,
      },
    ];
    // Between Approve and Filed, so the graph stays whole.
    (pack["steps"] as Record<string, unknown>[]).push({
      id: "post",
      position: 5,
      name: "Post",
      type: "module",
      ownerRole: null,
      entryAction: "post",
      instructionsSummary: null,
      isTerminal: false,
      planMode: false,
      results: [],
    });
    const routes = pack["routes"] as Record<string, unknown>[];
    for (const route of routes) {
      if (route["fromStepId"] === "approve" && route["resultKey"] === "approved") route["target"] = "post";
    }
    routes.push({ fromStepId: "post", resultKey: "posted", label: "Posted", tone: "success", target: "filed", position: 0 });
    routes.push({ fromStepId: "post", resultKey: "failed", label: "Could not post", tone: "danger", target: "user_attention", position: 1 });
    return pack;
  }

  beforeEach(() => {
    gallery = mkdtempSync(join(tmpdir(), "eo typed gallery "));
    writeFileSync(join(gallery, "weekly-report.json"), JSON.stringify(withModule()));
  });

  afterEach(() => {
    rmSync(gallery, { recursive: true, force: true });
  });

  function typedContext() {
    return { ...context(), directory: gallery };
  }

  /** What the step ended up configured with. */
  function postInputs(pipelineId: string) {
    return listStepsForPipeline(handle.db, pipelineId).find((step) => step.name === "Post")?.inputs;
  }

  it("asks for each input as what its manifest says it is", async () => {
    const answer = await listGalleryCommand(handle.db, typedContext());
    const blanks = answer.templates.find((template) => template.slug === "weekly-report")!.blanks;

    expect(blanks.find((blank) => blank.key === "post.wait")).toMatchObject({ valueType: "number", default: "900", required: false });
    expect(blanks.find((blank) => blank.key === "post.draft")).toMatchObject({ valueType: "boolean", default: "true" });
    expect(blanks.find((blank) => blank.key === "post.channel")).toMatchObject({ valueType: "string", default: "#general" });
  });

  it("stores a number as a number and a flag as a boolean", async () => {
    const answer = await useGalleryCommand(handle.db, typedContext(), {
      ...monday(),
      answers: { ...monday().answers, "post.wait": "30", "post.draft": "false", "post.channel": "#leadership" },
    });

    expect(answer.problem).toBeNull();
    expect(postInputs(answer.pipelineId!)).toEqual({ channel: "#leadership", wait: 30, draft: false });
  });

  /**
   * And the manifest's defaults, left alone on the form, land as the
   * types the manifest wrote them in rather than as the text the field
   * showed.
   */
  it("stores the manifest's own defaults in their own types", async () => {
    const answer = await useGalleryCommand(handle.db, typedContext(), monday());

    expect(answer.problem).toBeNull();
    expect(postInputs(answer.pipelineId!)).toEqual({ channel: "#general", wait: 900, draft: true });
  });

  /**
   * The modules line, as first run meets it (EO-659): no sentence sends
   * anybody to Settings → Modules, which first run hides. Before a
   * project exists the card counts the modules; the project's needs
   * check has one line per module its steps run, whose button approves it
   * in place, and which goes green once it is approved.
   */
  it("names each module on the needs check with a button that approves it, and no hidden screen", async () => {
    const card = (await listGalleryCommand(handle.db, typedContext())).templates.find((template) => template.slug === "weekly-report")!;
    const counted = card.needs.find((need) => need.key === "modules")!;
    expect(counted.why).not.toContain("Settings");

    const answer = await useGalleryCommand(handle.db, typedContext(), monday());
    expect(answer.problem).toBeNull();
    expect(answer.needs.some((need) => need.key === "modules")).toBe(false);

    const step = listStepsForPipeline(handle.db, answer.pipelineId!).find((candidate) => candidate.name === "Post")!;
    const moduleId = step.entryAction!;
    const red = answer.needs.find((need) => need.key === `module:${moduleId}`)!;
    expect(red).toMatchObject({ line: "Post it — a module, read and approved", met: false, fix: { kind: "module", label: "Read and approve", target: moduleId } });
    for (const need of answer.needs) expect(`${need.line} ${need.why ?? ""}`).not.toMatch(/Settings|Agents →/);

    approveModule(handle.db, moduleId);
    const again = await galleryNeedsCommand(handle.db, typedContext(), { projectId: answer.projectId!, slug: "weekly-report" });
    expect(again.needs.find((need) => need.key === `module:${moduleId}`)).toMatchObject({ met: true, why: null, fix: null });
  });

  /**
   * Held to the same function the publish path and the module host
   * apply, so what a step installed with is what either of them would
   * have accepted.
   */
  it("would publish, which is the check that used to fail a week later", async () => {
    const answer = await useGalleryCommand(handle.db, typedContext(), monday());

    const step = listStepsForPipeline(handle.db, answer.pipelineId!).find((candidate) => candidate.name === "Post")!;
    const module = withModule()["modules"] as { manifest: ModuleManifest }[];
    expect(moduleInputProblems(module[0]!.manifest, step.inputs)).toEqual([]);
  });

  it("refuses a number that is not one, and writes nothing", async () => {
    const answer = await useGalleryCommand(handle.db, typedContext(), {
      ...monday(),
      answers: { ...monday().answers, "post.wait": "soon" },
    });

    expect(answer.problem).toContain("expects a number");
    expect(listProjects(handle.db)).toHaveLength(0);
  });

  it("refuses half a number rather than reading the half it understands", async () => {
    const answer = await useGalleryCommand(handle.db, typedContext(), {
      ...monday(),
      answers: { ...monday().answers, "post.wait": "12abc" },
    });

    // `parseFloat` would have taken 12 and thrown the rest away, which
    // is a step configured with half of what somebody meant.
    expect(answer.problem).toContain("expects a number");
    expect(listProjects(handle.db)).toHaveLength(0);
  });

  it("refuses a flag that is neither word", async () => {
    const answer = await useGalleryCommand(handle.db, typedContext(), {
      ...monday(),
      answers: { ...monday().answers, "post.draft": "maybe" },
    });

    expect(answer.problem).toContain("expects a boolean");
    expect(listProjects(handle.db)).toHaveLength(0);
  });
});

describe("where the pipeline came from (EO-531)", () => {
  it("records the template's slug, version and a stored snapshot of the document that was installed", async () => {
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((candidate) => candidate.slug === "weekly-report")!;
    const answer = await useGalleryCommand(handle.db, context(), monday());
    expect(answer.problem).toBeNull();

    const origin = getPipelineOrigin(handle.db, answer.pipelineId!);
    expect(origin?.slug).toBe("weekly-report");
    expect(origin?.version).toBe(weekly.version);
    expect(origin?.base).toEqual(weekly.document);
    // Every template step, mapped to the step the import minted for it.
    const steps = listStepsForPipeline(handle.db, answer.pipelineId!);
    expect(weekly.document.steps.map((step) => steps.find((candidate) => candidate.id === origin?.stepIds[step.id])?.name)).toEqual(
      weekly.document.steps.map((step) => step.name),
    );
  });

  it("records it on the seeded Delivery when first run adopts it rather than importing a twin", async () => {
    const software = bundledTemplates(GALLERY_DIRECTORY).find((candidate) => candidate.slug === "software-feature-to-merge")!;
    // The first launch has brought the seeded Delivery up to the template, as startup does before anybody reaches the gallery.
    const history = loadTemplateHistory(GALLERY_DIRECTORY);
    backfillPipelineOrigins(handle.db, history);
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const answer = await useGalleryCommand(handle.db, context(), { slug: "software-feature-to-merge", answers: { keyPrefix: "ACME" }, roleSlots: {} });
    expect(answer.problem).toBeNull();
    expect(answer.pipelineId).toBe("default");

    const origin = getPipelineOrigin(handle.db, "default");
    expect(origin?.slug).toBe("software-feature-to-merge");
    expect(origin?.version).toBe(software.version);
    expect(origin?.base).toEqual(software.document);
    expect(origin?.stepIds).toEqual(Object.fromEntries(software.document.steps.map((step) => [step.id, step.id])));
  });
});
