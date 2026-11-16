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
 * `/agents?instructions=<role>`: the agent screen opened on the agent a
 * role names, with its instructions in view (EO-805) — where a board
 * column's owner line sends somebody who wants to know what the agent on
 * that step is told.
 *
 * By role for the same reason as `actionsAddress`: a step names a role,
 * not an agent. The screen resolves it the same way — a live agent on
 * the role, otherwise a retired one, never another role's.
 */
export const INSTRUCTIONS_FACET = "instructions";

export function instructionsAddress(role: string): string {
  return `/agents?${INSTRUCTIONS_FACET}=${encodeURIComponent(role)}`;
}
