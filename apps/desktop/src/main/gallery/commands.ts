import {
  FOLDER_KIND,
  GIT_WORKTREE_KIND,
  PREVIEW_AGENT_KEY,
  isBoundAgent,
  isDispatchable,
  isPreviewAgent,
  parseQualifiedItemType,
  qualifiedItemType,
  type ItemTypeRef,
  uuidv7,
  type JobSchedule,
  type PipelineExport,
  type StepInputs,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import {
  adoptPipeline,
  asFolderWorkspace,
  asGitWorkspace,
  createAgent,
  createItem,
  createProject,
  keepProjectLocal,
  createWorkspace,
  folderPathProblem,
  getModule,
  getPerson,
  getPipeline,
  getProject,
  getSetting,
  hasItemType,
  isTemplateDocument,
  listAgents,
  listPipelines,
  listProjects,
  listStepsForPipeline,
  projectWorkspaceList,
  recordPipelineOrigin,
  setSetting,
  takenKeyPrefixes,
  updateStep,
  workspaceProblem,
  type Workspace,
} from "../db/repos/index.js";
import { createJob } from "../jobs/jobs.js";
import { ACTIVE_PROJECT_KEY } from "../ipc/repositoryCommands.js";
import { importPipeline, type ImportPreflight } from "../modules/pipelineTransfer.js";
import { galleryBlanks, galleryNeeds, galleryRoleSlots, stepInputValues, type GalleryNeed } from "./form.js";
import type { GalleryTemplate } from "./templates.js";

/**
 * What the two buttons on a gallery card do (EO-316,
 * `ARCHITECTURE.md`, "Preview", "The gallery").
 *
 * Preview is step 3 of first run — "the person sees the product work
 * before it asks them for anything" — and Use this is steps 4 and 5.
 * They are in one file because they are two doors into the same pack.
 */

/**
 * The mark a preview's own agent carries.
 *
 * Defined in core, beside the other two questions every reader of an
 * agent asks, because the scheduler, the import preflight and the
 * pipeline validator all have to agree about what such a row is for —
 * see `PREVIEW_AGENT_KEY` there for what it is and why. Re-exported
 * here because this is the only thing that writes one.
 */
export { PREVIEW_AGENT_KEY };

/** The one project every preview lands in, so previews do not accumulate projects. */
export const PREVIEW_PROJECT_NAME = "Preview";
const PREVIEW_KEY_PREFIX = "PRV";

/**
 * Where the gallery remembers which project is *its* preview project
 * (EO-316).
 *
 * A stored id rather than a name, and that distinction is the whole
 * entry. Project names are not unique and "Preview" is an entirely
 * ordinary thing for somebody to call one of their own — a marketing
 * team's preview environment, a rehearsal board somebody keeps. Matching
 * on the word meant that pressing Preview imported a template's
 * pipeline, its item types and its agents straight into that person's
 * real project, and the only symptom was their board growing columns
 * nobody added.
 *
 * So the gallery writes down which project it made and reads it back.
 * A stored id that no longer resolves — the project was deleted — is
 * treated as none, and a fresh one is made under a name that is free,
 * which is what `freeProjectName` is for.
 */
/**
 * Exported since EO-325, so that a test can put an installation in the
 * state this predates: a Preview project made before the keep-or-move
 * sheet existed, which must not appear on it.
 */
export const PREVIEW_PROJECT_KEY = "gallery.previewProjectId";

export type GalleryPreviewResult = { ok: true; projectId: Uuid; pipelineId: string; itemId: Uuid } | { ok: false; reason: string };

/**
 * "Preview this pipeline" (ARCHITECTURE.md, "Preview", step 3 of ARCHITECTURE.md, "What a person
 * sees first").
 *
 * Imports the pack into a preview project and files the pack's own
 * example on it, marked. The mark is what EO-313 already reads
 * everywhere: excluded from inbox counts, the archive, cost totals and
 * the `!`, dispatched to the fake provider whatever its agent says, and
 * wearing the banner on every surface that draws it.
 *
 * **Idempotent by design.** Previewing the same pack twice reuses the
 * project and the pipeline and files a second example, rather than
 * importing a second copy of the graph. A gallery where pressing
 * Preview twice produced two pipelines would punish the one gesture
 * this screen is trying to make free.
 *
 * The *same pack*, though, and that is what `previewedPipelines` is
 * about: which graph a preview walks is decided by the document's token
 * and never by what its pipeline is called. A pack republished under the
 * same slug almost always keeps its pipeline's name, and two unrelated
 * templates may both call theirs "Weekly report" — so matching on the
 * name meant an item created from version 2's example walking version
 * 1's imported graph, with nothing anywhere to say the two had come
 * apart.
 */
export function previewTemplate(db: Db, template: GalleryTemplate): GalleryPreviewResult {
  const document = template.document;
  const projectId = previewProject(db);

  const prepared = previewPipeline(db, projectId, template);
  if (!prepared.ok) return { ok: false, reason: prepared.reason };
  const pipelineId = prepared.pipelineId;

  staffForPreview(db, document);
  claimHumanSteps(db, pipelineId, document, {});

  const pipeline = getPipeline(db, pipelineId);
  const entryStepId = pipeline?.entryStepId ?? null;
  if (entryStepId === null) {
    return { ok: false, reason: `"${document.pipeline.name}" has no step for work to start on, so there is nothing to preview.` };
  }

  const example = document.previewItem;
  const type = exampleType(document);
  if (type === null) {
    return { ok: false, reason: `"${template.title}" ships no kind of work to file, so there is nothing to preview.` };
  }
  const created = createItem(db, {
    type,
    projectId,
    title: example?.title ?? `${template.title} — preview`,
    body: example?.body ?? null,
    spec: example?.spec ?? null,
    stepId: entryStepId,
    previewAt: Date.now(),
  });
  if (!created.ok) return { ok: false, reason: created.problem };

  return { ok: true, projectId, pipelineId, itemId: created.item.id };
}

/**
 * Which type the example is filed under, or null if the pack names none.
 *
 * The pack's own answer where it has one, and otherwise the first type
 * it ships — a template that authored no example still has to produce
 * something a person can watch, and its own first type is the only
 * honest guess available.
 *
 * Null rather than a fallback word, and that is the decision worth
 * stating: EO shipping `story` here would be the core naming a
 * *developer* type, which invariant #13 exists to keep out of it. A pack
 * that ships no types has nothing to file, and saying so is the only
 * true thing available.
 */
function exampleType(document: PipelineExport): ItemTypeRef | null {
  const named = document.previewItem === null ? null : parseQualifiedItemType(document.previewItem.type);
  if (named !== null) return named;
  const first = document.itemTypes[0];
  return first === undefined ? null : { packSlug: first.packSlug, slug: first.slug };
}

/**
 * Where the gallery remembers which pipeline it imported for which pack
 * (EO-316).
 *
 * Keyed by the document's **token** — see `GalleryTemplate.token` — so
 * that "the same pack, previewed again" means the same bytes rather than
 * the same words on a card. Ids that no longer resolve are dropped on
 * every read, which is what keeps this from growing into a record of
 * every pipeline the preview project has ever held.
 */
const PREVIEW_PIPELINES_KEY = "gallery.previewPipelines";

/** The pipeline this exact pack walks in the preview project, imported once. */
function previewPipeline(db: Db, projectId: Uuid, template: GalleryTemplate): { ok: true; pipelineId: string } | { ok: false; reason: string } {
  const known = previewedPipelines(db);
  const remembered = known[template.token];
  if (remembered !== undefined) {
    const pipeline = getPipeline(db, remembered);
    // On this project as well as alive: a preview project deleted and
    // remade leaves ids behind that resolve to nothing of ours.
    if (pipeline !== undefined && pipeline.archivedAt === null && pipeline.projectId === projectId) return { ok: true, pipelineId: pipeline.id };
  }

  const imported = importPipeline(db, { document: template.document, projectId, signedInBackends: [] });
  if (!imported.ok) return { ok: false, reason: imported.reason };

  setSetting(db, PREVIEW_PIPELINES_KEY, { ...known, [template.token]: imported.pipelineId });
  return { ok: true, pipelineId: imported.pipelineId };
}

/** What is remembered, minus anything that no longer resolves. */
function previewedPipelines(db: Db): Record<string, string> {
  const stored = getSetting<unknown>(db, PREVIEW_PIPELINES_KEY, {});
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};

  const live: Record<string, string> = {};
  for (const [token, pipelineId] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof pipelineId !== "string") continue;
    const pipeline = getPipeline(db, pipelineId);
    if (pipeline !== undefined && pipeline.archivedAt === null) live[token] = pipelineId;
  }
  return live;
}

/**
 * The gallery's own preview project, made once and reused.
 *
 * Identified by the id it wrote down rather than by its name — see
 * `PREVIEW_PROJECT_KEY`, where the reason is the bug it fixes.
 */
function previewProject(db: Db): Uuid {
  const remembered = previewProjectId(db);
  if (remembered !== null) return remembered;

  // Both the name and the prefix may already be somebody's, on an
  // installation that had a "Preview" before EO did. A suffix rather
  // than a refusal on either: nothing about a preview is worth stopping
  // first run over, and taking somebody's word for their own project is
  // exactly what this function exists not to do.
  const taken = takenKeyPrefixes(db);
  let prefix = PREVIEW_KEY_PREFIX;
  for (let suffix = 2; taken.has(prefix); suffix += 1) prefix = `${PREVIEW_KEY_PREFIX}${suffix}`;

  // Never the record's, whatever this machine is signed in to (EO-325,
  // ARCHITECTURE.md, "Preview"). A preview is "excluded from inbox counts, the archive, cost
  // totals and the managed record", and a project born managed because
  // somebody happened to be signed in would put a rehearsal on their
  // organisation's board — with no way to take it back off.
  const project = createProject(db, { name: freeProjectName(db, PREVIEW_PROJECT_NAME), keyPrefix: prefix, managed: false });
  // …and decided, so it never reaches the keep-or-move sheet. That
  // sheet is about the work somebody already had; asking them where
  // they would like EO's own rehearsal kept would be asking them to
  // answer for something they did not make.
  keepProjectLocal(db, project.id);
  setSetting(db, PREVIEW_PROJECT_KEY, project.id as string);
  return project.id;
}

/**
 * The project every preview lands in, or null before there is one
 * (EO-317).
 *
 * Exported because first run has to be able to tell a rehearsal from a
 * beginning: a person who pressed Preview at step 3 has a project, and
 * treating that as "this installation is set up" would drop them out of
 * the flow half way through it — with nothing of their own made.
 */
export function previewProjectId(db: Db): Uuid | null {
  const remembered = getSetting<string | null>(db, PREVIEW_PROJECT_KEY, null);
  if (remembered === null) return null;
  return getProject(db, remembered as Uuid)?.id ?? null;
}

/**
 * "Preview", "Preview 2", … — the first name no project is already
 * using.
 *
 * Names are not unique and EO does not make them so; this is politeness
 * rather than a constraint. Two projects both called "Preview" on one
 * switcher is a thing a person cannot tell apart, and the one they
 * cannot tell apart from their own is the one EO added.
 */
function freeProjectName(db: Db, wanted: string): string {
  const taken = new Set(listProjects(db).map((project) => project.name));
  if (!taken.has(wanted)) return wanted;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${wanted} ${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted} ${uuidv7()}`;
}

/**
 * Gives every agent role in the document somebody to dispatch, on
 * `fake` — see `PREVIEW_AGENT_KEY` for why this is not a lie, and why
 * nothing here writes to a row it did not create.
 *
 * Three cases, and two of them do nothing:
 *
 *  - the role has a real, bound, enabled agent → left entirely alone, so
 *    a developer previewing the software template watches it run on the
 *    agents they configured, with the preview mark doing the swapping;
 *  - the role already has a preview agent from an earlier press → reused;
 *  - otherwise a new marked row is added **beside** whatever is there.
 *
 * The third case covers the agent the import just created (unbound and
 * disabled, because nothing is signed in) and the agent a person has
 * switched off, and it treats them identically: it does not touch
 * either. Two rows for one role is fine — `isDispatchable` is what the
 * scheduler filters on, and only one of them passes it.
 */
function staffForPreview(db: Db, document: PipelineExport): void {
  const roles = [...new Set(document.steps.filter((step) => step.type === "agent" && step.ownerRole !== null).map((step) => step.ownerRole as string))];
  // Global agents only (EO-474): a preview walks on the preview's own
  // project, which no agent is ever scoped to, so a project's own agent
  // cannot run it and must not be what leaves the role unstaffed here.
  const live = listAgents(db).filter((agent) => agent.archivedAt === null && agent.projectId === null);

  for (const role of roles) {
    const mine = live.filter((agent) => agent.role === role);
    // Somebody's own agent that can already run — left entirely alone,
    // and used as it is: the preview mark is what swaps it onto `fake`
    // for the run (EO-313), so a developer watches the template on the
    // agents they configured.
    if (mine.some((agent) => !isPreviewAgent(agent) && isDispatchable(agent) && isBoundAgent(agent))) continue;
    // One of ours from an earlier press. Reused rather than duplicated.
    if (mine.some(isPreviewAgent)) continue;

    const carried = document.roles.find((entry) => entry.slug === role);
    createAgent(db, {
      name: `${role} (preview)`,
      role,
      provider: "fake",
      instructions: carried?.prompt ?? "",
      config: { [PREVIEW_AGENT_KEY]: true },
      enabled: true,
    });
  }
}

/**
 * Puts a person on every human step of the imported pipeline (the original design).
 *
 * "In solo mode the approver slot is pre-filled with 'you' and hidden."
 * `chosen` is what the form sent for each slot, keyed by the document's
 * own step id; the local person is who solo mode means, and
 * `localPerson` is already what an unowned human step falls back to, so
 * an empty map leaves the pipeline behaving exactly as it would have.
 *
 * Matched by **position**, because `importPipeline` re-mints every step
 * id — a document's `approve` is a fresh uuid on the far side, and
 * position is what survives.
 *
 * Every id here has already been checked against `people` by
 * `roleSlotProblem`, which is why this writes a `Uuid` without asking:
 * the foreign key is the backstop, not the gate, and a gate that ran
 * here would refuse in the middle of an install rather than before it.
 * Preview passes an empty map and so reaches none of this.
 */
function claimHumanSteps(db: Db, pipelineId: string, document: PipelineExport, chosen: Record<string, string>): void {
  const written = new Map(listStepsForPipeline(db, pipelineId).map((step) => [step.position, step]));
  for (const slot of galleryRoleSlots(document)) {
    const personId = chosen[slot.stepId];
    if (personId === undefined || personId === "") continue;
    const source = document.steps.find((step) => step.id === slot.stepId);
    const target = source === undefined ? undefined : written.get(source.position);
    if (target !== undefined) updateStep(db, target.id, { ownerPersonId: personId as Uuid });
  }
}

export interface UseTemplateInput {
  template: GalleryTemplate;
  /** What the person typed, keyed by `GalleryBlank.key`. */
  answers: Record<string, string>;
  /**
   * Who fills each role slot, keyed by the document's step id.
   *
   * Person **ids**, checked against `people` before anything is written
   * (`roleSlotProblem`) — the form offers a picker rather than a box for
   * exactly that reason. In solo mode the caller replaces whatever
   * arrived with the one person there is, so this is decided in the main
   * process either way.
   */
  roleSlots: Record<string, string>;
  /** The project's name. Defaults to the template's title, which is what the card said. */
  projectName?: string;
  /** The backends this machine is signed in to, so an imported role binds where it can (ARCHITECTURE.md, "An agent is a row"). */
  signedInBackends?: readonly string[];
}

export type UseTemplateResult =
  | { ok: true; projectId: Uuid; pipelineId: string; workspaceId: Uuid | null; jobId: Uuid | null; needs: GalleryNeed[] }
  | { ok: false; reason: string };

/**
 * "Use this" — the project, the workspace, the pipeline, the agents, the
 * job and the item types, in one step (ARCHITECTURE.md, "The gallery" into "The needs check").
 *
 * One step because that is what the story asks for and because the
 * alternative is worse than it sounds: a person who answered five
 * questions and got a project with no pipeline on it has been left
 * halfway through something they cannot finish by hand.
 *
 * **One transaction, too.** Everything that can be checked without
 * writing is checked first — the key prefix, the folder path, the
 * schedule, and who each role slot names — and then the writes happen
 * inside a single transaction that a throw rolls back whole. Both halves
 * are load-bearing and neither is sufficient alone: checking first is
 * what turns a foreign key into a sentence, and the transaction is what
 * catches the ways a write can still fail once it is under way. Without
 * it, an installation could be left holding a project, a workspace and a
 * pipeline for a template it was told it had not installed — a half-made
 * thing nobody asked for and nobody can finish by hand.
 *
 * Nested transactions are savepoints under better-sqlite3, so the calls
 * below that open their own — `createProject`, `importPipeline`,
 * `createJob` — compose rather than collide.
 */
export function useTemplate(db: Db, input: UseTemplateInput): UseTemplateResult {
  const { template, answers } = input;
  const document = template.document;
  const blanks = galleryBlanks(document);

  const missing = blanks.filter((blank) => blank.required && (answers[blank.key] ?? blank.default).trim() === "");
  if (missing.length > 0) return { ok: false, reason: `${missing.map((blank) => `"${blank.label}"`).join(", ")} still needs an answer.` };

  const answer = (key: string): string => (answers[key] ?? blanks.find((blank) => blank.key === key)?.default ?? "").trim();
  const keyPrefixBlank = blanks.find((blank) => blank.kind === "keyPrefix");
  const keyPrefix = (keyPrefixBlank === undefined ? "" : answer(keyPrefixBlank.key)).toUpperCase();
  if (!/^[A-Z][A-Z0-9]*$/.test(keyPrefix)) {
    return { ok: false, reason: "A key prefix is letters and digits, starting with a letter — REP, DOC2." };
  }
  if (takenKeyPrefixes(db).has(keyPrefix)) {
    return { ok: false, reason: `${keyPrefix} is already in use by another project, and a prefix numbers exactly one project's items.` };
  }

  const folderBlank = blanks.find((blank) => blank.kind === "folder");
  const folder = folderBlank === undefined ? null : answer(folderBlank.key);
  if (folder !== null && folder !== "") {
    const problem = folderPathProblem(folder);
    if (problem !== null) return { ok: false, reason: problem };
  }

  const scheduleBlank = blanks.find((blank) => blank.kind === "schedule");
  const scheduleText = scheduleBlank === undefined ? "" : answer(scheduleBlank.key);
  const schedule = scheduleText === "" ? null : parseScheduleAnswer(scheduleText);
  if (scheduleText !== "" && schedule === null) {
    return { ok: false, reason: `"${scheduleText}" is not a day and a time — write it as "monday 08:00" or "daily 08:00".` };
  }

  // What each module step will be given, in the types its manifest
  // declares, before anything is written (EO-316).
  //
  // The form answers in text and `pipeline_steps.inputs` holds typed
  // values, so somebody has to read "900" as 900 — and a value that is
  // not the declared type has to be refused *here*. Left to the row it
  // installed clean and the step's first real run was refused by
  // `moduleInputProblems` for a mismatch nobody could trace, which is
  // the worst place to find out.
  const inputs = stepInputValues(document, blanks, answers);
  if (!inputs.ok) return { ok: false, reason: inputs.problems.join(" ") };

  // Who each role slot names, before anything is written.
  //
  // `pipeline_steps.owner_person_id` is a foreign key, so an id nobody
  // has is a constraint failure rather than a refusal — and one that
  // arrives at the *end*, after the project, the workspace and the
  // pipeline already exist. The transaction below would now roll that
  // back, which is the difference between a half-made installation and
  // none; this is what turns it into a sentence somebody can act on
  // instead of "that could not be imported: FOREIGN KEY constraint
  // failed".
  const slotProblem = roleSlotProblem(db, document, input.roleSlots);
  if (slotProblem !== null) return { ok: false, reason: slotProblem };

  // Whether this installation is already holding the very pipeline this
  // document is an export of (EO-317). Read before anything is written,
  // because the answer is partly "and there is no project yet".
  const already = pipelineAlreadyHere(db, document);

  const files = schedule === null ? null : jobItemType(document);
  if (schedule !== null && files === null) {
    return { ok: false, reason: `"${template.title}" asks when to run but ships no kind of work to file, so a job would have nothing to make.` };
  }

  try {
    return db.transaction(() => {
      // **Nothing is done about the preview's own agents here**, and that
      // is a change worth stating (EO-316).
      //
      // An earlier cut archived every marked row, because a preview
      // agent sat in the ordinary pool and would otherwise have answered
      // "is `reporter` filled?" on the needs check of the project about
      // to be made. That fixed one thing and broke a worse one: a
      // preview still walking — somebody pressed Preview, liked it, and
      // pressed Use this a moment later — lost the agent its next step
      // needs, and stalled forever with nothing said.
      //
      // `staffsItem` is the real answer, and it is in core: a preview's
      // agent runs previews and nothing else, so it staffs no role here,
      // silences no warning, and fills no line. There is nothing left
      // for this to clear up, and the rehearsal on screen keeps running.
      const project = createProject(db, { name: (input.projectName ?? template.title).trim() || template.title, keyPrefix });
      // And the window looks at it (EO-316).
      //
      // `activeProjectId` keeps whatever was stored as long as it still
      // resolves, so on any installation that already had a project the
      // one just created was not the one on screen: the sidebar listed
      // somebody else's pipelines, the board drew their work, and "Go to
      // the board" opened it. A person who has just answered three
      // questions about a template is looking at that template next.
      //
      // Inside the transaction with the row it names, so a refusal
      // further down does not leave the window pointed at a project that
      // was rolled back.
      setSetting(db, ACTIVE_PROJECT_KEY, project.id as string);

      let workspaceId: Uuid | null = null;
      if (folder !== null && folder !== "") {
        const workspace = createWorkspace(db, {
          projectId: project.id,
          kind: FOLDER_KIND,
          config: { path: folder, perItemSubfolder: true },
          position: projectWorkspaceList(db, project.id).length,
        });
        workspaceId = workspace.id;
      }

      // Thrown rather than returned from here on, because this is inside
      // the transaction and a `return` would commit what came before it.
      // Caught below and answered as a reason, so the channel still
      // promises a typed result rather than an exception.
      let pipelineId: string;
      if (already === null) {
        const imported = importPipeline(db, { document, projectId: project.id, signedInBackends: input.signedInBackends ?? [] });
        if (!imported.ok) throw new UseRefused(imported.reason);
        pipelineId = imported.pipelineId;
      } else {
        // The pipeline this document *is*, adopted rather than copied —
        // see `pipelineAlreadyHere` for what that costs and what it
        // saves.
        adoptPipeline(db, already, project.id);
        pipelineId = already;
        // And it remembers the template version it now is (EO-531).
        // Adopting skips the import, which is where an origin is
        // otherwise recorded. The steps are the document's own by id —
        // that is what `pipelineAlreadyHere` matched on — so the map is
        // each id to itself.
        if (isTemplateDocument(document)) {
          recordPipelineOrigin(db, { pipelineId, document, stepIds: Object.fromEntries(document.steps.map((step) => [step.id, step.id])) });
        }
      }

      writeStepInputs(db, pipelineId, document, inputs.byStep);
      claimHumanSteps(db, pipelineId, document, input.roleSlots);

      let jobId: Uuid | null = null;
      if (schedule !== null) {
        const created = createJob(db, {
          projectId: project.id,
          name: template.title,
          trigger: { kind: "schedule", schedule, timeZone: localTimeZone(), catchUpWithinMinutes: 180 },
          pipelineId,
          template: { type: files as string, title: template.title, body: null },
        });
        // A schedule somebody typed and EO could not honour is the one
        // thing on this form they would not discover for a week.
        if (!created.ok) throw new UseRefused(created.problem);
        jobId = created.job.id as Uuid;
      }

      return { ok: true as const, projectId: project.id, pipelineId, workspaceId, jobId, needs: [] };
    });
  } catch (error) {
    // Nothing was written: the throw above rolled the transaction back.
    if (error instanceof UseRefused) return { ok: false, reason: error.message };
    return { ok: false, reason: `That template could not be installed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The pipeline this document *is*, where this installation is still
 * holding it and has nothing of its own yet (EO-317).
 *
 * The developer's first run is what this exists for. "Software feature
 * to merge" is generated from `exportPipeline(db, "default")` — it is
 * the Delivery board EO seeds every installation with, as a pack — so
 * installing it wrote a *second* Delivery into the rail beside the one
 * already there, both drawn from the same steps. The acceptance
 * criterion is that a developer "reaches the same board it reaches
 * today", and two boards called Delivery is not that.
 *
 * So on a fresh installation the seeded pipeline is **adopted** —
 * given the project that was just made — rather than copied. Four
 * conditions, and every one of them is load-bearing:
 *
 *  - **Nothing of their own yet.** A preview project does not count; it
 *    is step 3 of the flow. On any installation that has a real project,
 *    an unadopted pipeline is shown to *every* project (see
 *    `listPipelines`), so adopting it would take a board away from the
 *    others — which is a change to somebody's window they did not ask
 *    for, to avoid a duplicate they might have wanted.
 *  - **Unadopted.** A pipeline that belongs to a project is that
 *    project's, and this is not a way to move one.
 *  - **The same steps, by id.** Not by name: two templates may both call
 *    a pipeline "Delivery", and a name is what a person edits. Ids
 *    survive an export and are re-minted by an import, so an equal set
 *    of them is the strongest available statement that this document was
 *    taken from that pipeline.
 *  - **Everything else it ships is here already** — its roles have
 *    agents and its types exist — because adopting skips the import, and
 *    an import is what would otherwise have written them.
 */
function pipelineAlreadyHere(db: Db, document: PipelineExport): string | null {
  if (document.steps.length === 0) return null;
  const preview = previewProjectId(db);
  if (listProjects(db).some((project) => project.id !== preview)) return null;

  const live = listAgents(db).filter((agent) => agent.archivedAt === null && !isPreviewAgent(agent));
  const rolesHere = document.steps
    .filter((step) => step.type === "agent" && step.ownerRole !== null)
    .every((step) => live.some((agent) => agent.role === step.ownerRole));
  if (!rolesHere) return null;
  if (!document.itemTypes.every((type) => hasItemType(db, null, type.packSlug, type.slug))) return null;

  const wanted = new Set(document.steps.map((step) => step.id));
  for (const pipeline of listPipelines(db)) {
    if (pipeline.projectId !== null) continue;
    const steps = listStepsForPipeline(db, pipeline.id);
    if (steps.length !== wanted.size) continue;
    if (steps.every((step) => wanted.has(step.id))) return pipeline.id;
  }
  return null;
}

/**
 * A refusal raised from inside the transaction.
 *
 * A throw rather than a return because a `return` from inside
 * `db.transaction` commits, and the reason has to travel out with the
 * rollback. Its own class so that a refusal EO composed is told apart
 * from a genuine failure — a constraint, a disk — which deserves a
 * different sentence.
 */
class UseRefused extends Error {}

/**
 * What is wrong with who the form named, or null (ARCHITECTURE.md, "The gallery").
 *
 * Every value is checked, including the ones solo mode filled in, so
 * there is one answer to "is this a person" rather than one per caller.
 * An empty value is not a problem: a slot nobody was chosen for is a
 * human step that waits for whoever is there, which is what an unowned
 * one already does.
 */
function roleSlotProblem(db: Db, document: PipelineExport, chosen: Record<string, string>): string | null {
  const slots = galleryRoleSlots(document);
  for (const [stepId, personId] of Object.entries(chosen)) {
    if (personId.trim() === "") continue;
    const slot = slots.find((candidate) => candidate.stepId === stepId);
    if (slot === undefined) return `This template has no step called "${stepId}" for anybody to be put on.`;
    if (getPerson(db, personId as Uuid) === undefined) {
      return `"${slot.name}" names somebody EO does not know. Choose a person from the list.`;
    }
  }
  return null;
}

/** The step inputs the form answered, laid onto the imported steps (ARCHITECTURE.md, "The gallery"). */
function writeStepInputs(db: Db, pipelineId: string, document: PipelineExport, byStep: ReadonlyMap<string, StepInputs>): void {
  const written = new Map(listStepsForPipeline(db, pipelineId).map((step) => [step.position, step]));

  for (const [stepId, inputs] of byStep) {
    const source = document.steps.find((step) => step.id === stepId);
    const target = source === undefined ? undefined : written.get(source.position);
    if (target !== undefined) updateStep(db, target.id, { inputs });
  }
}

/** What a scheduled job files: the pack's example type, or the first type it ships. Null for `exampleType`'s reason. */
function jobItemType(document: PipelineExport): string | null {
  if (document.previewItem !== null) return document.previewItem.type;
  const first = document.itemTypes[0];
  return first === undefined ? null : qualifiedItemType(first);
}

/**
 * `"monday 08:00"` and `"daily 08:00"`, which is what the form sends.
 *
 * A pair of words rather than a cron expression, because ARCHITECTURE.md, "The gallery"'s blank is
 * "which day" and a person choosing a day from a list should not have
 * their answer round-tripped through a syntax they never saw. Cron is
 * still available on the Job page for anybody who wants it.
 */
export function parseScheduleAnswer(text: string): JobSchedule | null {
  const match = /^([a-z]+)\s+(\d{1,2}):(\d{2})$/i.exec(text.trim());
  if (match === null) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) return null;

  const day = match[1]!.toLowerCase();
  if (day === "daily") return { kind: "daily", hour, minute };
  const weekday = WEEKDAYS.indexOf(day);
  return weekday === -1 ? null : { kind: "weekly", weekday, hour, minute };
}

/** Sunday 0 — cron's numbering, which `WeeklyScheduleSchema` states. */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The zone the schedule means, which is this machine's — see `ScheduleTriggerSchema` for why it is stored. */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The needs check's lines for a project that exists (EO-317, ARCHITECTURE.md, "The needs check").
 *
 * Read against the **project** rather than reported back from the
 * install, which is the difference between a screen that can be fixed
 * and one that can only be left. "Fixing it turns the line green
 * without leaving the screen" needs an answer that can be asked again:
 * a folder somebody has just chosen, a backend they have just signed
 * in to, a connector they have just authorised. So every line here is
 * derived on each read — from the preflight for what the pack wants,
 * and from the database and the disk for what this machine has.
 *
 * Two lines are added to the pack's own, because two things are true of
 * every template and are facts about the installation rather than about
 * the document: somewhere to work, and something to work with.
 */
export function projectNeeds(db: Db, input: ProjectNeedsInput): GalleryNeed[] {
  return [
    // The document's count of modules is what a card and an import can
    // say before anything is written. Once the project exists, each
    // module its steps run is a line of its own, green once approved.
    ...galleryNeeds(
      input.preflight,
      [workspaceNeed(db, input.projectId, input.document), backendNeed(input.preflight, input.signedInBackends)],
      // What a role could be pointed at, which decides whether its red
      // line carries a sign-in or the one gesture that staffs it.
      input.signedInBackends,
    ).filter((need) => need.key !== "modules"),
    ...moduleNeeds(db, input.projectId),
  ];
}

/**
 * One line per module this project's steps run (EO-659), read off the
 * steps rather than the document: an import may have reused a module
 * already here or renamed the incoming one, and the line is about the
 * module that will actually run. Its button reads and approves it in
 * place, because the screen where modules are otherwise approved is
 * one first run hides.
 */
function moduleNeeds(db: Db, projectId: Uuid): GalleryNeed[] {
  const ids = new Set<string>();
  for (const pipeline of listPipelines(db, projectId)) {
    for (const step of listStepsForPipeline(db, pipeline.id)) {
      if (step.type === "module" && step.entryAction !== null) ids.add(step.entryAction);
    }
  }
  return [...ids].flatMap((id): GalleryNeed[] => {
    const module = getModule(db, id);
    if (module === undefined) return [];
    const met = module.approvedAt !== null;
    return [
      {
        key: `module:${module.id}`,
        line: `${module.name} — a module, read and approved`,
        met,
        why: met ? null : "A module is code from somebody else's machine. EO runs none of it until you have read it and approved it.",
        fix: met ? null : { kind: "module", label: "Read and approve", target: module.id },
      },
    ];
  });
}

export interface ProjectNeedsInput {
  /** The pack, which says what kind of disk its work happens on and which backend it was built for. */
  document: PipelineExport;
  preflight: ImportPreflight;
  projectId: Uuid;
  signedInBackends: readonly string[];
}

/**
 * Whether this pack's work happens in a checkout rather than in a
 * folder (EO-317).
 *
 * Asked of the document, in two steps, and neither of them is EO
 * guessing at a domain:
 *
 *  - a template that wants a folder **says so in its own blanks**, and
 *    "Use this" already made it one, so the line is about that folder;
 *  - otherwise a `builtin` step is a step some installed *code* pack
 *    runs, and the only code pack EO ships — the developer pack — cuts
 *    worktrees from a git checkout.
 *
 * The second half is the developer template's whole case and is written
 * as the fallback rather than as a special case for a slug, so the day a
 * pack contributes builtins that work in a folder, what changes is this
 * sentence and not a list of template names.
 */
function wantsRepository(document: PipelineExport): boolean {
  if ((document.template?.blanks ?? []).some((blank) => blank.kind === "folder")) return false;
  return document.steps.some((step) => step.type === "builtin");
}

/**
 * Somewhere the work happens, and why it is not there (ARCHITECTURE.md, "The needs check").
 *
 * Two red states with different sentences and one button, because they
 * are genuinely different situations for the person in front of them: a
 * project that was never given a disk, and one whose disk has been
 * renamed, unmounted or deleted since. The second is the one the story
 * names — "a red needs line for a missing folder shows the path" — and
 * it is `workspaceProblem` that says so, in the words it already uses on
 * the Workspaces screen rather than in a second opinion composed here.
 */
function workspaceNeed(db: Db, projectId: Uuid, document: PipelineExport): GalleryNeed {
  const repository = wantsRepository(document);
  const attached = projectWorkspaceList(db, projectId).filter((workspace) => !repository || workspace.kind === GIT_WORKTREE_KIND);
  const line = repository ? "A repository — the checkout its work happens in" : "A folder — somewhere its work happens";
  const fix = repository
    ? { kind: "repository" as const, label: "Choose a repository" }
    : { kind: "folder" as const, label: "Choose folder" };

  const working = attached.find((workspace) => workspaceProblem(workspace) === null);
  if (working !== undefined) return { key: "workspace", line, met: true, why: null, fix: null };

  const broken = attached[0];
  if (broken === undefined) {
    return {
      key: "workspace",
      line,
      met: false,
      why: repository
        ? "This project has no repository yet, so nothing can be branched, reviewed or opened as a pull request."
        : "This project has nowhere to work yet, so nothing it files has anywhere to be written.",
      fix: { ...fix, target: "" },
    };
  }
  return {
    key: "workspace",
    line,
    met: false,
    // The path is in this sentence because it is the one thing that
    // makes it actionable: "EO cannot see it" about an unnamed
    // directory is a line nobody can check.
    why: workspaceProblem(broken),
    fix: { ...fix, target: workspacePath(broken) },
  };
}

/** Where a workspace says it is, for the field the fix button fills in. */
function workspacePath(workspace: Workspace): string {
  return asGitWorkspace(workspace)?.config.repoPath ?? asFolderWorkspace(workspace)?.config.path ?? "";
}

/**
 * Something to work with (ARCHITECTURE.md, "The needs check").
 *
 * The pack's own recommendation where it made one, because "sign in to
 * something" is not a sentence a person can act on and "sign in to
 * Claude, which this pack was built on" is. Where the pack recommends
 * nothing, the button opens the sign-in for whatever this machine has.
 */
function backendNeed(preflight: ImportPreflight, signedInBackends: readonly string[]): GalleryNeed {
  const recommended = preflight.roleSlots.map((slot) => slot.recommendedBackend).find((backend) => backend !== null) ?? null;
  const met = signedInBackends.length > 0;
  return {
    key: "backend",
    line: "A coding agent signed in",
    met,
    why: met
      ? null
      : recommended === null
        ? "Nothing on this machine is signed in, so no step would dispatch."
        : `Nothing on this machine is signed in, and this pack was built on ${recommended}.`,
    fix: met ? null : { kind: "backend", label: "Sign in", target: recommended },
  };
}
