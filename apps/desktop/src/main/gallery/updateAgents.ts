import type { Agent, Message, PipelineExport, SectionLock, Uuid } from "@eo/core";
import { adoptExportedActions, exportedActionRefusal } from "../actionDefinitionAdoption.js";
import type { Db } from "../db/client.js";
import { getActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { clearSetting, getSetting, listAgents, listStepsForPipeline, markMessagesAboutResolved, messageSubjectOf, openMessageAbout, setSetting, templateBoardHolders } from "../db/repos/index.js";
import { sectionLockFor } from "../managed/locks.js";
import { sendMessageHere } from "../messages/messages.js";
import { agentFromRole } from "../modules/pipelineTransfer.js";
import { agentNamedForKind, kindCandidates } from "../stepAgents.js";

/** What the message asking which agent a template update's new steps run is filed under (EO-877). */
export const TEMPLATE_AGENT_CHOICE_SOURCE = "template_update_agent_choice";

/**
 * A kind a template update adds that EO cannot bind on its own: several
 * agents to choose between; none and no prompt to make one from; or what
 * the kind needs made here — its agent, or the action definitions the new
 * version carries for it — while the organisation's agents section is
 * published, so nothing of it may be made on this replica.
 */
export type KindWait = { kind: string; agents: Agent[] } | { kind: string; agents: []; locked: SectionLock; needs: "agent" | "actions" };

/** Where one installation of a template is: its slug and the project its boards are on. */
export interface Installation {
  slug: string;
  projectId: string | null;
}

/** The setting a person's answer is kept under, until the update it was asked for has used it. */
function choiceKey(installation: Installation, kind: string): string {
  return `templateUpdate.agentChoice:${installation.slug}:${installation.projectId ?? ""}:${kind}`;
}

/** The setting the answers a question offered are kept under: each button's label and the agent it names. */
function optionsKey(installation: Installation, kind: string): string {
  return `templateUpdate.agentOptions:${installation.slug}:${installation.projectId ?? ""}:${kind}`;
}

/** What a message asking about one kind of one installation is about. Slugs, ids and kinds hold no `|`. */
function subjectOf(installation: Installation, kind: string): string {
  return `${installation.slug}|${installation.projectId ?? ""}|${kind}`;
}

/**
 * The answer buttons for a choice between agents, each with the agent it
 * names: the agent as the person knows it, its name and backend. Where two
 * read the same, the model is added, and where they still do, a number in
 * the order they are listed, so no two buttons read alike. The answer is
 * read back through the agent each label was offered for, not by matching
 * a name again, so renaming an agent after the question changes nothing.
 */
export function agentChoiceOptions(agents: readonly Pick<Agent, "id" | "name" | "provider" | "model">[]): { label: string; agentId: string }[] {
  const plain = (agent: Pick<Agent, "name" | "provider">): string => `${agent.name} (${agent.provider})`;
  const withModel = (agent: Pick<Agent, "name" | "provider" | "model">): string => (agent.model === null ? plain(agent) : `${agent.name} (${agent.provider}, ${agent.model})`);
  const count = (labels: readonly string[], label: string): number => labels.filter((each) => each === label).length;
  const first = agents.map(plain);
  const second = agents.map((agent, index) => (count(first, first[index]!) > 1 ? withModel(agent) : first[index]!));
  const seen = new Map<string, number>();
  return agents.map((agent, index) => {
    const label = second[index]!;
    if (count(second, label) === 1) return { label, agentId: agent.id };
    const nth = (seen.get(label) ?? 0) + 1;
    seen.set(label, nth);
    return { label: `${label} #${nth}`, agentId: agent.id };
  });
}

/**
 * The action definitions a template version carries for a kind that are
 * not defined here (EO-877), written as an import writes them
 * (`adoptExportedActions`: none over one that exists) — or, where the
 * organisation's agents section is published on this replica, the lock
 * that keeps them from being written.
 */
function adoptKindActions(db: Db, document: PipelineExport, kind: string): SectionLock | null {
  const role = document.roles.find((entry) => entry.slug === kind);
  if (role === undefined) return null;
  const missing = role.actions.filter((carried) => getActionDefinition(db, kind.trim(), carried.action) === undefined);
  if (missing.length === 0) return null;
  const lock = sectionLockFor(db, "roleActions:save");
  if (lock !== null) return lock;
  // One the save would refuse is left unwritten rather than thrown: the
  // graph's validation then holds the update and says which action is
  // missing, where a throw would be a line in a log.
  if (exportedActionRefusal(kind, missing) === null) adoptExportedActions(db, kind, missing);
  return null;
}

/**
 * The agent each kind a template update adds is bound to (EO-877,
 * ARCHITECTURE.md §15.5), as an import binds a kind — or the kinds it
 * cannot bind without the person.
 *
 * In order: the agent the installation already runs for the kind on any
 * of the template's boards in the project — the import's binding, or the
 * person's choice — so no update picks another; the one the person chose
 * when an earlier launch asked them; the one agent of the kind the
 * project has. Where it has several, the person picks. Where it has none,
 * one is made from the prompt the new version carries for the role,
 * unbound and off until somebody points it at a backend, as an import
 * with nothing signed in makes one. Where there is no prompt either, the
 * person has to make one. Nothing guesses between two agents.
 *
 * And the action definitions the new version carries for each kind are
 * written where they are missing, as an import writes them, so a step of
 * a kind and action the template brings validates. A replica whose
 * organisation has published the agents section makes neither an agent
 * nor a definition: the kind waits for the organisation to provide it.
 */
export function bindAddedKinds(db: Db, installation: Installation, document: PipelineExport, kinds: Iterable<string>): { bound: Map<string, Uuid>; waiting: KindWait[] } {
  const agents = listAgents(db);
  const running = templateBoardHolders(db, installation.slug, installation.projectId).flatMap((holder) => listStepsForPipeline(db, holder.pipelineId));
  const bound = new Map<string, Uuid>();
  const waiting: KindWait[] = [];
  let made = false;
  for (const kind of new Set(kinds)) {
    const actionsLock = adoptKindActions(db, document, kind);
    if (actionsLock !== null) {
      waiting.push({ kind, agents: [], locked: actionsLock, needs: "actions" });
      continue;
    }
    const candidates = kindCandidates(made ? listAgents(db) : agents, kind, installation.projectId);
    const runs = agentNamedForKind(agents, running, kind);
    const chosen = getSetting<string>(db, choiceKey(installation, kind), "");
    const agent =
      (runs !== undefined && candidates.some((candidate) => candidate.id === runs.id) ? runs : undefined) ??
      candidates.find((candidate) => candidate.id === chosen) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (agent !== undefined) {
      bound.set(kind, agent.id);
      continue;
    }
    if (candidates.length > 1) {
      waiting.push({ kind, agents: candidates });
      continue;
    }
    const role = document.roles.find((entry) => entry.slug === kind);
    if (role !== undefined && role.prompt !== null) {
      const lock = sectionLockFor(db, "agents:save");
      if (lock !== null) {
        waiting.push({ kind, agents: [], locked: lock, needs: "agent" });
        continue;
      }
      bound.set(kind, agentFromRole(db, { ...role, prompt: role.prompt }, []).id);
      made = true;
      continue;
    }
    waiting.push({ kind, agents: [] });
  }
  return { bound, waiting };
}

/**
 * Asks the person about each kind an update waits on (EO-877), once per
 * installation and kind while the question is open: one answer per agent
 * where there are several, and where there are none, what to make. Sent
 * where the installation is held — the record's admins for a pipeline the
 * record holds — as a held update's notice is.
 */
export function askForKinds(db: Db, installation: Installation, waits: readonly KindWait[], what: { title: string; version: string; isTheRecord: boolean; now: number }): void {
  for (const wait of waits) {
    const subject = subjectOf(installation, wait.kind);
    if (openMessageAbout(db, TEMPLATE_AGENT_CHOICE_SOURCE, subject) !== undefined) continue;
    const adds = `The ${what.title} template's ${what.version} update adds "${wait.kind}" steps`;
    const options = wait.agents.length > 0 ? agentChoiceOptions(wait.agents) : [];
    const body =
      "locked" in wait
        ? `${adds}, and ${wait.needs === "agent" ? `you have no "${wait.kind}" agent` : `the "${wait.kind}" actions it brings are not defined here`}. Your organisation has published its agents section${wait.locked.publishedBy === null ? "" : ` (${wait.locked.publishedBy})`}, so EO cannot make ${wait.needs === "agent" ? "one" : "them"} on this machine. Ask your organisation's admin to publish ${wait.needs === "agent" ? `a "${wait.kind}" agent` : `the "${wait.kind}" actions`}; EO applies the update the next time it starts after ${wait.needs === "agent" ? "it arrives" : "they arrive"}.`
        : options.length > 0
          ? `${adds}, and you have several "${wait.kind}" agents. Choose which one those steps run; EO applies the update once you have, and leaves every step you already chose an agent for as it is.`
          : `${adds}, and you have no "${wait.kind}" agent, nor a prompt to make one from. Make a "${wait.kind}" agent on the Agents screen; EO applies the update the next time it starts.`;
    // Each button's agent, kept before the question goes out, so the
    // answer names the agent that button was offered for.
    if (options.length > 0) setSetting(db, optionsKey(installation, wait.kind), options);
    else clearSetting(db, optionsKey(installation, wait.kind));
    sendMessageHere(
      db,
      { projectId: installation.projectId, source: TEMPLATE_AGENT_CHOICE_SOURCE, subject, body, options: options.length > 0 ? options.map((option) => option.label) : null },
      what.isTheRecord,
      what.now,
    );
  }
}

/** Closes the questions about kinds an update has now bound (EO-877): the person chose, or the kind came to have one agent. */
export function settleKinds(db: Db, installation: Installation, kinds: Iterable<string>, now: number): void {
  for (const kind of kinds) {
    markMessagesAboutResolved(db, TEMPLATE_AGENT_CHOICE_SOURCE, subjectOf(installation, kind), now);
    clearSetting(db, choiceKey(installation, kind));
    clearSetting(db, optionsKey(installation, kind));
  }
}

/**
 * The person's answer to `askForKinds` (EO-877), kept for the update to
 * bind the kind with. The button answered is read back to the agent it
 * was offered for, which must still be an agent of the kind the
 * installation can run. Answers whether it is, which is when the caller
 * applies the update again.
 */
export function chooseTemplateAgent(db: Db, message: Pick<Message, "id" | "source" | "handledHow" | "answer">): boolean {
  if (message.source !== TEMPLATE_AGENT_CHOICE_SOURCE || message.handledHow !== "answered" || message.answer === null) return false;
  const [slug = "", projectId = "", kind = ""] = (messageSubjectOf(db, message.id) ?? "").split("|");
  if (slug === "" || kind === "") return false;
  const installation = { slug, projectId: projectId === "" ? null : projectId };
  const offered = getSetting<{ label: string; agentId: string }[]>(db, optionsKey(installation, kind), []).find((option) => option.label === message.answer);
  if (offered === undefined) return false;
  const agent = kindCandidates(listAgents(db), kind, installation.projectId).find((candidate) => candidate.id === offered.agentId);
  if (agent === undefined) return false;
  setSetting(db, choiceKey(installation, kind), agent.id);
  return true;
}
