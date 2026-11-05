import { z } from "zod";
import { McpServerConfigSchema } from "./schemas/mcpServers.js";

/**
 * What an organisation decides for everybody (EO-328,
 * `ARCHITECTURE.md`, "Policy",
 * "Secrets").
 *
 * Three things, and the design is careful to say that each of them is already
 * a concept in the app rather than something managed mode invents:
 *
 *  - **which backends may be used.** An agent row has bound a role to a
 *    backend since the first version; what an organisation adds is a
 *    list of the ones it will pay for and stand behind. A device may not
 *    bind an agent outside it, and — the half that actually holds —
 *    nothing dispatches outside it either.
 *  - **which MCP servers exist.** A catalogue row is already the app's
 *    answer to "what may an agent be served"; publishing one makes it
 *    every desktop's answer instead of each desktop's own.
 *  - **what one person may spend in a day.** `dailyBudgetCents` has
 *    existed since the design's guardrails and is installation-wide. Under a
 *    server it gains a per-person meaning, because the installation is
 *    no longer the unit anybody is accountable for.
 *
 * …and one thing that is not policy but travels with it: the **names**
 * of the organisation's secrets. The values do not cross this schema in
 * either direction, and `organisationSecretLine` below says what a
 * screen is allowed to claim about them.
 *
 * ## Absence is permission
 *
 * Every field's empty value means "the organisation has not said", and
 * "has not said" means an installation behaves exactly as a solo one
 * does. That is what lets a single code path serve both topologies
 * (ARCHITECTURE.md, "The record"): a desktop that never signed in to anything reads `NO_POLICY`
 * and every check below answers yes. There is deliberately no "managed
 * mode" boolean anywhere in this file — a policy nobody published is
 * the same object whether or not there is a server.
 */

/**
 * An MCP server the organisation publishes to every desktop.
 *
 * `McpServer` minus everything that is a fact about one machine — when
 * it was enabled here, when it was archived here, whether this
 * machine's keychain has its values. What is published is the
 * definition: how the server is reached and what it needs, which is
 * exactly the same split the original design makes for a published agent ("role,
 * prompt and tool surface are published; backend and model stay
 * local").
 *
 * `envNames` are names, as they are everywhere else in EO. What is
 * behind them is an organisation secret, delivered by its own path and
 * never by this one.
 */
export const PublishedMcpServerSchema = z.object({
  /**
   * Minted by the server, and the same id on every desktop.
   *
   * That is what makes a published definition *one* server rather than
   * one per machine: a desktop materialises it into its own catalogue
   * under this id, so an attachment made on one desktop names something
   * the next desktop also has.
   */
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  config: McpServerConfigSchema,
  envNames: z.array(z.string()).default([]),
});
export type PublishedMcpServer = z.infer<typeof PublishedMcpServerSchema>;

export const OrganisationPolicySchema = z.object({
  /**
   * The backends an agent may be bound to, or null for "the
   * organisation has not said".
   *
   * Null rather than an empty array, and the two are opposite answers:
   * an empty list is an organisation that allows *nothing*, which is a
   * strange thing to publish but a coherent one, and null is an
   * organisation that has not published a list at all. Collapsing them
   * would make "we have not decided yet" indistinguishable from "no
   * agent may run", which is the difference between a desktop that
   * works and one that does not.
   */
  allowedBackends: z.array(z.string()).nullable().default(null),
  /**
   * What one person's items may cost in a day, in cents, or null for no
   * ceiling.
   *
   * Per person and not per project: the design says the server sums people
   * into a project total for the admin, which is a *reading* rather than
   * a second budget. Per-project budgets do not exist today and this
   * story does not add them.
   */
  perPersonDailyBudgetCents: z.number().int().nonnegative().nullable().default(null),
  /** The definitions every signed-in desktop is to have in its catalogue. */
  mcpServers: z.array(PublishedMcpServerSchema).default([]),
  /**
   * The names the organisation has set a secret under — never a value,
   * at any point, in either direction.
   *
   * This is what a desktop's secret row is drawn from, and it is why
   * that row can say "set by your organisation" without anything having
   * to hand it the value to check.
   */
  secretNames: z.array(z.string()).default([]),
  /** When an admin last published, or null on a policy nobody has ever saved. */
  publishedAt: z.number().nullable().default(null),
  /** Who published it, by person id, for the sentence a screen shows beside the date. */
  publishedBy: z.string().nullable().default(null),
});
export type OrganisationPolicy = z.infer<typeof OrganisationPolicySchema>;

/**
 * What an installation nobody has published to reads.
 *
 * A solo desktop's whole experience of this file: every check below
 * answers "allowed", every budget answers "no ceiling", and no screen
 * says anything at all about an organisation. Frozen because it is
 * handed out rather than copied, and a caller that mutated it would be
 * publishing a policy by accident.
 */
export const NO_POLICY: OrganisationPolicy = Object.freeze({
  allowedBackends: null,
  perPersonDailyBudgetCents: null,
  mcpServers: [],
  secretNames: [],
  publishedAt: null,
  publishedBy: null,
});

/**
 * Whether an agent may be bound to — and dispatched on — this backend.
 *
 * The empty string is `UNBOUND_BACKEND` (`domain.ts`): a row a pack
 * created whose recommended backend nobody here has signed in to.
 * Nothing is bound, so nothing is disallowed, and the refusal a person
 * needs is the one that already exists for an unbound agent rather than
 * a second one wearing the organisation's name.
 */
export function backendAllowed(policy: OrganisationPolicy, provider: string): boolean {
  if (policy.allowedBackends === null) return true;
  if (provider === "") return true;
  return policy.allowedBackends.includes(provider);
}

/**
 * The words beside a backend a person may not choose.
 *
 * Short because of where it is read: under an option in a picker, where
 * the question is only "why is this one greyed", and the longer sentence
 * belongs to the refusal below.
 */
export const NOT_ALLOWED_BY_YOUR_ORGANISATION = "not allowed by your organisation";

/**
 * Why a dispatch did not happen, in the thread.
 *
 * It names the backend that was asked for and the ones that were not
 * refused, because those are the two facts somebody needs in order to
 * fix it: which agent to re-point, and what to re-point it at. An
 * organisation that allows nothing at all gets its own sentence rather
 * than an empty list rendered as a blank.
 */
export function disallowedBackendRefusal(input: { agentName: string; provider: string; policy: OrganisationPolicy }): string {
  const allowed = input.policy.allowedBackends ?? [];
  const alternatives =
    allowed.length === 0
      ? "Your organisation allows no backend at all, so there is nothing to move it to — ask your admin."
      : `Your organisation allows ${listed(allowed)}. Point "${input.agentName}" at one of those, or ask your admin to allow "${input.provider}".`;
  return (
    `"${input.agentName}" is bound to the "${input.provider}" backend, which is ${NOT_ALLOWED_BY_YOUR_ORGANISATION}. ` +
    `Nothing was dispatched. ${alternatives}`
  );
}

/**
 * Why a *save* was refused, as the editor and `agent_save` both read it.
 *
 * Its own sentence rather than `disallowedBackendRefusal`'s, because the
 * two are about different moments and want different verbs. That one is
 * written on an item's thread after the fact — "nothing was dispatched",
 * past tense, with an agent to go and re-point. This is answered to
 * whoever is *trying* to bind one, so it says what will not be written
 * and what to pick instead.
 */
export function bindingRefusal(input: { provider: string; policy: OrganisationPolicy }): string {
  const allowed = input.policy.allowedBackends ?? [];
  return (
    `The "${input.provider}" backend is ${NOT_ALLOWED_BY_YOUR_ORGANISATION}, so this agent was not bound to it and ` +
    `nothing was saved. ` +
    (allowed.length === 0
      ? "Your organisation allows no backend at all — ask your admin before staffing anything."
      : `Pick ${listed(allowed)}, or ask your admin to allow "${input.provider}".`)
  );
}

/** "a, b and c" — a list as a person reads one, rather than as JSON. */
function listed(names: readonly string[]): string {
  if (names.length === 1) return `"${names[0]}"`;
  const quoted = names.map((name) => `"${name}"`);
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Cents as a person writes them, with the pence dropped when there are
 * none.
 *
 * "$3 of $10 today" is the original design's own example and "$3.00 of $10.00 today" is
 * the same sentence with two digits of noise in it. Under a dollar the
 * unit changes rather than the sentence reading "$0.42", which is the
 * rule the renderer's `shared/jobs/format.ts` already applies on the
 * other side of the IPC boundary — this is its twin rather than its
 * competitor, because a sentence composed here is read beside figures
 * composed there.
 */
export function moneyLabel(cents: number): string {
  if (cents < 100) return `${cents}¢`;
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

/**
 * What one person has spent today against what they are allowed.
 *
 * Both halves or nothing: a line that showed a spend with no ceiling
 * would be a number with no meaning, and the top bar draws this only
 * where an organisation has published a budget.
 */
export const PersonBudgetSchema = z.object({
  spentCents: z.number().int().nonnegative(),
  budgetCents: z.number().int().nonnegative(),
});
export type PersonBudget = z.infer<typeof PersonBudgetSchema>;

/**
 * The top bar's line, in the design's own words.
 *
 * Lower case because it is a status line rather than a sentence, and
 * because the phrase is quoted that way in the story it implements —
 * the screens that read it put it beside "Offline since 09:12", which
 * is the register it belongs to.
 */
export function personBudgetLine(budget: PersonBudget): string {
  return `your budget: ${moneyLabel(budget.spentCents)} of ${moneyLabel(budget.budgetCents)} today`;
}

/** Whether this person's day is over its ceiling — the question a dispatch asks. */
export function overPersonBudget(budget: PersonBudget): boolean {
  return budget.spentCents >= budget.budgetCents;
}

/**
 * One person's day, from readings that are each short in a different
 * direction (EO-328, review).
 *
 * A managed desktop has two sources for the same figure and neither is
 * complete. **The record's** total is every device's runs, but not the
 * one this machine finished a second ago — results ship on the tick.
 * **This replica's** total is this machine's runs, and it has never
 * heard of the other desktop's at all. So Anna spends her day on desktop
 * A, and desktop B's own rows say nought while the record says ten
 * dollars; a moment later the roles reverse for a run B has just
 * finished and not yet shipped.
 *
 * The largest reading is the closest to the truth, and on a *ceiling*
 * closest to the truth is also the right direction to err in.
 *
 * **One function because two callers have to agree.** The dispatch guard
 * decides whether to park an item and the top bar draws the line beside
 * it, and a person watching "$0 of $10" while their work is refused has
 * no way to tell which of the two is lying. That disagreement was real:
 * the guard combined its readings and the line did not.
 *
 * An empty list is nought rather than `-Infinity`, which is what
 * `Math.max` answers with nothing to compare — a desktop that has asked
 * nobody anything has spent nothing as far as it knows.
 */
export function personBudgetAcross(budgetCents: number, readings: readonly number[]): PersonBudget {
  return { spentCents: Math.max(0, ...readings), budgetCents };
}

/**
 * The words the sentence below opens with, before any figure.
 *
 * Exported because something has to be able to recognise one of these
 * on an item without knowing what it said: the park is idempotent on
 * "is there already an unanswered word about the budget here", and
 * matching on the comment *kind* would have the attempt-limit guard
 * silence this one. A constant both ends share is what keeps that
 * recognition from drifting away from the sentence it recognises.
 */
export const PERSON_BUDGET_REFUSAL_OPENING = "Your organisation allows";

/**
 * What the item's thread is told when a person's day is spent.
 *
 * It names the budget, because that is the acceptance criterion and
 * because a park with no figure in it is indistinguishable from every
 * other park. It says *your organisation*, not EO: this ceiling is not
 * one the person set on the Guardrails screen and telling them to go and
 * raise it there would send them to a field that does not govern this.
 *
 * "Reply to authorize more" is deliberately not offered, for
 * `jobs/budget.ts`'s reason: the per-item guard can be answered on the
 * item because the item is the thing it stopped, and this one stopped
 * a person's day.
 */
export function personBudgetRefusal(budget: PersonBudget): string {
  return (
    `${PERSON_BUDGET_REFUSAL_OPENING} ${moneyLabel(budget.budgetCents)} of work a day per person, and today has reached it ` +
    `(spent ${moneyLabel(budget.spentCents)}). Nothing was dispatched for this item, and nothing else of yours will ` +
    `start until the day turns over or your admin raises the budget.`
  );
}

/**
 * What a desktop is allowed to claim about an organisation's secret
 * (ARCHITECTURE.md, "Secrets").
 *
 * **Not "never readable", and the distinction is the whole of the design.** A module receives its
 * secrets as environment variables and an
 * agent with a shell can read its own environment, so a promise that
 * the value can never be recovered on this machine would be a promise
 * EO cannot keep and a person cannot check. What EO can honestly
 * undertake is that it does not display it: no screen renders it, no
 * IPC channel answers with it, and the only thing that ever holds it is
 * the process being spawned.
 *
 * One string, exported, so the module-secret row and the MCP-server
 * secret row say the same thing — two spellings of this would read as
 * two different states.
 */
export const ORGANISATION_SECRET_LINE = "set by your organisation · not shown here";

/**
 * The ids of the MCP servers in this desktop's catalogue that the
 * organisation put there.
 *
 * Derived from the policy rather than stored on the row (invariant 6):
 * the published list *is* the answer to "which of these are the
 * organisation's", and a column beside it would be a second copy of
 * that fact with nothing keeping the two honest — including through a
 * publish that drops one.
 */
export function managedServerIds(policy: OrganisationPolicy): string[] {
  return policy.mcpServers.map((server) => server.id);
}

/**
 * A server the organisation published that this machine could not
 * install, and why (EO-328, ARCHITECTURE.md, "Policy", review).
 *
 * It exists because the alternative was a `console.warn`. A publish that
 * collides with a local server of the same name is refused rather than
 * renaming somebody's own row — which is the right refusal — but it
 * leaves the person's catalogue showing their *own* `github` and nothing
 * at all about the organisation's, so the only evidence was a line in a
 * log nobody reads and an agent that reports a tool it was never given.
 * Invariant 12's closing sentence is the rule: an absence is never left
 * to be discovered by an agent.
 *
 * So it is state a screen can draw. Derived rather than stored on any
 * row (invariant 6): the collision is a fact about the published list
 * *and* this machine's catalogue at the same moment, and it stops being
 * true the instant either changes.
 */
export const UnavailableServerSchema = z.object({
  /** The name the organisation published it under, which is also what collided. */
  name: z.string(),
  /** One sentence, naming what to do about it. */
  problem: z.string(),
});
export type UnavailableServer = z.infer<typeof UnavailableServerSchema>;

/** Whether this catalogue row is one the organisation published. */
export function isManagedServer(policy: OrganisationPolicy, id: string): boolean {
  return policy.mcpServers.some((server) => server.id === id);
}

/**
 * Why an organisation's MCP server is not on this machine (EO-328,
 * review).
 *
 * One sentence, and it has to carry the fix rather than only the fact:
 * the person is looking at a catalogue that shows *their* `github` and
 * says nothing about the organisation's, so "it did not install" without
 * "because you already have one by that name" leaves them nowhere.
 *
 * The fix is theirs and not their admin's, which is the right way round
 * — renaming their own row is a thing they can do now, and the next sync
 * installs the organisation's beside it. Asking the admin to rename a
 * definition every other desktop already has is the worse of the two, so
 * it is offered second.
 */
export function unavailableServerProblem(name: string): string {
  return (
    `Your organisation publishes an MCP server called "${name}" and this machine has not installed it, because a server ` +
    `of your own already has that name. Rename yours and it arrives on the next sync — or ask your admin to rename theirs. ` +
    `Until then your agents are served your version, not your organisation's.`
  );
}

/**
 * Why a published MCP server cannot be edited here (EO-328, ARCHITECTURE.md, "Policy",
 * review).
 *
 * A row the organisation published is the organisation's definition of
 * how that server is reached. A device that could rewrite its command,
 * its URL or its headers would be running *something else* under a name
 * every desktop in the organisation trusts — and the next sync would
 * put the definition back, so the alteration would be both effective
 * and temporary, which is the worst of the two.
 *
 * `enabled` is deliberately not covered, and the precedent is the design's for
 * a published agent: role, prompt and tool surface are published, and
 * backend and model stay the person's. Whether a server is switched on
 * *here* is this machine's business, and a sync that flipped it back
 * every minute would be an organisation overruling a switch somebody
 * deliberately threw. A person's own value for one of its variables is
 * theirs for the same reason — and the organisation's value wins over it
 * anyway (ARCHITECTURE.md, "Secrets").
 */
export function managedServerRefusal(name: string): string {
  return (
    `"${name}" was published by your organisation, so how it is reached is not editable here — a local change would ` +
    `be undone by the next sync, and until then this machine would be running something the name does not describe. ` +
    `You can still switch it off for this machine, and you can still set your own values for the variables it needs. ` +
    `Ask your admin to change the definition.`
  );
}
