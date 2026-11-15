import { RuntimeIdSchema, staffingAgents, type Agent, type CommentOption, type Item, type PipelineStep, type RuntimeId } from "@eo/core";
import { dispatchBlockers, type DispatchRefusal, type TickInput } from "@eo/engine";
import { RUNTIMES } from "../runtimes/catalog.js";

/**
 * A runtime that is not signed in, blocked on this device (EO-796).
 *
 * Signing in is a fact about the CLI on this machine, not about any one
 * item: when `claude auth status` says nobody is signed in, every agent
 * that runs on Claude is equally unable to work. So the dispatch
 * preflight's `signed_out` blocks the runtime rather than refusing the
 * item it happened to be asked about, and while it is blocked:
 *
 * - the scheduler offers nothing to agents on it, and the items only
 *   they could take are left out of the pick, so they hold no slot
 *   (invariant 10);
 * - each of those items is told once per block, in a note — it needs no
 *   reply and gets no `!` (invariant 8, invariant 6);
 * - the person is sent one message, with a Sign in button and Try again.
 *
 * Pure helpers here; the state, the probe and the writes are the
 * supervisor's.
 */

/** Where the one message per blocked runtime comes from; its subject is the runtime id. */
export const RUNTIME_SIGN_IN_SOURCE = "runtime_sign_in";

/** The answer on that message that asks the runtime again. */
export const TRY_AGAIN_OPTION = "Try again";

/**
 * How often a blocked runtime is asked again on its own, for a sign-in
 * made outside EO — in a terminal, say. Longer than the auth cache's
 * fifteen seconds, so each check reaches the CLI.
 */
export const RUNTIME_BLOCK_RECHECK_MS = 30_000;

/** The runtime an agent runs on, or null for one that runs in EO's own process (`fake`). */
export function runtimeOf(agent: Pick<Agent, "provider">): RuntimeId | null {
  const parsed = RuntimeIdSchema.safeParse(agent.provider);
  return parsed.success ? parsed.data : null;
}

/** What a person is shown the runtime as. */
export function runtimeLabel(runtime: RuntimeId): string {
  return RUNTIMES[runtime].label;
}

/** An item waiting for a blocked runtime, and the agents on it that could take it. */
export interface HeldItem {
  item: Item;
  runtime: RuntimeId;
  agents: Agent[];
}

/** The step the scheduler would dispatch this item at: its own version's, else the live one. */
function stepOf<R extends DispatchRefusal>(input: TickInput<R>, item: Item): PipelineStep | undefined {
  if (item.pipelineId === null || item.stepId === null) return undefined;
  const bound = input.stepsByItem?.get(item.id);
  if (bound && bound.pipelineId === item.pipelineId && bound.id === item.stepId) return bound;
  return input.steps.find((step) => step.pipelineId === item.pipelineId && step.id === item.stepId);
}

/**
 * The items nothing stands between and a run but a blocked runtime.
 *
 * Eligible on every other count — no blocker, not held by a pause — at
 * an agent step, where every agent `staffingAgents` would choose from
 * runs on a blocked runtime. Asked of the agents as they are, before any
 * is left out, so a project whose own agent is blocked waits for it
 * rather than going to a global agent the project stepped out from
 * under (EO-474). An item with one candidate on another runtime is not
 * held: it goes to that one.
 *
 * Read off the agent's own backend, not the run's: a preview's runs use
 * the fake backend, but the agent it would be handed to is still one on
 * the blocked runtime, and the pick cannot offer it one agent for this
 * item and another for the rest.
 */
export function heldByBlockedRuntimes<R extends DispatchRefusal>(input: TickInput<R>, blocked: ReadonlySet<RuntimeId>): HeldItem[] {
  if (blocked.size === 0) return [];
  const notEligible = new Set(dispatchBlockers(input).map(({ item }) => item.id));
  const held: HeldItem[] = [];
  for (const item of input.items) {
    if (notEligible.has(item.id)) continue;
    const step = stepOf(input, item);
    if (step?.type !== "agent" || step.ownerRole === null) continue;
    if (input.paused && !input.pauseExemptRoles?.has(step.ownerRole)) continue;
    const staff = staffingAgents(input.agents, step.ownerRole, item);
    const runtimes = staff.map(runtimeOf);
    const first = runtimes[0];
    if (first === undefined || first === null) continue;
    if (!runtimes.every((runtime) => runtime !== null && blocked.has(runtime))) continue;
    held.push({ item, runtime: first, agents: staff });
  }
  return held;
}

/**
 * The scheduler's input with the blocked runtimes taken out: the held
 * items left out of the pick, and the agents on a blocked runtime out of
 * the candidates for everything else. Dependencies still resolve
 * against every item, held or not.
 */
export function withoutBlockedRuntimes<R extends DispatchRefusal>(input: TickInput<R>, blocked: ReadonlySet<RuntimeId>, held: readonly HeldItem[]): TickInput<R> {
  if (blocked.size === 0) return input;
  const heldIds = new Set(held.map(({ item }) => item.id));
  return {
    ...input,
    dependencyItems: input.dependencyItems ?? input.items,
    items: input.items.filter((item) => !heldIds.has(item.id)),
    agents: input.agents.filter((agent) => {
      const runtime = runtimeOf(agent);
      return runtime === null || !blocked.has(runtime);
    }),
  };
}

/**
 * The note on each held item, once per block. The same words every time,
 * so the thread can be asked whether it was already said.
 */
export function runtimeHoldNote(runtime: RuntimeId): string {
  const label = runtimeLabel(runtime);
  return (
    `Waiting for ${label} to be signed in on this device. ${label} is not signed in, so EO is dispatching nothing to the agents that run on it. ` +
    `This carries on by itself once it is signed in — nobody needs to reply here.`
  );
}

/** The message to the person, and what it offers. */
export function runtimeSignInMessage(facts: {
  runtime: RuntimeId;
  executablePath: string | null;
  itemCount: number;
  agentNames: readonly string[];
}): { body: string; options: CommentOption[] } {
  const label = runtimeLabel(facts.runtime);
  const items = facts.itemCount === 1 ? "1 item is" : `${facts.itemCount} items are`;
  const agents = facts.agentNames.length === 0 ? "" : ` for ${listed(facts.agentNames)}`;
  const where = facts.executablePath === null ? "" : ` The copy EO resolved is \`${facts.executablePath}\`.`;
  return {
    body:
      `${label} is not signed in on this device, so EO is dispatching nothing to the agents that run on it. ` +
      `${items} waiting${agents}.${where} ` +
      `Sign it in and they carry on by themselves; nobody needs to reply on them. ` +
      `If you signed it in somewhere else, Try again asks ${label} once more.`,
    options: [{ kind: "open", label: "Sign in", opens: { type: "runtimeSignIn", runtime: facts.runtime } }, TRY_AGAIN_OPTION],
  };
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
