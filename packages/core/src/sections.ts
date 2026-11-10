import { z } from "zod";
import { versionLabel } from "./pipelineVersions.js";
import { ModuleTestCaseSchema, ModuleViewSchema } from "./schemas/modules.js";
import { SkillSchema } from "./schemas/skills.js";
import type { IpcChannel } from "./ipc.js";

/**
 * What an organisation publishes, and what locks when it does (EO-329,
 * `ARCHITECTURE.md`, "Publish, lock and versions").
 *
 * An admin edits pipelines, agents, packs, connectors and policy on the
 * server exactly as a solo person edits them on a desktop, and
 * **Publish** pushes a version of one of those five to every signed-in
 * desktop. The section published is the section that locks; the ones
 * that were never published stay editable locally, which is what makes
 * managed mode a choice about some of the configuration rather than all
 * of it.
 *
 * ## Per section, never per field
 *
 * the original design is explicit: "a partially locked pipeline editor is confusing to
 * read and hard to explain". So a lock is asked one question — is this
 * section published — and nothing here can answer it per pipeline, per
 * agent or per key. The rows on the record may be finer (one per
 * pipeline, because a pipeline is what carries a version to roll back
 * to); the *lock* is not.
 *
 * ## Why the channel map lives in `@eo/core`
 *
 * Because three places have to agree about it and none of them may be
 * the authority: the main process refuses on it, the renderer draws the
 * lock on it, and the MCP host's tool error names the section it gives.
 * A list in the main process with a copy in the renderer is the drift
 * that `SECTION_LOCK_TEXT` exists to prevent one sentence over.
 */

/** The five, in the order the design names them. */
export const PUBLISHED_SECTIONS = ["pipelines", "agents", "packs", "connectors", "policy"] as const;

export type PublishedSection = (typeof PUBLISHED_SECTIONS)[number];

export const PublishedSectionNameSchema = z.enum(PUBLISHED_SECTIONS);

export function isPublishedSection(value: string): value is PublishedSection {
  return (PUBLISHED_SECTIONS as readonly string[]).includes(value);
}

/** How each section is written where a person reads it. */
export const SECTION_LABELS: Record<PublishedSection, string> = {
  pipelines: "Pipelines",
  agents: "Agents",
  packs: "Packs",
  connectors: "Connectors",
  policy: "Policy",
};

/**
 * The lock text, word for word from the design.
 *
 * Two sentences, and the second is the one that matters: a lock that
 * only said what had been taken would leave a person wondering whether
 * their own sign-ins and their own folders had been taken with it. They
 * have not, and saying so is the difference between a managed
 * installation and a confiscated one.
 *
 * One constant, because it appears on five screens and a sentence
 * written five times is five sentences.
 */
export const SECTION_LOCK_TEXT =
  "Steps, routes and prompts are managed by your organisation. Your sign-ins, local folders and personal secrets are yours.";

/**
 * An agent as an organisation publishes it (the original design).
 *
 * "A published agent carries role, prompt and tool surface. Backend and
 * model stay local." So the three that travel are `role`,
 * `instructions` and the tool surface — `config.allowedTools` with the
 * MCP servers and skills attached to it — and `provider`/`model` are
 * **not** fields here at all. What is here instead is a
 * *recommendation*, used only when the agent is new to a machine and
 * something has to be written in the column: after that the person owns
 * it, through `agents:setBinding`, which is the one write into an agent
 * that a locked agents section does not refuse.
 *
 * The ids are the record's and are kept, for `RecordPipelineSchema`'s
 * reason: `agent_mcp_servers`, `runs.agent_id` and a comment's author
 * all name an agent by id, and a copy renumbered in transit would be a
 * second agent beside the one the organisation meant.
 */
export const PublishedAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  instructions: z.string(),
  /** Everything EO holds about how the agent behaves, tool surface included. Never a secret. */
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  archivedAt: z.number().nullable().default(null),
  /**
   * When the agent was deleted (EO-350). Travels so a replica keeps the
   * tombstone a tombstone — off its Agents screen, "Show archived"
   * included — rather than landing it as one more archived agent.
   */
  deletedAt: z.number().nullable().default(null),
  /** A starting point for a machine that has never seen this agent. Never applied over a choice. */
  recommendedProvider: z.string().nullable().default(null),
  recommendedModel: z.string().nullable().default(null),
  /** The tool surface, as the rows that carry it (EO-109). */
  mcpServerIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
  /**
   * How many times the record has changed this agent (EO-476). What
   * orders two copies of one agent arriving through different doors — a
   * publication and the sync's own list for a project's agents — so a
   * replica can pass over the older one, however close together the two
   * changes were. Zero from a record that predates it, which orders
   * nothing and writes as before.
   */
  revision: z.number().int().nonnegative().default(0),
});
export type PublishedAgent = z.infer<typeof PublishedAgentSchema>;

/**
 * The configuration a publish carries with it (ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The lock is only half of publishing. "An admin edits packs,
 * pipelines, agents, connectors and policy on the server exactly as a
 * solo user edits them on the desktop. **Publish** pushes a version to
 * every signed-in desktop" — so what reaches a device has to be the
 * organisation's configuration, not a lock over whatever that machine
 * happened to have.
 *
 * It travels **in the publication row** rather than as five more paged
 * lists, and that is the decision worth writing down. A publish is an
 * act with a moment attached to it: the document is what the section
 * looked like when somebody pressed Publish, which is exactly what a
 * desktop is entitled to run. Paging the tables themselves would push
 * every half-finished edit an admin makes between publishes, which is
 * the opposite of what a publish is for — and would need an
 * `updated_at` on four tables that have never had one.
 *
 * It is also why the pipelines section is not in here: a pipeline's
 * document is its *version*, which EO-327 already made immutable and
 * numbered, and the graph and its versions travel with the pipeline on
 * the sync's own `pipelines` list.
 *
 * **No secrets, ever.** A server's own secret store is the original design's separate
 * subject ("set by your organisation · not shown here"), and a
 * connector's values are in the keychain of the machine that connected
 * it. What travels is the shape of a server, never what it is
 * authenticated with.
 */
/**
 * One module as a pipelines section carries it.
 *
 * `dryRunAt` stays in the document after EO-353 removed it from the
 * module view and the database, because the document crosses versions
 * and the view does not. A desktop from before EO-353 parses a
 * publication with a module schema that *requires* `dryRunAt`, so a
 * document without it would fail that desktop's record pull outright —
 * and an organisation upgrading its desktops one at a time would have
 * every older one unable to sync. Always written null now, since nothing
 * records a dry run any more; any value a publication from before the
 * change carries is accepted and ignored on the way in.
 *
 * Retire it when no desktop from before EO-353 can still be signed in.
 */
export const PublishedModuleSchema = ModuleViewSchema.omit({ usedByStepCount: true, portability: true, machineSpecific: true, testRun: true, testsStale: true, testCount: true }).extend({
  /** Legacy, for desktops from before EO-353. Always null when this version publishes. */
  dryRunAt: z.number().nullable().default(null),
  /**
   * The module's test cases (EO-355), because approving a module runs
   * them and a module that arrived without them is one nobody here could
   * approve again.
   *
   * With the record's ids, as the module itself has: applying the same
   * publication twice leaves the same rows, and a case the organisation
   * deleted goes on every replica the next time it applies.
   *
   * Optional rather than defaulted, and the difference is a decision. A
   * publication from before this carries no field at all, and reading
   * that as "the organisation has no cases for this module" would delete
   * every case a replica holds the moment it re-applies an old document.
   * Absent leaves the replica's cases alone; present is the whole set.
   *
   * The latest *result* stays behind, as `testRun` on the view does: it
   * is the record's account of running the code, not the code.
   */
  tests: z.array(ModuleTestCaseSchema.omit({ moduleId: true })).optional(),
});

export type PublishedModule = z.infer<typeof PublishedModuleSchema>;

export const SectionDocumentSchema = z.object({
  /** The agents section. */
  agents: z.array(PublishedAgentSchema).default([]),
  /** The packs section: the skills a pack brings. */
  skills: z.array(SkillSchema).default([]),
  /**
   * The pipelines section's code half — what a `module` step runs.
   *
   * The view minus the two fields a screen derives on every read:
   * `usedByStepCount` is a tally over *this* installation's steps, and
   * `portability` is recomputed from the code. Both would be the
   * record's answers to questions about somebody else's machine, and
   * `ModuleViewSchema` whole would have made a publish refuse its own
   * document the first time an organisation had a module at all.
   */
  // `testRun`, `testsStale` and `testCount` too (EO-352, EO-354): all are this machine's
  // record of running the code, not the code. The cases themselves do
  // travel (EO-355) — see `PublishedModuleSchema.tests`.
  modules: z.array(PublishedModuleSchema).default([]),
  /**
   * **Not here: the MCP server catalogue, and the guardrails.**
   *
   * They were, and EO-328 landed the policy story in between — which
   * publishes exactly those, in `OrganisationPolicySchema`, through
   * `policy:save` and `applyPublishedMcpServers`. Two writers of
   * `mcp_servers` with two collision policies is not a thing a person
   * could reason about: that one refuses a name another row holds, this
   * one took the name and archived the local row, and which happened
   * would depend on which publish landed last.
   *
   * So the catalogue is policy's, said once, there. A connector is the
   * same table with a descriptor on it, and `PublishedMcpServerSchema`
   * does not carry that descriptor — a published connector arrives as a
   * server and is not drawn as a connector. That is a gap named here
   * rather than closed by a second copy of the table: closing it is one
   * field on policy's own schema, and policy's story owns it.
   */
});
export type SectionDocument = z.infer<typeof SectionDocumentSchema>;

/**
 * What the record published, as a device stores it and as every screen
 * reads it.
 *
 * `subjectId` is the pipeline a version belongs to, and empty for the
 * four sections that have no versions of their own yet. It is not part
 * of the lock — the lock asks about the section — it is what lets a
 * rollback name *which* pipeline goes back to v6, since a publish of
 * the pipelines section covers every pipeline the record holds.
 *
 * `publishedBy` is a person id and `publishedByName` is what to draw.
 * Both, because a device may hold the row before it holds the person:
 * the name is resolved on the record at publish time and travels with
 * the row, so "published by Dana" does not become "published by
 * 019...c3" on the one machine that most needs to read it.
 */
export const PublishedSectionSchema = z.object({
  section: PublishedSectionNameSchema,
  subjectId: z.string().default(""),
  /** A `pipeline_versions.id` for the pipelines section; null for the rest. */
  versionId: z.string().nullable().default(null),
  /** What a person reads — the `6` of "v6". Null where the section has no versions. */
  versionNumber: z.number().int().positive().nullable().default(null),
  publishedAt: z.number(),
  publishedBy: z.string().nullable().default(null),
  publishedByName: z.string().nullable().default(null),
  /**
   * What was published, for the four sections whose contents travel
   * with the act (see `SectionDocumentSchema`).
   *
   * Null on a pipelines row, whose document is the pipeline version it
   * names, and on any row a build older than this one wrote.
   */
  document: SectionDocumentSchema.nullable().default(null),
});
export type PublishedSectionView = z.infer<typeof PublishedSectionSchema>;

/**
 * The refusal a locked section answers with (ARCHITECTURE.md, "Publish, lock and versions").
 *
 * `locked: true` rather than an absent field, because this travels
 * inside an error envelope beside refusals of other kinds and a reader
 * should not have to infer the kind from which fields are present.
 *
 * `publishedBy` is the name where the record knew one and the id where
 * it did not — the same value the lock on the screen shows, so the
 * assistant's answer and the person's screen name the same somebody.
 */
export interface SectionLock {
  locked: true;
  section: PublishedSection;
  publishedBy: string | null;
}

export const SectionLockSchema = z.object({
  locked: z.literal(true),
  section: PublishedSectionNameSchema,
  publishedBy: z.string().nullable(),
});

/**
 * Which section each write belongs to.
 *
 * The lock binds **in the command layer** and therefore has to know
 * which commands are covered. The design is the whole reason: the
 * system agent's admin MCP server reaches the same handlers as the
 * renderer through `dispatchIpc`, so a lock the renderer alone knew
 * about would leave the assistant able to rewrite a published pipeline
 * from a chat.
 *
 * A channel may appear under more than one section, and two do:
 * installing a pack and importing a pipeline document each write the
 * graph *and* the pack, so either lock refuses them. Whichever section
 * is published first is the one the refusal names.
 *
 * ### What is deliberately not here, and why
 *
 * - **`settings:set`.** Its four keys are Do Not Disturb, the archive
 *   delay, the Jira pull interval and the branch prefix — a person's
 *   own preferences about their own machine, which the design says stay
 *   theirs. Policy is budgets, allowed backends and which MCP servers
 *   exist (ARCHITECTURE.md, "Policy"), and its contents are the fourth story of this phase.
 * - **`connectors:connectToken`, `connectors:connectOAuth`,
 *   `connectors:disconnect`.** Signing in to Slack with your own
 *   account is the clearest case of what the lock text promises stays
 *   yours. What a published connectors section locks is the catalogue —
 *   which connectors exist at all — and on this installation that is
 *   only ever written by a pack arriving, which is why the section's
 *   entry names the two channels that bring one.
 * - **`pipeline:moveStepItems`.** It moves work, not configuration. It
 *   is the door an admin is offered beside a strand refusal, and an
 *   item moving through the ordinary transition path is not an edit of
 *   the graph.
 */
export const SECTION_LOCKED_CHANNELS: Record<PublishedSection, readonly IpcChannel[]> = {
  // The graph and the code inside it. A module is what a `module` step
  // runs, it travels in the pipeline document on export, and a step
  // pointing at a module somebody rewrote is a different pipeline.
  pipelines: [
    "pipeline:save",
    "pipelines:create",
    "pipelines:update",
    "pipelines:delete",
    // Whether a webhook pipeline may send unread (EO-405). Part of what
    // an organisation publishes, so on a managed desktop it is the
    // administrator's — and deliberately *not* among the channels a
    // diverged copy may still use: a person editing their own copy of a
    // managed pipeline is suggesting a graph, not accepting a risk on
    // the organisation's behalf.
    "pipelines:setWebhookUnattended",
    "pipelines:import",
    "gallery:use",
    "modules:save",
    "modules:approve",
    "modules:archive",
    // Restoring a version is a save by another name (EO-360).
    "moduleVersions:restore",
    // And so is applying a change card, from either chat that draws one
    // (EO-418): the card's code and manifest written onto a module.
    "scenario:apply",
    "assist:applyChange",
    // Approve and publish on a draft card (EO-581): `modules:approve`
    // and `pipeline:save` in one act, so locked wherever either is — and
    // not among what a diverged copy may still use, since approving a
    // module never was.
    "assist:approveAndPublish",
    // And Publish on the publish card after a draft's trials (EO-588),
    // for the same reason.
    "assist:publishTrial",
  ],
  // "A published agent carries role, prompt and tool surface" (the original design),
  // which is `agents:save` for the first two and `agentAttachments:set`
  // for the third. Backend and model are on the agent row too and stay
  // the person's — the design, and the reason the agents lock never strands
  // somebody signed in to one backend and not the other. They are the
  // one thing this section does not publish, and the reason the
  // publisher's copy of an agent leaves them alone.
  // `pipelines:import` and `gallery:use` are here as well as under
  // `pipelines`, because a pack is not only a graph: `writeImport`
  // calls `writeRoles`, which creates agents carrying a pack's prompt
  // and tool surface. An import that could do that while the agents
  // section is locked would be the lock's whole subject arriving by
  // another door.
  //
  // A role's action definitions belong here too (EO-425): what a role's
  // step may answer, and so where its work can go next, is as much the
  // published agent as its prompt is.
  agents: ["agents:save", "agents:customise", "agents:archive", "agents:delete", "agentAttachments:set", "roleActions:save", "roleActions:delete", "pipelines:import", "gallery:use"],
  // A pack brings pipelines, agents, item types, skills and connectors
  // in one act, so a locked packs section is what stops one arriving
  // beside a published configuration and quietly becoming part of it.
  // Restoring a skill version and locking one are writes to the skill too (EO-714).
  packs: ["gallery:use", "pipelines:import", "skills:save", "skills:setEnabled", "skills:archive", "skills:restoreVersion", "skills:setLocked"],
  // See above: the person's own connection is theirs. What locks is the
  // catalogue, which only a pack writes — and the catalogue's *rows*
  // are published by policy (EO-328), so what this section adds is the
  // door, not a second copy of the table.
  connectors: ["gallery:use", "pipelines:import"],
  // "Which MCP servers exist" and the guardrails, which is as much of
  // the design as exists today. The rest of policy is the fourth story.
  /**
   * **Empty, and deliberately: policy is EO-328's section.**
   *
   * That story landed between this one's rounds and does the whole of
   * the design — allowed backends, per-person budgets, which MCP servers
   * exist, organisation secrets — with its own publish (`policy:save`)
   * and its own refusals in the command layer, per *row* rather than
   * per section: a published server may not be edited or archived here,
   * and whether it is switched on stays the person's.
   *
   * A section lock over the same channels would contradict that on the
   * one control it deliberately leaves alone (`mcpServers:setEnabled`)
   * and would take the guardrails with it — which nothing in the design asks
   * for and which this story's own scope puts in that fourth story.
   * Locking twice, differently, is worse than locking once.
   *
   * The name stays in `PUBLISHED_SECTIONS` because the design names five
   * sections and a person reads them as five; what publishes it is the
   * Policy screen, and `sections:publish` says so rather than writing a
   * row that would lock nothing.
   */
  policy: [],
};

/**
 * The sections a channel writes into — empty for everything a lock has
 * no opinion about.
 *
 * Ordered by `PUBLISHED_SECTIONS` rather than by the map's own key
 * order, so that a channel in two sections always refuses under the
 * same name whichever was published first.
 */
export function lockedSectionsFor(channel: string): PublishedSection[] {
  return PUBLISHED_SECTIONS.filter((section) => (SECTION_LOCKED_CHANNELS[section] as readonly string[]).includes(channel));
}

/**
 * What a caller is told, in one sentence, when the section is managed.
 *
 * Written for whoever is reading a transcript rather than a screen: the
 * renderer draws `SECTION_LOCK_TEXT` beside a disabled editor and needs
 * no sentence, while the MCP host has nothing but this — it becomes the
 * tool error, and an agent that gets "Internal error" learns nothing it
 * can say to the person who asked.
 *
 * It names the section, says nothing was written, and says what to do
 * instead. The last clause is what keeps the assistant from trying a
 * neighbouring tool, and since EO-331 it has two forms, because the
 * honest next move now differs by section.
 *
 * **Pipelines have a route out**, and it is not a way round the lock:
 * the design's suggestion, which puts the change in front of an administrator
 * instead of into the graph. So the refusal names it — an agent that
 * learns only "no" offers nothing, and the person is left to discover
 * on their own that there was a door.
 *
 * **The other four have none**, and say so in the words they said
 * before: tell the person it is managed and stop. Suggestions are for
 * pipelines and their modules (the design's scope), and a sentence that
 * offered one for `policy` would send an assistant looking for a tool
 * that does not exist.
 */
export function sectionLockedMessage(lock: SectionLock): string {
  const by = lock.publishedBy === null ? "" : ` ${lock.publishedBy} published it.`;
  const next =
    lock.section === "pipelines"
      ? `Tell the person it is managed, and offer to suggest the change instead — a suggestion goes to their administrator to approve or send back. ` +
        `Send it only if they say yes; it is asked in their name.`
      : `Tell the person it is managed and stop — an edit here is your administrator's to make.`;
  return `The ${lock.section} section is managed by your organisation.${by} Nothing has been written. ${next}`;
}

/**
 * The same refusal, for the person it is about (EO-329, ARCHITECTURE.md, "Publish, lock and
 * versions").
 *
 * `sectionLockedMessage` one function up is written for whoever is
 * reading a *transcript*: it ends by telling an assistant what to do
 * next, which is exactly the sentence a person must never be shown
 * about their own screen. The two are separate functions rather than
 * one with a flag because they are addressed to different readers, and
 * a flag is how the wrong one gets passed.
 *
 * What a person is owed here is the design's own words — the lock text,
 * which says what is managed *and* what stays theirs — plus who
 * published it, which is the only part a screen can add. Every locked
 * surface in the app draws this, so the lock a person meets on the
 * pipeline editor and the one they meet on a needs check are the same
 * sentence.
 */
export function sectionLockedLine(lock: SectionLock): string {
  return lock.publishedBy === null ? SECTION_LOCK_TEXT : `${SECTION_LOCK_TEXT} Published by ${lock.publishedBy}.`;
}

/**
 * What Publish and Roll back confirm with (the original design).
 *
 * "N items in flight across M desktops finish on v6". The count is the
 * whole point of the confirmation: a version is not retired by being
 * replaced, and an admin publishing over a busy pipeline is asking for
 * two graphs to be live at once for as long as that work takes. Telling
 * them how much is what makes it a decision.
 *
 * Counted from the record, which is the only place that knows both
 * halves — the items are its rows, and the desktops are its device
 * list.
 *
 * Nothing in flight gets the other sentence rather than "0 items in
 * flight across 3 desktops finish on v6", which reads as a warning
 * about nothing.
 */
export function publishConfirmation(input: { items: number; devices: number; finishOn: number | null }): string {
  if (input.items === 0 || input.finishOn === null) return "Nothing is in flight. Every desktop takes this version.";
  const items = `${String(input.items)} ${input.items === 1 ? "item" : "items"} in flight`;
  const devices = `across ${String(input.devices)} ${input.devices === 1 ? "desktop" : "desktops"}`;
  return `${items} ${devices} ${input.items === 1 ? "finishes" : "finish"} on ${versionLabel(input.finishOn)}.`;
}
