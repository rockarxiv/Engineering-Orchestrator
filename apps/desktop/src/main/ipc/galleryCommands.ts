import { basename } from "node:path";
import {
  FOLDER_KIND,
  GIT_WORKTREE_KIND,
  isBoundAgent,
  isDispatchable,
  isPreviewAgent,
  sectionLockedLine,
  withMemoryNoteGrant,
  type IpcPayload,
  type IpcResponse,
  type PipelineExport,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { sectionLockFor } from "../managed/locks.js";
import {
  addWorkspaceToProject,
  createAgent,
  createGitWorkspace,
  createWorkspace,
  folderPathProblem,
  getProject,
  isSoloMode,
  listAgents,
  listGitWorkspaces,
  listJobs,
  listPeople,
  listPipelines,
  localPerson,
  projectWorkspaceList,
  updateAgent,
  updateWorkspace,
  workspaceProblem,
} from "../db/repos/index.js";
import { isAdopting } from "../db/repos/projectsRepo.js";
import { forgeCardNeed, galleryBlanks, galleryNeeds, galleryRoleSlots, repositoryAnswer } from "../gallery/form.js";
import { forgeNeeds, type DetectForge } from "../gallery/forgeNeeds.js";
import { previewTemplate, projectNeeds, useTemplate } from "../gallery/commands.js";
import { firstItemBrief } from "../gallery/firstItemBrief.js";
import { openBriefedAssist } from "./assistCommands.js";
import type { EngineHandle } from "./domainCommands.js";
import { listedByToken, listedTemplate, rememberListed } from "../gallery/session.js";
import { bundledTemplates, listGalleryTemplates, type GalleryOptions, type GalleryTemplate } from "../gallery/templates.js";
import { preflightImport } from "../modules/pipelineTransfer.js";
import { detectForge } from "./forgeCommands.js";
import type { ModuleSecretsOptions } from "../modules/secrets.js";
import { noteFirstRunProject } from "../firstRun/firstRun.js";
import { activeProjectId, movingProjectRefusal, repositoryPathProblem } from "./repositoryCommands.js";
import { listPeopleCommand } from "./identityCommands.js";
import type { ManagedDirectory } from "../managed/directory.js";
import { ensurePerson, getPerson } from "../db/repos/peopleRepo.js";
import { rememberedOrganisationPeople } from "../managed/session.js";

/**
 * The gallery's channels (EO-316, EO-317, `ARCHITECTURE.md`,
 * "What a person sees first").
 *
 * Commands rather than closures in `handlers.ts` for the reason every
 * other `*Commands.ts` here is one: the interesting half — what a card
 * says, what "Use this" writes — is testable against an in-memory
 * database with no Electron anywhere near it, and a handler that held
 * the logic would only be testable through a window.
 */

export interface GalleryContext extends GalleryOptions {
  /** For the preflight every card's "what this needs" is derived from. */
  moduleSecrets: ModuleSecretsOptions;
  /** What a pack's recommendation is measured against (ARCHITECTURE.md, "An agent is a row"). */
  signedInBackends: readonly string[];
  /**
   * How this desktop reaches its organisation, when it is signed in to
   * one (EO-661). Its people are who a role slot may be given to; absent
   * on a server, which answers from its own rows.
   */
  managed?: ManagedDirectory;
  /** How a repository's forge CLI is checked (EO-663): `forge:detect`, unless a test says otherwise. */
  detectForge?: DetectForge;
}

/**
 * Who a role slot may be given to, and whether the picker is hidden
 * (ARCHITECTURE.md, "The gallery").
 *
 * On a desktop signed in to an organisation, the organisation's list —
 * the same `people:list` the item picker reads — because the local
 * table holds only this machine's own person until somebody is
 * assigned, and a first run that has just signed in would otherwise
 * offer nobody (EO-661). Otherwise this machine's rows, and none at all
 * in solo mode: EO-302 settled that solo mode displays no names.
 *
 * Signed in is never solo, whether or not the server answered this
 * time. A list that could not be fetched is answered from the last one
 * the organisation gave (`rememberedOrganisationPeople`), and `reached`
 * says so: falling back to the local table would read a fresh desktop's
 * one row as solo mode, and solo mode replaces every slot the person
 * chose with themselves.
 */
async function rolePeople(
  db: Db,
  context: GalleryContext,
): Promise<{ solo: boolean; people: { id: string; name: string }[]; organisation: boolean; reached: boolean }> {
  if (context.managed?.client() != null) {
    const list = await listPeopleCommand(db, { managed: context.managed });
    if (list.fromServer) {
      return { solo: false, people: list.people.map((person) => ({ id: person.id, name: person.name })), organisation: true, reached: true };
    }
    return { solo: false, people: rememberedOrganisationPeople(db), organisation: true, reached: false };
  }
  const solo = isSoloMode(db);
  return { solo, people: solo ? [] : listPeople(db).map((person) => ({ id: person.id, name: person.name })), organisation: false, reached: true };
}

/** Said when a chosen colleague cannot be named because the organisation could not be asked. Nothing is created. */
const ORGANISATION_UNREACHABLE =
  "EO could not reach your organisation just now, so it cannot say who you chose for a role. Nothing was created; try again in a moment.";

/**
 * The cards (ARCHITECTURE.md, "The gallery").
 *
 * `fetched` says whether the index answered, and nothing here can
 * produce a problem: an offline first run shows the bundled set, which
 * is the whole reason there is a bundled set.
 */
export async function listGalleryCommand(db: Db, context: GalleryContext): Promise<IpcResponse<"gallery:list">> {
  const templates = await listGalleryTemplates(context);
  // Held, so that a card's own buttons act on the document it was drawn
  // from rather than on whatever a second fetch returns — see
  // `gallery/session.ts`, where the two ways that goes wrong are
  // written down.
  rememberListed(templates);
  const { solo, people } = await rolePeople(db, context);
  return {
    templates: templates.map((template) => cardOf(db, template, context, solo)),
    // Bundled entries all carry `bundled: true`, so anything else came
    // off the wire. Derived rather than reported separately, because two
    // sources for one fact is one too many.
    fetched: templates.some((template) => !template.bundled),
    // Who a role slot may be given to (ARCHITECTURE.md, "The gallery").
    //
    // On this answer rather than behind a channel of its own, because
    // the form is the only thing that asks and a channel with one caller
    // is a channel to keep in step with one screen. Empty in solo mode,
    // and deliberately: EO-302 settled that solo mode displays no names,
    // the picker is hidden there, and sending the one person's name for
    // a control nobody draws would be EO putting a name on the wire for
    // nothing. A signed-in desktop offers its organisation's people.
    people,
  };
}

/** One card, with its needs derived from the same preflight the needs check reads (ARCHITECTURE.md, "The needs check"). */
function cardOf(db: Db, template: GalleryTemplate, context: GalleryContext, solo: boolean): IpcResponse<"gallery:list">["templates"][number] {
  const preflight = preflightImport(db, context.moduleSecrets, template.document, {
    projectId: activeProjectId(db),
    signedInBackends: context.signedInBackends,
  });
  return {
    slug: template.slug,
    token: template.token,
    title: template.title,
    description: template.description,
    version: template.version,
    source: template.source,
    bundled: template.bundled,
    pipelineName: template.document.pipeline.name,
    // The forge CLI line too, before any repository says which (EO-663).
    needs: galleryNeeds(preflight, forgeCardNeed(template.document)),
    blanks: galleryBlanks(template.document),
    roleSlots: galleryRoleSlots(template.document),
    solo,
    previewable: template.document.previewItem !== null || template.document.itemTypes.length > 0,
  };
}

export async function previewGalleryCommand(db: Db, context: GalleryContext, payload: IpcPayload<"gallery:preview">): Promise<IpcResponse<"gallery:preview">> {
  const template = await find(context, payload.slug, payload.token);
  if (template === null) return { itemId: null, projectId: null, pipelineId: null, problem: missing(payload.slug, payload.token) };

  const result = previewTemplate(db, template);
  if (!result.ok) return { itemId: null, projectId: null, pipelineId: null, problem: result.reason };
  // The board as well as the item (EO-317): "Continue with Preview only"
  // lands on the columns with the marked card in them, and only this
  // call knows which pipeline the rehearsal was imported onto.
  return { itemId: result.itemId, projectId: result.projectId, pipelineId: result.pipelineId, problem: null };
}

/**
 * "Use this" (ARCHITECTURE.md, "The gallery" into "The needs check").
 *
 * The role slots are filled here rather than on the form when this
 * installation is solo: "the picker is pre-filled with 'you' and
 * hidden", and the one person is who "you" is. Done in the main process
 * because that is where the person's id is — a renderer that had to be
 * told who it was in order to hide a control would be a renderer
 * carrying an identity it has no other use for.
 */
export async function useGalleryCommand(db: Db, context: GalleryContext, payload: IpcPayload<"gallery:use">): Promise<IpcResponse<"gallery:use">> {
  const template = await find(context, payload.slug, payload.token);
  if (template === null) return { projectId: null, pipelineId: null, jobId: null, needs: [], problem: missing(payload.slug, payload.token) };

  const roleSlots = { ...payload.roleSlots };
  const who = await rolePeople(db, context);
  if (who.solo) {
    const you = localPerson(db).id as Uuid;
    for (const slot of galleryRoleSlots(template.document)) roleSlots[slot.stepId] = you;
  } else if (who.organisation) {
    // A colleague off the organisation's list may be nobody this
    // database has a row for yet, and a step's owner is a row here. The
    // row is written under the record's own id, as `knowAssignee` does
    // for an assignment, so the record and this machine name them alike.
    // Resolved before anything is written: a colleague neither list
    // names, while the server cannot be asked, is refused here rather
    // than dropped or swapped for somebody else.
    const colleagues: { id: string; name: string }[] = [];
    for (const personId of Object.values(roleSlots)) {
      if (personId.trim() === "" || getPerson(db, personId as Uuid) !== undefined) continue;
      const colleague = who.people.find((person) => person.id === personId);
      if (colleague !== undefined) colleagues.push(colleague);
      else if (!who.reached) return { projectId: null, pipelineId: null, jobId: null, needs: [], problem: ORGANISATION_UNREACHABLE };
    }
    for (const colleague of colleagues) ensurePerson(db, colleague.id as Uuid, colleague.name);
  }

  // The repository the form asked for (EO-662), checked before anything
  // is written — a path git does not know, or one EO already holds, is a
  // sentence on the form rather than a project with a red line.
  const repository = repositoryAnswer(template.document, payload.answers);
  if (repository !== "") {
    const problem = (await repositoryPathProblem(repository)) ?? (listGitWorkspaces(db).some((workspace) => workspace.config.repoPath === repository) ? `${repository} is already attached to EO as a repository.` : null);
    if (problem !== null) return { projectId: null, pipelineId: null, jobId: null, needs: [], problem };
  }

  const result = useTemplate(db, {
    template,
    answers: payload.answers,
    roleSlots,
    ...(payload.projectName === undefined ? {} : { projectName: payload.projectName }),
    signedInBackends: context.signedInBackends,
  });
  if (!result.ok) return { projectId: null, pipelineId: null, jobId: null, needs: [], problem: result.reason };

  // The project this made does not end first run (EO-317): the needs
  // check is step 5, its lines are this call's own answer, and a flow
  // that ended itself at step 4 would take that screen away at the
  // moment it was produced. See `noteFirstRunProject`.
  noteFirstRunProject(db, result.projectId);

  // Through the needs check's own door, onto the project just made. A
  // refusal now (the path vanished meanwhile) leaves the repository line
  // red with its reason, which is where it is answered.
  if (repository !== "") await attachWorkspaceCommand(db, { projectId: result.projectId, path: repository, kind: "git" });

  // Preflighted again, against the project that now exists, because that
  // is the only reading that can answer the design's lines: which types landed,
  // which connectors are still disconnected, which roles the import left
  // unstaffed.
  return {
    projectId: result.projectId,
    pipelineId: result.pipelineId,
    jobId: result.jobId,
    needs: await needsOf(db, context, template.document, result.projectId),
    problem: null,
  };
}

/**
 * The needs check, read again (EO-317, ARCHITECTURE.md, "The needs check").
 *
 * The same lines `gallery:use` answered with, asked a second, third and
 * fourth time — after a folder is chosen, after a sign-in, after a
 * connector is authorised. That is what "fixing it turns the line green
 * without leaving the screen" is made of: the screen does not patch the
 * line it acted on, it asks the question again, so what it draws is
 * always what the machine would say to anybody else asking.
 */
export async function galleryNeedsCommand(db: Db, context: GalleryContext, payload: IpcPayload<"gallery:needs">): Promise<IpcResponse<"gallery:needs">> {
  const template = await find(context, payload.slug, payload.token);
  if (template === null) return { needs: [], jobId: null, problem: missing(payload.slug, payload.token) };

  const projectId = payload.projectId as Uuid;
  if (getProject(db, projectId) === undefined) return { needs: [], jobId: null, problem: "That project no longer exists." };

  // The job the template made, found on the project rather than carried
  // from the install, because this channel is also how a reloaded window
  // finds its way back to step 6.
  const job = listJobs(db, projectId)[0] ?? null;
  return { needs: await needsOf(db, context, template.document, projectId), jobId: job?.id ?? null, problem: null };
}

/**
 * The needs check's way on for a template with no job (EO-664): an
 * assistant chat whose first message is EO's brief for the first item,
 * shown, with its first turn dispatched.
 *
 * The brief is built here because what it says is the template's: its
 * own opening question for its first item, or a generic one from its
 * title and description (`firstItemBrief`). The chat is the assistant's
 * (`openBriefedAssist`).
 *
 * On the board `gallery:use` answered with, where it is this project's;
 * otherwise the project's own pipeline. That is the board pinned to the
 * brief, and the one the brief names.
 */
export async function openFirstItemChatCommand(
  db: Db,
  context: GalleryContext,
  engine: EngineHandle | undefined,
  payload: IpcPayload<"gallery:openFirstItemChat">,
): Promise<IpcResponse<"gallery:openFirstItemChat">> {
  const template = await find(context, payload.slug, payload.token);
  if (template === null) return { conversation: null, problem: missing(payload.slug, payload.token) };

  const projectId = payload.projectId as Uuid;
  const project = getProject(db, projectId);
  if (project === undefined) return { conversation: null, problem: "That project no longer exists." };

  const pipelines = listPipelines(db, projectId);
  const named = payload.pipelineId === null ? undefined : pipelines.find((pipeline) => pipeline.id === payload.pipelineId);
  const pipeline = named ?? pipelines.find((candidate) => candidate.projectId === projectId) ?? pipelines[0];
  if (pipeline === undefined) return { conversation: null, problem: "That project has no pipeline to file work on." };

  const brief = firstItemBrief({
    template: template.document.template ?? { title: template.title, description: template.description },
    project: { id: project.id, name: project.name },
    pipeline: { id: pipeline.id, name: pipeline.name },
  });
  return openBriefedAssist(db, engine, { projectId, pipelineId: pipeline.id, brief });
}

/** One reading of the design's lines, so the two channels that answer with them cannot come to differ. */
async function needsOf(db: Db, context: GalleryContext, document: PipelineExport, projectId: Uuid): Promise<IpcResponse<"gallery:needs">["needs"]> {
  // Preflighted against the project that now exists, because that is the
  // only reading that can answer the design's lines: which types landed, which
  // connectors are still disconnected, which roles the import left
  // unstaffed.
  const preflight = preflightImport(db, context.moduleSecrets, document, {
    projectId,
    signedInBackends: context.signedInBackends,
  });
  const detect = context.detectForge ?? ((repositoryId: string) => detectForge(db, { repositoryId }));
  const forge = await forgeNeeds(db, projectId, document, detect);
  return projectNeeds(db, { document, preflight, projectId, signedInBackends: context.signedInBackends, forge });
}

/**
 * The button on a red role line (ARCHITECTURE.md, "The needs check").
 *
 * A role goes red when nothing here can play it, and on a fresh
 * installation that is nearly always the row the import just wrote: a
 * pack's role names no backend — a backend is a fact about the
 * installing machine — so `writeRoles` creates the agent pointed at
 * nothing and switched off, and no amount of signing in moves the line,
 * because the row is what is unpointed. Without this, ARCHITECTURE.md, "The needs check"'s promise
 * —
 * "each red line … carries the one button that fixes it" — was a line
 * nobody could turn green, and the weekly report could never reach the
 * state in which EO will start its first item.
 *
 * So: point the row at a backend this machine is signed in to, and
 * switch it on. Never at one it is *not* signed in to, and never at the
 * built-in placeholder: an agent EO pointed somewhere on a person's
 * behalf that cannot actually run is the same red line wearing a green
 * tick.
 *
 * The role's own prompt comes from the pack where a row has to be made
 * from scratch, which is what `writeRoles` would have done — this is
 * that write, deferred to the moment there is somewhere to point it.
 */
export async function staffRoleCommand(db: Db, context: GalleryContext, payload: IpcPayload<"gallery:staffRole">): Promise<IpcResponse<"gallery:staffRole">> {
  const template = await find(context, payload.slug, payload.token);
  if (template === null) return { ok: false, problem: missing(payload.slug, payload.token), locked: null };

  const carried = template.document.roles.find((role) => role.slug === payload.role);
  const recommended = carried?.backend ?? null;
  const signedIn = context.signedInBackends;
  const backend =
    payload.backend !== undefined && signedIn.includes(payload.backend)
      ? payload.backend
      : recommended !== null && signedIn.includes(recommended)
        ? recommended
        : (signedIn[0] ?? null);
  if (backend === undefined || backend === null) {
    return {
      ok: false,
      problem: "Nothing on this machine is signed in, so there is no backend to point an agent at. Sign in first, then this line can go green.",
      locked: null,
    };
  }

  // The row the import made, where there is one. Its prompt, its tools
  // and its output schemas are the pack's and are left alone: what is
  // missing is a backend and a switch.
  //
  // Which is why this channel is not in `SECTION_LOCKED_CHANNELS` and
  // the lock is asked here instead (EO-329, review). The two branches
  // below are two different acts: binding an agent that already exists
  // to a backend is the design's local half and stays the person's under any
  // lock, while *creating* one — with a pack's prompt and its
  // `allowedTools` — is the agents section itself arriving by a side
  // door. So the guard sits on the branch rather than on the channel,
  // which is the only way to refuse the second without taking away the
  // first.
  const mine = listAgents(db).filter((agent) => agent.archivedAt === null && !isPreviewAgent(agent) && agent.role === payload.role);
  const unbound = mine.find((agent) => !isBoundAgent(agent)) ?? mine.find((agent) => !isDispatchable(agent)) ?? null;
  if (unbound !== null) {
    updateAgent(db, unbound.id, {
      provider: backend,
      // The pack's recommended model only where the backend is the one
      // it recommended; a model name is a backend's own vocabulary and
      // carrying it across would name something that does not exist.
      model: recommended !== null && backend === recommended ? (carried?.model ?? null) : null,
      enabled: true,
    });
    return { ok: true, problem: null, locked: null };
  }
  if (mine.length > 0) return { ok: true, problem: null, locked: null };

  const lock = sectionLockFor(db, "agents:save");
  if (lock !== null) {
    // The lock, addressed to the person holding the mouse (EO-329,
    // review). This channel is answered on a *screen* — the needs
    // check's "Staff this role" button — and the sentence the command
    // layer writes is composed for an assistant reading a transcript:
    // it ends "tell the person it is managed and stop", which is an
    // instruction to somebody else about the very person who would be
    // reading it. So the refusal carries the design's own lock text, and the
    // marker beside it lets the screen draw the lock the way every
    // other locked surface does.
    return { ok: false, problem: sectionLockedLine(lock), locked: lock };
  }

  createAgent(db, {
    name: payload.role,
    role: payload.role,
    provider: backend,
    model: recommended !== null && backend === recommended ? (carried?.model ?? null) : null,
    instructions: carried?.prompt ?? "",
    // With the `memory_note` grant every new agent is given (EO-593): a
    // pack's role list that lacks it is not a person taking it away from
    // this agent, which does not exist yet.
    config: withMemoryNoteGrant(carried?.allowedTools == null ? {} : { allowedTools: carried.allowedTools }),
    enabled: true,
  });
  return { ok: true, problem: null, locked: null };
}

/**
 * The button on a red workspace line (ARCHITECTURE.md, "The needs check").
 *
 * Attaches the disk **to the project the needs check is about**, made a
 * minute ago out of the template the person chose.
 *
 * A workspace of the right kind that is already there and broken is
 * **repointed** rather than joined by a second one. The line the person
 * pressed said "EO cannot see /Users/you/reports"; answering it by
 * adding a second folder beside the one that is missing would leave the
 * project holding a dead workspace items still name, and the next
 * reading of this line would go green while the thing it was about
 * stayed wrong.
 */
export async function attachWorkspaceCommand(db: Db, payload: IpcPayload<"gallery:attachWorkspace">): Promise<IpcResponse<"gallery:attachWorkspace">> {
  const projectId = payload.projectId as Uuid;
  const project = getProject(db, projectId);
  if (project === undefined) return { ok: false, problem: "That project no longer exists." };

  const path = payload.path.trim();
  const kind = payload.kind === "git" ? GIT_WORKTREE_KIND : FOLDER_KIND;

  // Checked the way each kind is checked everywhere else: git itself for
  // a checkout, three stat calls for a directory. A path that is not one
  // is a sentence rather than a row.
  const problem = payload.kind === "git" ? await repositoryPathProblem(path) : folderPathProblem(path);
  if (problem !== null) return { ok: false, problem };

  // Asked after git has answered, so a move that began meanwhile counts.
  if (payload.kind === "git" && isAdopting(db, projectId)) return { ok: false, problem: movingProjectRefusal(project.name) };

  const broken = projectWorkspaceList(db, projectId).find((workspace) => workspace.kind === kind && workspaceProblem(workspace) !== null);
  if (broken !== undefined) {
    updateWorkspace(db, broken.id, {
      config: payload.kind === "git" ? { repoPath: path } : { path },
    });
    return { ok: true, problem: null };
  }

  if (payload.kind === "git") {
    if (listGitWorkspaces(db).some((workspace) => workspace.config.repoPath === path)) {
      return { ok: false, problem: `${path} is already attached to EO as a repository.` };
    }
    const workspace = createGitWorkspace(db, { config: { name: basename(path) || path, repoPath: path } });
    addWorkspaceToProject(db, projectId, workspace.id);
    return { ok: true, problem: null };
  }

  createWorkspace(db, {
    projectId,
    kind: FOLDER_KIND,
    config: { path, perItemSubfolder: true },
    position: projectWorkspaceList(db, projectId).length,
  });
  return { ok: true, problem: null };
}

/**
 * The document a button was pressed on.
 *
 * **The token decides, where the caller has one.** A card carries the
 * token of the exact pack it was drawn from, and a person who opened its
 * form is owed that pack and no other — the index may have moved on
 * twice while they typed. So a token that is still held wins outright,
 * and a token that is *not* held is refused rather than quietly
 * resolved by slug: falling back would reinstate the bug the token
 * exists to close, and "choose the card again" is a sentence somebody
 * can act on. See `gallery/session.ts` for how long a token stays held
 * and why that is long enough.
 *
 * Without one — a caller that never listed, a test, a future MCP tool —
 * three places, in the order that keeps a gesture attached to its
 * subject:
 *
 *  1. **What the gallery last listed**, so a card whose index has since
 *     gone away still installs what it advertised.
 *  2. **The bundled set**, read off the disk without touching the
 *     network, so an offline machine never waits on a timeout to answer
 *     about a template it ships.
 *  3. **A fetch**, last, for a slug only the index has.
 */
async function find(context: GalleryContext, slug: string, token: string | undefined): Promise<GalleryTemplate | null> {
  if (token !== undefined && token !== "") return listedByToken(token) ?? null;

  const listed = listedTemplate(slug);
  if (listed !== undefined) return listed;

  const bundled = bundledTemplates(context.directory).find((template) => template.slug === slug);
  if (bundled !== undefined) return bundled;
  return (await listGalleryTemplates(context)).find((template) => template.slug === slug) ?? null;
}

/**
 * Why there is nothing to act on, in the words that fit the case.
 *
 * A slug EO has never heard of and a card whose pack has been
 * republished out from under it are different situations, and only one
 * of them is the person's to do anything about.
 */
function missing(slug: string, token: string | undefined): string {
  if (token !== undefined && token !== "") {
    return `"${slug}" has been published again since you opened it, so EO is no longer holding the version you were looking at. Go back and choose it again.`;
  }
  return `EO has no template called "${slug}".`;
}
