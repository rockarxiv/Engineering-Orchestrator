import { isPreviewAgent, staffingAgents, staffsItem, stepAgentKind, type Agent, type Uuid } from "@eo/core";

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
  const kept = agents.filter((agent) => agent.role === kind && agent.archivedAt === null && staffsItem(agent, item));
  const own = kept.filter((agent) => agent.projectId !== null);
  return pick(own.length > 0 ? own : kept);
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
