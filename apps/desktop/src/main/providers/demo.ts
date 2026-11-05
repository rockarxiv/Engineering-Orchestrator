import { developerType, type AgentProvider } from "@eo/core";
import { contextIsPreview } from "../preview.js";
import { createScriptedProvider } from "./scripted.js";

/**
 * What an unconfigured EO does when you describe a feature (KAN-34).
 *
 * Every agent starts on the `fake` provider, which used to answer every
 * action with one generic object:
 *
 *     { summary: "fake provider — configure a real agent in settings" }
 *
 * That satisfies no registered schema, so the very first thing anyone
 * did produced a guard escalation reading `ready: Invalid input:
 * expected true`. The intention — "the fake provider keeps the whole
 * loop exercisable, which is how EO stays useful before anyone signs
 * in" — had quietly stopped being true as each action gained a schema.
 *
 * So the demo goes as far as it honestly can: a described feature is
 * taken in, decomposed, and put in front of you at the approval gate.
 * That is the part of EO worth seeing before committing to a backend,
 * and none of it requires writing code.
 *
 * Routed on the assembled context, which states the action outright —
 * the same discriminator `createScriptedProvider` was built for, rather
 * than new machinery.
 */
export function createDemoProvider(options: { delayMs?: number } = {}): AgentProvider {
  const steps = options.delayMs ? [{ sleepMs: options.delayMs }] : undefined;
  const delayed = <T>(result: T) => ({ ...(steps ? { steps } : {}), result });
  return createScriptedProvider(
    [
      // KAN-4 gave `intake` a leaf-shaped answer alongside the container
      // one, and a demo that only ever returned the container shape
      // would leave "describe a task and watch it reach the review gate
      // as a bug" undemonstrable — the one thing nobody without a
      // configured backend could otherwise see (KAN-38). Routed on the
      // item text already in the context, the same discriminator every
      // other route here uses: a description that says `bug` is read as
      // one, same as a real product owner would from the conversation.
      {
        when: (context) => context.includes(`"intake" action`) && /\bbug\b/i.test(itemFacingContext(context)),
        script: delayed({ outcome: BUG_INTAKE_RESULT }),
      },
      { when: (context) => context.includes(`"intake" action`), script: delayed({ outcome: INTAKE_RESULT }) },
      { when: (context) => context.includes(`"refine" action`), script: delayed({ outcome: REFINE_RESULT }) },
      { when: (context) => context.includes(`"review" action`), script: delayed({ outcome: REVIEW_RESULT }) },
      // A preview, which is the one case where the refusal below is the
      // wrong answer (EO-313, ARCHITECTURE.md, "Preview").
      //
      // The refusal is right for an unconfigured EO doing real work: a
      // placeholder cannot write code and every way of pretending
      // otherwise is worse than stopping. A preview is the opposite
      // request. Nobody is asking for the story to be implemented —
      // they are asking to watch a pipeline move, before signing into
      // anything — so stopping at the first agent step with "configure
      // a backend" refuses the one thing this mode exists to offer.
      //
      // Below the routes above rather than above them, deliberately:
      // a preview that reaches `refine` or `review` should get that
      // action's real shape, not the generic one. These two are what is
      // left — the actions the demo has no answer for.
      { when: (context) => contextIsPreview(context) && context.includes(`"implement" action`), script: delayed({ outcome: PREVIEW_IMPLEMENT_RESULT }) },
      // And anything else, which on a preview means a step some
      // template defined. There is no schema to satisfy for an action
      // the registry has never heard of, and no result key to report:
      // reporting one the step does not declare would be a preview
      // taking a branch nobody wired, so it reports none and the
      // supervisor takes the step's own first declared result.
      { when: contextIsPreview, script: delayed({ outcome: PREVIEW_RESULT }) },
    ],
    // `implement`, and anything else a pipeline defines: stop, and say
    // why. A placeholder cannot write code, and every way of pretending
    // otherwise is worse than stopping — a claimed branch is rejected by
    // G-02 as "no commits", which reads like a bug rather than "you have
    // not set up an agent yet".
    // Delayed like every other branch: `delayMs` exists so a test can
    // watch a run while it is running, and a refusal that returns
    // instantly is the one dispatch nobody can ever catch mid-flight.
    { ...(steps ? { steps } : {}), throwMessage: DEMO_LIMIT_REACHED },
  );
}

/**
 * The part of the assembled context that came from the item and its
 * conversation, with what follows it cut off.
 *
 * The cut used to be load-bearing: the agent's own instructions were
 * appended after `## Dependencies`, and `system-agent.md` talks about
 * bugs at length (it is what tells the real agent to hold one to its
 * four-field bar), so matching `bug` against the whole context fired on
 * every intake dispatch, feature or not. The context no longer carries
 * the instructions at all — the provider sends them — so what this drops
 * now is the dependency summaries, which describe other items' work
 * rather than this one's and have no business deciding what this item
 * is.
 *
 * `## Dependencies` remains the honest place to cut: it is always
 * rendered, even as "None.", and it is the last section `assembleContext`
 * joins.
 */
function itemFacingContext(context: string): string {
  const cut = context.indexOf("## Dependencies");
  return cut === -1 ? context : context.slice(0, cut);
}

/**
 * Why the demo stops, in the words of the person who has to act on it.
 *
 * Carried as a provider failure so it rides the ordinary path — the run
 * fails, the reason goes in the thread, and the attempt-limit guard
 * eventually asks for a human. Inventing a second stopping mechanism
 * for this one case would be a worse trade than a slightly unusual
 * error message.
 */
export const DEMO_LIMIT_REACHED =
  "No coding agent is configured, so there is nobody to write this.\n\n" +
  "EO's built-in agents are placeholders. They can take a feature in and decompose it — which is what got you this far — " +
  "but implementing needs a real backend. Open **Agents**, point the implementer at Claude or Codex, and this story will be picked up.";

/**
 * The smallest results the real schemas accept.
 *
 * Wrapped in `outcome` because that is the envelope a real provider
 * returns under constrained generation (KAN-29). `unwrapOutcome` accepts
 * either, so this is fidelity rather than necessity — but a demo that
 * differs in shape from production is a demo that can drift from it.
 *
 * Checked against the real schemas in demo.test.ts, so adding a required
 * field breaks a test rather than only the first-run experience, which
 * nobody re-tests.
 */
const INTAKE_RESULT = {
  // Named explicitly since KAN-147: intake's shape is composed from the
  // project's item types, so there is no longer one type an answer
  // without a classification must have meant. This pack's container,
  // named as this pack's (KAN-129) — a placeholder that answered with a
  // bare word would be refused the day another pack ships the same one.
  type: developerType("feature").slug,
  ready: true as const,
  understanding:
    "A placeholder agent read this ticket. Configure a real backend in Agents to have it understood properly.",
  decisions: [],
};

/**
 * The bug-shaped answer (KAN-4/KAN-38): fixed placeholder fields, same
 * spirit as `INTAKE_RESULT` — a demo cannot actually investigate
 * anything, so it says so in every field a real bug report needs rather
 * than inventing detail it does not have.
 */
const BUG_INTAKE_RESULT = {
  type: developerType("bug").slug,
  ready: true as const,
  title: "Placeholder bug — configure a real agent for a real report",
  body: "EO's built-in agents are placeholders, so this has not actually been investigated. Point the product owner at a real backend in **Agents** and describe it again.",
  steps_to_reproduce: "Not investigated — configure a real backend.",
  expected: "Not investigated — configure a real backend.",
  actual: "Not investigated — configure a real backend.",
  environment: "Not investigated — configure a real backend.",
};

const REFINE_RESULT = {
  // Children of a stated type since KAN-147 — the decomposition schema is
  // composed from the project's work types, and a child naming none
  // would be refused by the very validation this stands in for.
  children: [
    {
      // This pack's story, named as this pack's, for the reason
      // `INTAKE_RESULT` names its container: a decomposition states each
      // child's type since KAN-147, and a bare word would be refused the
      // day another pack ships the same one.
      type: developerType("story").slug,
      title: "Placeholder story — configure a real agent for a real plan",
      body:
        "EO's built-in agents are placeholders, so this is not a decomposition of your feature. " +
        "Point the product owner at a real backend in **Agents** and refine again.",
      acceptance_criteria: ["A real agent has replaced this placeholder plan"],
      depends_on: [],
      touches: [],
    },
  ],
};

const REVIEW_RESULT = {
  verdict: "approve" as const,
  feedback: "A placeholder agent cannot review code. Configure a real backend in Agents.",
};

/**
 * What the placeholder writes on a preview's implementation step
 * (EO-313, ARCHITECTURE.md, "Preview").
 *
 * `implement` is the one pipeline action with a schema the demo had no
 * answer for, because the honest answer for real work is "no". On a
 * preview the honest answer is this: nothing was written, and here is
 * the shape of the report that would have arrived.
 *
 * Nothing here is checked against a repository, and that is deliberate
 * rather than lucky: a preview's workspace kind is `none`, which
 * vouches for nothing, so `branch` is never looked up. It says what it
 * is instead of naming a plausible branch that does not exist —
 * `min(1)` is the only thing the schema asks of it, and a field that
 * has to be filled is better filled with the truth.
 */
const PREVIEW_IMPLEMENT_RESULT = {
  branch: "none — a preview cuts no branch",
  summary: "Nothing was implemented: this is a preview, so no code was written and no branch was cut.",
  files_changed: [],
  tests_run: false,
  handoff:
    "This step ran as a preview. A real implementer would have written the change here and handed over what the " +
    "reviewer needs to know; nothing was written, and the item moved on so the rest of the pipeline can be seen.",
};

/**
 * And every other action, on a preview.
 *
 * A step a template defined, whose action the registry has no schema
 * for — so there is nothing to satisfy and nothing to get wrong. It
 * deliberately reports no result key: see the route that returns it.
 */
const PREVIEW_RESULT = {
  summary: "Nothing was done: this is a preview, so this step reported what it would have produced and moved on.",
};
