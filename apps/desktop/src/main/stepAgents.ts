import { isPreviewAgent, isTeamOwned, staffingAgents, staffsItem, stepAgentKind, stepAgentOf, type Agent, type Uuid } from "@eo/core";

/**
 * The agent a kind is bound to on a project, where something names a
 * kind and nobody has chosen an agent for it yet (EO-875, ARCHITECTURE.md
 * §12.1): a document being imported, a template being installed or
 * updated, a suggestion, an assistant's draft.
 *
 * A step names its agent and dispatch runs that one; this is only how a
 * kind becomes an agent in the first place. The rule is the one
 * migration 0181 gave every existing step — `staffingAgents`' first, the
 * project's own of the kind before a global one — and then, where no
 * agent of the kind can run yet, the first that is still there: an
 * import creates the agent it needs unbound and disabled when its backend
 * is not signed in here, and the step must name that agent so that
 * enabling it is all it takes.
 *
 * `preview` binds for a rehearsal, where a preview's own agent may stand
 * in; a real agent that can run is still chosen before it.
 *
 * Undefined where the installation has no agent of the kind on this
 * project at all: the step then names nobody, and says so.
 */
export function agentForKind(agents: readonly Agent[], kind: string | null, projectId: string | null, options: { preview?: boolean } = {}): Agent | undefined {
  if (kind === null) return undefined;
  const item = { previewAt: options.preview === true ? 1 : null, projectId: projectId as Uuid | null };
  const pick = (candidates: readonly Agent[]): Agent | undefined => candidates.find((agent) => !isPreviewAgent(agent)) ?? candidates[0];
  const live = staffingAgents(agents, kind, item);
  if (live.length > 0) return pick(live);
  const kept = agents.filter((agent) => !isTeamOwned(agent) && agent.role === kind && agent.archivedAt === null && staffsItem(agent, item));
  const own = kept.filter((agent) => agent.projectId !== null);
  return pick(own.length > 0 ? own : kept);
}

/**
 * Every agent a kind may be bound to on a project (EO-877): the agents
 * of the kind that are not archived and not a preview's own and whose
 * scope reaches the project — its own and the global ones — with the
 * one `agentForKind` binds first.
 *
 * What an import, a template install and the gallery's form offer the
 * person: one is named, several are chosen between, and none is made.
 * Disabled and unbound agents are among them, because an agent somebody
 * switched off is still theirs to name on a step.
 */
export function kindCandidates(agents: readonly Agent[], kind: string, projectId: string | null): Agent[] {
  const item = { previewAt: null, projectId: projectId as Uuid | null };
  const candidates = agents.filter((agent) => !isTeamOwned(agent) && agent.role === kind && agent.archivedAt === null && agent.deletedAt === null && staffsItem(agent, item));
  const first = agentForKind(candidates, kind, projectId);
  return first === undefined ? candidates : [first, ...candidates.filter((agent) => agent.id !== first.id)];
}

/**
 * The agent a pipeline already names for a kind (EO-877), or undefined.
 *
 * How a step a template update adds is bound like a new import: the
 * import bound each kind to one agent — the person's pick where there
 * were several — and every step of the kind named it, so a new step of
 * the kind names that one too rather than whichever the binding rule
 * would choose.
 */
export function agentNamedForKind(agents: readonly Agent[], steps: readonly { readonly type: string; readonly agentId: string | null }[], kind: string | null): Agent | undefined {
  if (kind === null) return undefined;
  for (const step of steps) {
    const agent = stepAgentOf(agents, step);
    if (agent !== undefined && agent.role === kind && agent.archivedAt === null && agent.deletedAt === null) return agent;
  }
  return undefined;
}

/**
 * A live step as a document reads it: with the kind its agent brings, as
 * the `ownerRole` a document's step names (EO-875).
 *
 * What lets a template's steps, which name kinds, be compared with the
 * steps a pipeline holds, which name agents — a template update, the
 * matching of a pipeline to the template version it came from, a
 * conflict's detail. Null for a step that names no agent, or one whose
 * row is not among `agents`.
 */
export function withKind<S extends { readonly type: string; readonly agentId: string | null }>(agents: readonly Pick<Agent, "id" | "role">[], step: S): S & { ownerRole: string | null } {
  return { ...step, ownerRole: stepAgentKind(agents, step) };
}

/**
 * Binds the kind each step of a document names to an agent (EO-875):
 * the agent a step of the same id already names here, where that agent
 * is still of the kind — a person's choice of agent is theirs — and
 * otherwise `agentForKind` on the project. Null for a step that is not
 * an agent step, or a kind nobody here has.
 */
export function kindBinder(
  agents: readonly Agent[],
  projectId: string | null,
  existing: readonly { readonly id: string; readonly type: string; readonly agentId: string | null }[] = [],
  options: { preview?: boolean } = {},
): (step: { readonly id?: string; readonly type: string; readonly ownerRole: string | null }) => Uuid | null {
  const held = new Map(existing.map((step) => [step.id, step] as const));
  return (step) => {
    if (step.type !== "agent") return null;
    const kept = step.id === undefined ? undefined : held.get(step.id);
    if (kept !== undefined && kept.agentId !== null && stepAgentKind(agents, kept) === step.ownerRole) return kept.agentId as Uuid;
    return (agentForKind(agents, step.ownerRole, projectId, options)?.id ?? null) as Uuid | null;
  };
}

/**
 * What an assistant draft's step that names no agent this installation
 * has is given for an id (EO-876): an id no agent holds, so
 * `validatePipeline` refuses it in the words a publish of such a step is
 * refused with — "names an agent this installation does not have".
 */
export const UNKNOWN_AGENT_ID = "unknown-agent" as Uuid;

/**
 * The agent a draft's step names, by its name as the Agents screen shows
 * it (EO-876).
 *
 * A deleted agent is a tombstone and is never named. Where names are
 * shared — nothing stops two agents having one — the one that can work
 * for the pipeline's project is chosen, its own before a global one, a
 * live one before a retired one; and then the first. A team's own agent
 * only where no ordinary agent has the name (EO-897). Null for a step
 * that names nobody, `UNKNOWN_AGENT_ID` for a name nobody here has.
 */
export function agentNamed(agents: readonly Agent[], name: string | null, projectId: string | null): Uuid | null {
  if (name === null) return null;
  const wanted = name.trim();
  const called = agents.filter((agent) => agent.deletedAt === null && agent.name.trim() === wanted);
  // An ordinary agent before a team's own (EO-897), which only its team
  // runs: a name only a team's agent has names it, so `validatePipeline`
  // refuses the step saying whose it is.
  const ordinary = called.filter((agent) => !isTeamOwned(agent));
  const named = ordinary.length > 0 ? ordinary : called;
  if (named.length === 0) return UNKNOWN_AGENT_ID;
  const rank = (agent: Agent): number =>
    (agent.projectId === null ? 1 : agent.projectId === projectId ? 0 : 3) + (agent.archivedAt === null && agent.enabled ? 0 : 0.5);
  return [...named].sort((a, b) => rank(a) - rank(b))[0]!.id;
}
