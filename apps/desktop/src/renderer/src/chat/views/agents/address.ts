/**
 * `/agents?actions=<role>`: the agent screen opened on a role's Actions
 * section (EO-428).
 *
 * Named by role rather than by agent because an action definition is the
 * role's, shared by every agent on it — and a role is what the pipeline
 * editor has in hand when it sends somebody here.
 */
export const ACTIONS_FACET = "actions";

export function actionsAddress(role: string): string {
  return `/agents?${ACTIONS_FACET}=${encodeURIComponent(role)}`;
}

/**
 * `/agents?instructions=<agent id>`: the agent screen opened on one
 * agent, with its instructions in view (EO-805) — where a board column's
 * owner line sends somebody who wants to know what the agent on that
 * step is told.
 *
 * By agent, unlike `actionsAddress` (EO-876): a step names an agent, and
 * two agents of one kind — a Reviewer on Claude and one on Codex — are
 * told different things, so an address by kind could open the other.
 */
export const INSTRUCTIONS_FACET = "instructions";

export function instructionsAddress(agentId: string): string {
  return `/agents?${INSTRUCTIONS_FACET}=${encodeURIComponent(agentId)}`;
}
