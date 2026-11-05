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
