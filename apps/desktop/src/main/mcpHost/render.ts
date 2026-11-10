import {
  FROM_ENVIRONMENT_VARIABLES,
  actionOptions,
  answerOptions,
  type CommentOption,
  UNREADABLE_SERVER_SECRET_LINE,
  describeMachineSpecificWarning,
  instructionsMachineSpecificWarnings,
  isPackShipped,
  specFields,
  skillMachineSpecificWarnings,
  reservedMcpServerName,
  versionLabel,
  watchDurationWords,
  watchNeverGivesUp,
  WEBHOOK_UNATTENDED_CARD_KIND,
  WEBHOOK_UNATTENDED_LABEL,
  type IpcRequest,
  type IpcResponse,
  type ItemReference,
  type MachineSpecificWarning,
  type McpServerView,
  type MemoryConsolidationSummary,
  type MemoryConsolidationView,
  type MemorySearchEntry,
  type MemoryWriteResult,
  type ModuleTestRun,
  type RepositoryView,
  type SideCallSpendLine,
  type Skill,
  type ViewListKind,
  type ViewPipeline,
  type ViewPipelineChanges,
  type ViewResult,
  type ViewItem,
  type ViewProposedItem,
} from "@eo/core";
import { describeActionUse } from "../ipc/roleActionCommands.js";
import { isDeliverable } from "../agentAttachments/pluginDirectory.js";

/**
 * What a tool's caller reads.
 *
 * Markdown, not JSON, for the reason eoServer.mjs renders markdown: the
 * text block is what a person scrolling a transcript sees, and a wall of
 * braces tells them nothing they could act on. The machine-readable copy
 * travels beside it as `structuredContent`, so nothing is lost by
 * writing this for a reader.
 *
 * Every renderer here says plainly when it has nothing to show. "No
 * items on this project yet." is an answer; an empty string is a bug
 * report waiting to happen.
 */

/** UTC to the second. Unambiguous about the zone, sorts lexically, needs no locale. */
function stamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "unknown";
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function list(lines: string[], empty: string): string {
  return lines.length === 0 ? empty : lines.join("\n");
}

export function renderProjects(data: IpcResponse<"projects:list">): string {
  return list(
    data.projects.map((project) => {
      const active = project.id === data.activeProjectId ? " — **the project the window is showing**" : "";
      // Said on the line rather than left out (EO-347): an archived
      // project still exists, its tickets are paused rather than gone,
      // and project_restore needs its id.
      const archived = project.archivedAt === null ? "" : " — archived: nothing on it is dispatched until project_restore brings it back";
      return `- ${project.name} (id: ${project.id}, key prefix: ${project.keyPrefix})${active}${archived}`;
    }),
    "No projects yet. EO needs one before there is any work to look at.",
  );
}

/**
 * One repository, in the terms someone deciding about it needs.
 *
 * Shared by the listing and by both writes, so what a caller reads back
 * to check its own change landed is the same text the listing gives —
 * and so the commands, which repository_update exists to change, cannot
 * be reported by one and omitted by the other. The description is here
 * for that second reason: repository_update offers to change it, so a
 * caller checking its own write has to be able to see it.
 */
function repositoryLine(repository: RepositoryView): string {
  const jira = repository.jira.projectKey === null ? "" : `; Jira ${repository.jira.projectKey}`;
  // null is a value here: it means EO has nothing to run for that step,
  // which is a different claim from a command it failed to report.
  const commands = [
    `test: ${repository.testCommand ?? "none"}`,
    `lint: ${repository.lintCommand ?? "none"}`,
    `build: ${repository.buildCommand ?? "none"}`,
  ].join("; ");
  // Omitted when there is none, rather than shown as "none": on a project
  // spanning several repositories this is what a story is routed on, and
  // an empty one is worth noticing by its absence rather than reading as
  // a deliberate blank.
  const description = repository.description === null || repository.description.trim() === "" ? "" : `\n  ${repository.description}`;
  // No key prefix: it is the project's (KAN-128), and projects_list is
  // where a caller reads it. Naming one here would name a prefix this
  // repository's items need not carry — a project spanning two of them
  // numbers both from its own.
  return `${repository.name} (id: ${repository.id}, base branch ${repository.baseBranch}${jira})${description}\n  ${repository.repoPath} — ${repository.itemCount} ticket(s)\n  ${commands}${jiraSettings(repository.jira)}`;
}

/**
 * How a repository is wired to Jira, for one that is.
 *
 * Here for the reason the commands above are here: `jira_save_config`,
 * `jira_save_status_map` and `jira_save_transition_fields` answer with
 * `ok` and nothing else, so this listing is the only place a caller can
 * read back what it just wrote — and the status map in particular is
 * replaced wholesale, which is not a safe thing to do without seeing
 * what is already there.
 *
 * Nothing at all for a repository that mirrors nowhere, which is most of
 * them: five lines of "none" on every repository would bury the ones
 * that matter.
 */
function jiraSettings(jira: RepositoryView["jira"]): string {
  if (jira.connectionId === null) return "";

  const fields = Object.entries(jira.fields ?? {});
  const statuses = Object.entries(jira.statusMap ?? {});
  const lines = [
    `Jira: ${jira.projectKey ?? "no project key"} on ${jira.baseUrl ?? "a connection EO no longer has"} (connection ${jira.connectionId}) — token stored: ${jira.credentialsConfigured ? "yes" : "no"}`,
    `issue types: ${jira.featureIssueType ?? "Epic"} for features, ${jira.storyIssueType ?? "Story"} for stories; a new ticket creates an issue by default: ${jira.createByDefault ? "yes" : "no"}`,
    `extra fields sent on create: ${fields.length === 0 ? "none" : fields.map(([id, value]) => `${id}=${JSON.stringify(value)}`).join(", ")}`,
    `status map: ${statuses.length === 0 ? "empty — moving an item moves nothing in Jira" : statuses.map(([stepId, status]) => `${stepId} → ${status}`).join(", ")}`,
  ];

  // Only the statuses EO has actually been refused on: the requirement
  // is learned by being told no once, so an empty list here means "no
  // transition has asked for anything yet", not "no transition will".
  for (const [status, transition] of Object.entries(jira.transitionFields ?? {})) {
    const required = transition.requires.map((field) => `${field.name} (${field.id}: ${transition.values[field.id] === undefined ? "**not set**" : "set"})`);
    lines.push(`moving to "${status}" needs ${required.length === 0 ? "nothing beyond what EO already sends" : required.join(", ")}`);
  }

  return `\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

export function renderRepositories(data: IpcResponse<"repositories:list">): string {
  return list(
    data.repositories.map((repository) => `- ${repositoryLine(repository)}`),
    "No repositories are attached yet.",
  );
}

/**
 * Who acts on a step, in words. One phrasing, so a step described on an
 * item's screen and the same step described on its pipeline's board do
 * not read as two different things.
 */
function ownerPhrase(step: { type: string; ownerRole: string | null; entryAction: string | null }): string {
  if (step.type === "user") return "waits for the person";
  if (step.type === "builtin") return `EO runs \`${step.entryAction ?? "nothing"}\``;
  return `\`${step.ownerRole ?? "nobody"}\` runs \`${step.entryAction ?? "nothing"}\``;
}

function resultPhrase(result: ViewResult): string {
  const label = result.label === null || result.label === "" ? "" : ` (${result.label})`;
  const target = result.targetName === null ? `\`${result.target}\`` : `**${result.targetName}** (\`${result.target}\`)`;
  return `\`${result.resultKey}\`${label} → ${target}`;
}

/** Where an inherited Reference came from (EO-637); nothing for the item's own. */
function referenceSource(reference: ItemReference): string {
  return reference.inheritedFrom === null ? "" : ` (inherited from ${reference.inheritedFrom})`;
}

function renderViewItem(item: ViewItem): string[] {
  const lines = [
    `They are looking at a ticket: **${item.key}** (${item.type}) — ${item.title}`,
    "",
    `- Its id, which is what a tool takes: \`${item.id}\``,
  ];

  if (item.step) {
    const terminal = item.step.isTerminal ? ", terminal" : "";
    lines.push(`- On step **${item.step.name}** (\`${item.step.id}\`) — ${ownerPhrase(item.step)}${terminal}`);
    lines.push(
      item.step.results.length === 0
        ? "- That step declares no results, so nothing routes out of it."
        : `- That step declares: ${item.step.results.map(resultPhrase).join("; ")}`,
    );
  } else {
    // A feature. Saying so beats an omission that reads as a step nobody
    // bothered to look up.
    lines.push("- It is on no step — a feature is a container for stories rather than work of its own.");
  }

  lines.push(
    item.dependencies.length === 0
      ? "- It depends on nothing."
      : `- It depends on ${item.dependencies.map((dep) => `**${dep.key}** (${dep.title})`).join(", ")}`,
  );
  // The git kind's state on the item (KAN-169), destructured because
  // this is a sentence about a branch rather than about an extension.
  const { branch, pullRequest, baseBranch, namedBranch } = item.git;
  // A branch a person named is said to be theirs (EO-365), because what
  // an agent may do to it differs: nothing is rebased or force-pushed.
  lines.push(`- Branch: ${branch === null ? "none yet" : `\`${branch}\``}${branch !== null && namedBranch ? ", an existing branch named on this ticket — EO never rebases or force-pushes it" : ""}`);
  // Only when a person set one (EO-364): absent is the ordinary case,
  // and a line saying so on every item would be noise.
  if (baseBranch !== null) lines.push(`- Base branch: \`${baseBranch}\`, set on this ticket — its branch is cut from it and its pull request opens against it`);
  lines.push(`- Pull request: ${pullRequest === null ? "none opened" : pullRequest}`);
  // Only when one names the work (EO-637), as the base branch above.
  if (item.reference !== null) lines.push(`- Reference: \`${item.reference.value}\`${referenceSource(item.reference)}`);
  lines.push("", `"this ticket", "it" and "here" mean **${item.key}** unless they name something else.`);

  return lines;
}

function renderViewPipeline(pipeline: ViewPipeline): string[] {
  const lines = [`They are looking at a pipeline: **${pipeline.name}** (\`${pipeline.id}\`).`, ""];

  if (pipeline.steps.length === 0) {
    lines.push("It has no steps.");
    return lines;
  }

  lines.push("Its steps, in display order, and what each is holding right now:", "");
  for (const step of [...pipeline.steps].sort((a, b) => a.position - b.position)) {
    // The holds are the half a listing of the graph cannot give: asking
    // for a step to be rewired is a different act depending on whether
    // four items are sitting on it or none are.
    const holding =
      step.holding === 0
        ? "nothing here now"
        : `${step.holding} ticket${step.holding === 1 ? "" : "s"} here now${step.running === 0 ? "" : `, ${step.running} being worked`}`;
    // Keep checking as the column head says it (EO-571), so a step that
    // never gives up is said to never give up here as well.
    lines.push(`- \`${step.id}\` **${step.name}** — ${ownerPhrase(step)}, ${holding}${step.keepsChecking === null ? "" : ` · ${step.keepsChecking.toLowerCase()}`}`);
  }

  if (pipeline.paused > 0) {
    // Said after the columns and before the graph, which is where it is
    // on screen. Without it the held cards would have vanished from the
    // description entirely once they stopped being counted in a column.
    lines.push(
      "",
      `Beside the columns, a rail holds **${pipeline.paused}** card${pipeline.paused === 1 ? "" : "s"} that ${pipeline.paused === 1 ? "is" : "are"} not in any of them — work parked by hand, or an agent's question waiting on an answer. ${pipeline.paused === 1 ? "It is" : "They are"} not counted above.`,
    );
  }

  lines.push("", pipeline.routes.length === 0 ? "It declares no routes." : "Its routes — what leaves each step, and where it goes:", "");
  for (const route of pipeline.routes) {
    const from = route.fromStepName === null ? `\`${route.fromStepId}\`` : `**${route.fromStepName}** (\`${route.fromStepId}\`)`;
    lines.push(`- ${from} / ${resultPhrase(route)}`);
  }

  return lines;
}

/** What the rows of a resolved list are, in the words the screen uses. */
const LIST_NOUNS: Readonly<Record<ViewListKind, string>> = {
  items: "this project's tickets",
  agents: "the agents this installation has",
  inbox: "everything waiting on a person",
};

/**
 * The rows a filter matched, in the screen's own order.
 *
 * The cap is said out loud, and so is *what it is the first fifty of*.
 * A capped listing is only the same fifty the person can see if EO
 * reproduced their ordering, so when it could not — a column this build
 * does not sort by, or a screen whose order EO does not model — the
 * answer says the rows are a subset in no particular order rather than
 * letting "the first fifty" imply a correspondence that is not there.
 */
function renderMatching(matching: NonNullable<IpcResponse<"view:current">["view"]>["matching"]): string[] {
  if (matching === null) return [];

  const shown = matching.rows.length;
  const capped = matching.count > shown;
  const order = matching.ordered
    ? " in the order the screen shows them"
    : " — EO could not reproduce this screen's ordering, so these are matches in no particular order";
  const more = capped
    ? ` The first ${shown} are listed${order}; there are ${matching.count} in all.`
    : matching.ordered
      ? ""
      : ` Listed${order}.`;

  return [
    `EO matched the filter below against ${LIST_NOUNS[matching.of]}: **${matching.count}** row${matching.count === 1 ? "" : "s"}.${more}`,
    "",
    ...(shown === 0
      ? ["Nothing matches it."]
      : matching.rows.map((row) => `- **${row.name}** — ${row.facts.map((fact) => `${fact.label}: ${fact.value}`).join("; ")} — id \`${row.id}\``)),
  ];
}

/**
 * The three kinds of thing, kept apart on the page as well as in the
 * shape (EO-192).
 *
 * A reader skimming this has to be able to tell a row EO looked up from
 * a box the person typed into, so each gets its own heading and the
 * unsaved one says outright that nothing is stored behind it. Flattening
 * them into one description is how an agent comes to set a timeout to
 * the number somebody was halfway through typing.
 */
export function renderCurrentView(data: IpcResponse<"view:current">): string {
  if (data.view === null) {
    return [
      `There is no view to describe: ${data.absence ?? "nothing has been published."}`,
      "",
      "This is an answer, not a failure. Do not guess at a screen — ask which ticket or pipeline is meant, or work from the conversation alone.",
    ].join("\n");
  }

  const { view } = data;
  const lines = [
    "# The screen right now",
    "",
    `Read live from \`${view.route}\` at the moment you called this. If the person navigates, call it again — this answer does not update itself.`,
    "",
    "## What EO resolved",
    "",
  ];

  if (view.showing.kind === "item") lines.push(...renderViewItem(view.showing.item));
  else if (view.showing.kind === "proposedItem") lines.push(...renderViewProposedItem(view.showing.proposed));
  else if (view.showing.kind === "pipelineChanges") lines.push(...renderViewPipelineChanges(view.showing.changes));
  else if (view.showing.kind === "pipeline") {
    lines.push(...renderViewPipeline(view.showing.pipeline));
    // The board's search narrows its cards, so the counts above are of
    // the narrowed board rather than of the pipeline. Saying which
    // matters most on exactly the request this widget exists for: "move
    // everything out of Review" means the cards in front of them.
    if ((view.parameters.filter?.text ?? "").trim() !== "") {
      lines.push(
        "",
        "**The board is narrowed by the search below**, and the counts above are of the cards it is showing — not of everything on this pipeline. Anything you are asked to do to \"these\" means those cards.",
      );
    }
  } else lines.push(`They are on **${view.showing.screen.name}** — ${view.showing.screen.describes}`);

  if (view.matching !== null) lines.push("", ...renderMatching(view.matching));
  else if (view.parameters.filter !== null && view.showing.kind === "screen") {
    // A filter with no rows beside it would otherwise read as "nothing
    // matches", which is a different claim and usually a false one: the
    // Agents screen's Runtimes tab has a tab but no agent list, and
    // several screens narrow something EO does not model. Saying which
    // it is costs a line.
    //
    // Only where the screen *is* a list. A narrowed board has no list
    // beside it because its columns are the list, and they are resolved
    // above — saying EO could not list this screen there would be false
    // about the one screen whose rows it just counted.
    lines.push("", "EO does not resolve the rows of this screen's list, so what is on it is not listed below. The filter itself is a view parameter and is reported as one.");
  }

  lines.push("", "## The view's own parameters", "", "These are facts about the screen, not about the work.", "");
  const { filter, selection, sort } = view.parameters;
  if (filter === null) {
    lines.push("- Filter: this screen has none.");
  } else {
    // `all` and `false` are a dropdown at rest and a toggle that is off
    // — not filters. Listing them would read as seven filters set on a
    // screen nobody has narrowed, and the whole value of this line is
    // that an agent can tell a narrowed list from a whole one.
    const facets = Object.entries(filter.facets)
      .filter(([, value]) => value !== "all" && value !== "false" && value !== "")
      .map(([name, value]) => `${name}=${value}`);
    lines.push(`- Filter text, as typed: ${filter.text.trim() === "" ? "(empty)" : `"${filter.text}"`}`);
    lines.push(`- Filters set: ${facets.length === 0 ? "none" : facets.join(", ")}`);
  }
  lines.push(`- Selected: ${selection.length === 0 ? "nothing" : selection.map((id) => `\`${id}\``).join(", ")}`);
  lines.push(`- Ordered by: ${sort === null ? "the screen's own default" : `\`${sort}\``}`);

  lines.push(
    "",
    "## Typed and not saved",
    "",
    ...(view.unsavedEdits.length === 0
      ? [
          // Not "every field holds what is stored", which is a claim EO
          // cannot make. The screen reports what it reports: a field
          // whose section does not publish, and every credential —
          // deliberately, since a Jira token typed and not saved must
          // not reach an agent's context — is absent from this list
          // whether or not somebody is halfway through typing it. An
          // empty list means nothing was *reported*, and saying more
          // than that would be the same lie the list exists to prevent.
          "Nothing has been reported as unsaved. That is not a guarantee that every field holds what is stored — a screen reports the edits it knows how to report, and never a credential. If a stored value matters, read it with the tool that owns it rather than assuming this.",
        ]
      : [
          "**These are not stored values.** They are what the person has typed into a field and not saved, so nothing in EO holds them and reading one back as configuration would be wrong.",
          "",
          ...view.unsavedEdits.map((edit) => `- ${edit.field}: ${edit.value === "" ? "(cleared)" : edit.value}`),
        ]),
  );

  if (view.matching !== null || view.parameters.filter !== null) {
    lines.push(
      "",
      "Before acting on a filtered set, say back which rows you are about to touch. Acting on a misread filter is worse than a sentence of confirmation.",
    );
  }

  return lines.join("\n");
}

/**
 * A proposed item, said as what it is (EO-408): not filed, with no key
 * and no id, so nothing here can be handed to a tool that takes either.
 *
 * The person has it open beside the conversation, so "this one" is this.
 * Changing it means proposing again — a proposal is approved whole or not
 * at all — and the last lines say which of the two is still possible.
 */
function renderViewProposedItem(proposed: ViewProposedItem): string[] {
  const state: Record<ViewProposedItem["state"], string> = {
    open: "The proposal is waiting to be approved. Nothing has been created. To change this item, propose the work again with the change made: the person approves a proposal whole, and a new one replaces this.",
    applied: "The proposal was approved, so the work it describes has been created. This is what was proposed, not the item as it stands now.",
    refused: "The proposal was approved and could not be applied; the reason is in the conversation. Nothing was created from it.",
    superseded: "A newer proposal has replaced the one this is part of, so it can no longer be approved.",
    closed: "The conversation this proposal is in has been put away, so it can no longer be approved.",
  };
  return [
    `They have a **proposed, unfiled ${proposed.type}** open: **${proposed.title}**.`,
    "",
    `It is not filed yet — it has no key and no id, and no tool can read or change it. It is item ${proposed.position} of ${proposed.proposedTogether} in a proposal made in the assistant conversation.`,
    "",
    ...(proposed.container === null ? [] : [`- Under: ${proposed.container}`]),
    `- Would be created on: ${proposed.landsOn ?? "not decided — the project has no single pipeline for it to land on"}`,
    `- Waits on: ${proposed.waitsOn.length === 0 ? "nothing" : proposed.waitsOn.join("; ")}`,
    ...(proposed.acceptanceCriteria.length === 0
      ? ["- Acceptance criteria: none"]
      : ["- Acceptance criteria:", ...proposed.acceptanceCriteria.map((criterion) => `  - ${criterion}`)]),
    "",
    state[proposed.state],
  ];
}

/**
 * A pipeline's Changes view (EO-524): which pipeline, which versions are
 * compared, and what the comparison found, by name.
 *
 * Read-only on screen, and said so: nothing on it changes the pipeline,
 * so "undo this" asked from here is a draft the agent proposes like any
 * other — against the pipeline named here.
 */
function renderViewPipelineChanges(changes: ViewPipelineChanges): string[] {
  const lines = [`They are looking at the **Changes** view of a pipeline: **${changes.name}** (\`${changes.id}\`). It is a read-only diff; nothing on it changes the pipeline.`, ""];
  const by = (version: { createdByName: string | null; createdAt: number }) =>
    `${version.createdByName === null ? "saved by EO" : `saved by ${version.createdByName}`}${version.createdAt > 0 ? `, ${new Date(version.createdAt).toISOString()}` : ""}`;
  const found = (diff: Pick<NonNullable<ViewPipelineChanges["versions"]>, "steps" | "routes">) => [
    ...(diff.steps.length === 0 ? ["- No step was added, removed or edited."] : diff.steps.map((step) => `- Step **${step.name}**: ${step.change}`)),
    ...(diff.routes.length === 0 ? ["- No route changed."] : diff.routes.map((route) => `- Route **${route.fromStepName}** / \`${route.resultKey}\`: ${route.change}`)),
  ];

  if (changes.local !== null) {
    lines.push(
      `**This machine's own edits**, against ${versionLabel(changes.local.basedOn)} — the organisation's version this copy was based on. They are published nowhere.`,
      "",
      ...found(changes.local),
      "",
    );
  }
  if (changes.versions !== null) {
    const { from, to } = changes.versions;
    lines.push(`Comparing **${versionLabel(from.number)}** (${by(from)}) with **${versionLabel(to.number)}** (${by(to)}):`, "", ...found(changes.versions));
  }
  if (changes.local === null && changes.versions === null) {
    lines.push("There is nothing to compare: the pipeline has one version, or the edits this view was opened on are not there.");
  }
  return lines;
}

export function renderItems(data: IpcResponse<"items:list">): string {
  return list(
    data.items.map((item) => {
      const marks: string[] = [];
      if (item.needsAttention) marks.push("needs attention");
      if (item.heldAt !== null) marks.push("held");
      if (item.openDependencyCount > 0) marks.push(`waiting on ${item.openDependencyCount}`);
      if (item.latestRunStatus !== null) marks.push(`last run ${item.latestRunStatus}`);
      const suffix = marks.length > 0 ? ` [${marks.join("; ")}]` : "";
      const who = item.assigneeName === null ? "" : ` — ${item.assigneeName}`;
      return `- ${item.key} (${item.type}, ${item.stepName})${who} — ${item.title}${suffix}`;
    }),
    "No tickets here.",
  );
}

/**
 * Whether an `item_get` call named any of the parameters that pick its
 * sections or narrow them (EO-540).
 *
 * A call that named none is rendered exactly as it was before they
 * existed. One that named any is rendered from what came back: every
 * section it holds, transitions and the decision included, and a line
 * saying so where a section asked for came back empty.
 */
function namesSections(request: IpcRequest<"items:getSections"> | undefined): boolean {
  if (request === undefined) return false;
  const { include, commentsLimit, commentsSince, pinnedOnly, runsLimit } = request;
  return [include, commentsLimit, commentsSince, pinnedOnly, runsLimit].some((value) => value !== undefined);
}

export function renderItem(data: IpcResponse<"items:getSections">, request?: IpcRequest<"items:getSections">): string {
  if (data === null) return "No ticket with that id. Call tickets_list for the ones that exist.";

  const narrowed = namesSections(request);
  const { item, runs, comments, dependsOn, transitions, decision } = data;
  const lines: string[] = [];
  if (item !== undefined) {
    lines.push(
      `# ${item.key} — ${item.title}`,
      "",
      `- id: ${item.id}`,
      `- type: ${item.type}`,
      `- step: ${item.stepName}`,
      `- priority: ${item.priority}`,
    );
    if (item.repositoryName !== null) lines.push(`- repository: ${item.repositoryName}`);
    const { branch, pullRequest, baseBranch, namedBranch } = item.git;
    if (branch !== null) lines.push(`- branch: ${branch}${namedBranch ? " (an existing branch, named on this ticket)" : ""}`);
    if (baseBranch !== null) lines.push(`- base branch: ${baseBranch}`);
    if (pullRequest !== null) lines.push(`- pull request: ${pullRequest}`);
    if (item.reference !== null) lines.push(`- reference: ${item.reference.value}${referenceSource(item.reference)}`);
    if (item.jiraKey !== null) lines.push(`- Jira: ${item.jiraKey}`);
    if (item.heldAt !== null) lines.push(`- **held** since ${stamp(item.heldAt)} — the scheduler will not pick it up until it is resumed`);
    if (item.needsAttention) lines.push("- **needs attention** — someone is waiting on a person");

    const active = runs?.find((run) => run.status === "queued" || run.status === "running");
    if (active) lines.push(`- **a run is in progress** (${active.agentName}, ${active.action}) — moving or deleting this ticket will refuse unless the run is cancelled`);

    if (typeof item.body === "string" && item.body.trim() !== "") lines.push("", "## Description", "", item.body);
    if (item.acceptanceCriteria.length > 0) lines.push("", "## Acceptance criteria", "", ...item.acceptanceCriteria.map((item) => `- ${item}`));
    // The item's own files (EO-704), with the ids item_update's
    // removeAttachmentIds takes. A comment's files stay on its comment.
    const files = item.attachments ?? [];
    if (files.length > 0) lines.push("", "## Files", "", ...files.map((file) => `- attachment ${file.id}: ${file.name} (${file.mimeType}, ${file.size} bytes)`));
    if (item.parentKey !== null) lines.push("", `## Parent`, "", `${item.parentKey} — ${item.parentTitle ?? ""}`.trimEnd());
  }
  if (dependsOn !== undefined && dependsOn.length > 0) {
    lines.push("", "## Waits for", "", ...dependsOn.map((dep) => `- ${dep.key} (${dep.stepName}) — ${dep.title}`));
  } else if (narrowed && dependsOn !== undefined) {
    lines.push("", "## Waits for", "", "Nothing — it waits on no other ticket.");
  }

  if (narrowed && decision !== undefined) {
    lines.push("", "## Decision", "");
    if (decision.length === 0) lines.push("Nothing to decide here: the ticket is not on a step that waits on a person's decision.");
    else lines.push(...decision.map((result) => `- ${result.label} (${result.key})${result.targetName === null ? "" : ` → ${result.targetName}`}`), "", "Decide with item_decide.");
  }

  if (runs !== undefined && runs.length > 0) {
    lines.push("", "## Runs", "");
    for (const run of runs) {
      const cost = run.costCents === null ? "" : `, ${money(run.costCents)}`;
      const verdict = run.verificationOk === null ? "" : `, verification ${run.verificationOk ? "passed" : "failed"}`;
      lines.push(`- ${run.id} — ${run.agentName} ${run.action}: ${run.status} (attempt ${run.attempt}${cost}${verdict})`);
      if (run.error !== null) lines.push(`  - error: ${run.error}`);
    }
    lines.push("", "Read one with run_events.");
  } else if (narrowed && runs !== undefined) {
    lines.push("", "## Runs", "", "None.");
  }

  if (narrowed && transitions !== undefined) {
    lines.push("", "## Transitions", "");
    if (transitions.length === 0) lines.push("None — it has not moved.");
    for (const transition of transitions) {
      const reason = transition.reason === null ? "" : ` — ${transition.reason}`;
      lines.push(`- ${stamp(transition.ts)} ${transition.fromStepId ?? "(entered)"} → ${transition.toStepId}, by ${transition.actor}${reason}`);
    }
  }

  if (comments !== undefined && comments.length > 0) {
    lines.push("", "## Thread", "");
    for (const comment of comments) {
      const role = comment.authorRole === null ? "" : ` (${comment.authorRole})`;
      const pin = comment.pinned ? " [pinned]" : "";
      const waiting = comment.awaitingHuman ? " [waiting on you]" : "";
      const indent = comment.parentId === null ? "" : "> ";
      lines.push(`${indent}### ${comment.authorName}${role} — ${comment.kind}${pin}${waiting} — ${stamp(comment.createdAt)}`);
      lines.push(indent.trimEnd());
      lines.push(...(comment.body || "(attachment only)").split("\n").map((line) => `${indent}${line}`));
      lines.push(...offeredLines(comment.options, indent));
      for (const attachment of comment.attachments ?? []) {
        lines.push(`${indent}- attachment ${attachment.id}: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`);
      }
      lines.push(indent.trimEnd());
    }
  } else if (narrowed && comments !== undefined) {
    lines.push("", "## Thread", "", "No comments match.");
  }

  // A call that left the ticket out starts at its first section, not
  // at the blank line that would have separated it from the header.
  while (lines[0] === "") lines.shift();
  return lines.join("\n");
}

export function renderInbox(data: IpcResponse<"inbox:list">): string {
  const header = data.summary.everythingBlocked
    ? "**Every ticket that could be moving is waiting on a person.** The pipeline is idle."
    : `${data.summary.openCount} open, ${data.summary.blockingCount} blocking.`;

  if (data.items.length === 0) return `${header}\n\nNothing is waiting on anyone.`;

  const items = data.items.map((item) => {
    const options = offeredLines(item.options, "  ").map((line) => (line.trim() === "" ? "" : `\n${line}`)).join("");
    const first = item.body.split("\n")[0] ?? "";
    return `- ${item.blocking ? "**BLOCKING** " : ""}${item.itemKey} — ${item.itemTitle}\n  ${item.authorName} (${item.kind}, ${stamp(item.createdAt)}): ${first}${options}\n  Reply with comment_post using itemId ${item.itemId} and parentId ${item.commentId}.`;
  });

  return `${header}\n\n${items.join("\n")}`;
}

export function renderRunEvents(data: IpcResponse<"runs:listEvents">): string {
  const events = data.events.map((event) => `[${event.seq}] ${stamp(event.ts)} ${event.type}: ${JSON.stringify(event.payload)}`);
  const more =
    data.nextSeq === null
      ? "\n\n(end of the log so far)"
      : `\n\n(more — call run_events again with fromSeq: ${data.nextSeq})`;
  return `${list(events, "This run has recorded no events.")}${more}`;
}

/** A count of tokens, grouped by thousands so a six-figure input reads at a glance. */
function tokens(count: number | null): string {
  return count === null ? "?" : count.toLocaleString("en-US");
}

/** Minutes to one place, from a duration in milliseconds. */
function minutesOf(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * Runs across items (EO-541): one line each, with what it was, how it
 * ended, how long it took and what it cost. Side calls are lines like
 * any other, under their `side_call:<purpose>` action.
 */
export function renderRuns(data: IpcResponse<"runs:list">): string {
  if (data.runs.length === 0) return "No runs match.";
  const lines = data.runs.map((run) => {
    const on = run.itemKey ?? "no item";
    const backend = run.backend === null ? "EO itself" : `${run.backend}/${run.model ?? "default model"}`;
    const took = run.durationMs === null ? "not ended" : minutesOf(run.durationMs);
    const cost = run.costMicrocents === null ? "cost unknown" : `$${(run.costMicrocents / 100_000_000).toFixed(4)}`;
    const extras = [
      run.attempt !== null && run.attempt > 1 ? `attempt ${run.attempt}` : null,
      run.verdict !== null ? `verdict ${run.verdict}` : null,
      run.interruption !== null ? `interrupted by ${run.interruption}` : null,
      run.threadId !== null ? `thread ${run.threadId}` : null,
      run.memoryDelivered !== null && run.memoryUsed !== null ? `memory ${run.memoryDelivered} delivered, ${run.memoryUsed} used` : null,
    ].filter((extra): extra is string => extra !== null);
    return (
      `- ${on} ${run.action} · ${backend} · ${run.status} · started ${stamp(run.startedAt)} · ${took} · ` +
      `${tokens(run.tokensIn)} in / ${tokens(run.tokensOut)} out · ${cost}${extras.length > 0 ? ` · ${extras.join(" · ")}` : ""}`
    );
  });
  return `${data.runs.length} run(s), newest first.\n\n${lines.join("\n")}`;
}

/** One group's figures, or the whole set's, on one line. */
function runTotalsLine(totals: IpcResponse<"runs:summary">["overall"]): string {
  const elapsed = totals.elapsedMinutes === null ? "none ended" : `${totals.elapsedMinutes} min elapsed`;
  const reviews = totals.reviews === 0 ? "" : ` · ${totals.rejections} of ${totals.reviews} review(s) rejected`;
  return (
    `${totals.count} run(s) · ${totals.activeMinutes} min active · ${elapsed} · ` +
    `${tokens(totals.tokensIn)} in / ${tokens(totals.tokensOut)} out · ${money(totals.costCents)}${reviews}`
  );
}

/** Runs added up per item, action, backend or day (EO-541). */
export function renderRunSummary(data: IpcResponse<"runs:summary">): string {
  if (data.overall.count === 0) return "No runs match.";
  const none = data.groupBy === "day" ? "not started" : data.groupBy === "backend" ? "EO itself" : "no item";
  const groups = data.groups.map((group) => `- ${group.key ?? none}: ${runTotalsLine(group)}`);
  return `By ${data.groupBy}. All of them: ${runTotalsLine(data.overall)}.\n\n${groups.join("\n")}`;
}

/** One memory entry's facts on one line: where it is, where it came from, and what became of it. */
function memoryEntryLine(entry: MemorySearchEntry): string {
  const scope = `${entry.scope.kind} ${entry.scope.name ?? entry.scope.id}`;
  const source =
    entry.source.type === "person"
      ? "a person"
      : `${entry.extracted ? "extracted from a run" : "a run's note"}${entry.source.itemKey !== null ? ` on ${entry.source.itemKey}` : ""}`;
  const state = entry.state === "active" ? "active" : `${entry.state} (${entry.retiredReason ?? "retired"}) ${stamp(entry.retiredAt)}`;
  const extras = [
    entry.contradictsRepositoryFile ? "contradicts a repository file" : null,
    entry.consolidationId !== null ? `consolidation ${entry.consolidationId}` : null,
    entry.score !== undefined ? `score ${entry.score.toPrecision(3)}` : null,
  ].filter((extra): extra is string => extra !== null);
  // Every entry, so one given often and never used stands out (EO-597).
  const usage = `delivered to ${entry.deliveries} run(s), used by ${entry.uses}`;
  return `${entry.id} · ${scope} · ${source} · ${state} · written ${stamp(entry.createdAt)} · ${usage}${extras.length > 0 ? ` · ${extras.join(" · ")}` : ""}`;
}

/** Memory entries across scopes (EO-545): each one's facts, and what it says beneath them. */
export function renderMemorySearch(data: IpcResponse<"memory:search">): string {
  if (data.entries.length === 0) return "No memory entries match.";
  const ranked = data.entries.some((entry) => entry.score !== undefined);
  const lines = data.entries.map((entry) => `- ${memoryEntryLine(entry)}\n  ${entry.body.replaceAll("\n", "\n  ")}`);
  return `${data.entries.length} entr${data.entries.length === 1 ? "y" : "ies"}, ${ranked ? "best match first" : "newest first"}.\n\n${lines.join("\n")}`;
}

/** A consolidation's figures on one line. */
function consolidationLine(consolidation: MemoryConsolidationSummary): string {
  const ended = consolidation.finishedAt === null ? "not finished" : `finished ${stamp(consolidation.finishedAt)}`;
  const restored = consolidation.restored ? ` · restored ${stamp(consolidation.restoredAt)}` : "";
  const note = consolidation.note === null ? "" : ` — ${consolidation.note}`;
  return (
    `${consolidation.id} · ${consolidation.status} (${consolidation.trigger}) · started ${stamp(consolidation.startedAt)} · ${ended} · ` +
    `replaced ${consolidation.replacedCount}, produced ${consolidation.producedCount}${restored}${note}`
  );
}

/** One memory entry and its history (EO-545). */
export function renderMemoryEntry(data: IpcResponse<"memory:get">): string {
  if (!data.ok) return data.problem;
  const replaced =
    data.replaced.length === 0
      ? "It replaced no earlier version through an edit."
      : `Earlier versions it replaced through edits, newest first:\n${data.replaced.map((entry) => `- ${memoryEntryLine(entry)}\n  ${entry.body.replaceAll("\n", "\n  ")}`).join("\n")}`;
  // The entries a note named as the ones it corrects or repeats (EO-594).
  const superseded =
    data.superseded.length === 0
      ? "It superseded no entry."
      : `Entries it superseded as a note, as it named them:\n${data.superseded.map((entry) => `- ${memoryEntryLine(entry)}\n  ${entry.body.replaceAll("\n", "\n  ")}`).join("\n")}`;
  const produced = data.producedBy === null ? "No consolidation wrote it." : `Written by consolidation ${consolidationLine(data.producedBy)}`;
  const retired = data.retiredBy === null ? "No consolidation retired it." : `Retired by consolidation ${consolidationLine(data.retiredBy)}`;
  return `${memoryEntryLine(data.entry)}\n\n${data.entry.body}\n\n${replaced}\n\n${superseded}\n\n${produced}\n${retired}`;
}

/** A scope's consolidations, newest first (EO-545), after whether one is queued or running now (EO-589). */
export function renderMemoryConsolidations(data: IpcResponse<"memory:consolidations">): string {
  const listed = list(
    data.consolidations.map((consolidation) => `- ${consolidationLine(consolidation)}`),
    "This scope has never been consolidated.",
  );
  return data.pending === null ? listed : `A consolidation of this scope is ${data.pending} now.\n\n${listed}`;
}

/** What came of asking for a scope to be consolidated now (EO-589): EO's sentence, and where the outcome is read. */
export function renderMemoryConsolidateNow(data: IpcResponse<"memory:consolidateNow">): string {
  if (data.outcome === "refused") return data.message;
  return `${data.message}\n\nmemory_consolidations_list shows it, and how it ended once it has.`;
}

/**
 * What a memory write left (EO-546): the entry as it now stands, after a
 * sentence saying what was done — or, refused, the reason.
 */
export function renderMemoryWritten(done: string): (data: MemoryWriteResult) => string {
  return (data) => {
    if (!data.ok) return data.problem;
    const entry = data.entry;
    const source = entry.source.type === "person" ? "a person" : entry.source.extracted === true ? "extracted from a run" : "a run's note";
    const state = entry.retiredAt === null ? "active" : `retired (${entry.retiredReason ?? "retired"}) ${stamp(entry.retiredAt)}`;
    return `${done}\n\n${entry.id} · ${entry.scope.kind} ${entry.scope.id} · ${source} · ${state} · written ${stamp(entry.createdAt)}\n\n${entry.body}`;
  };
}

/** A consolidation undone (EO-546), and every entry it touched as each now stands. */
export interface MemoryConsolidationRestored {
  ok: true;
  consolidation: MemoryConsolidationView;
  /** How many entries are active again: what it retired, and evidence a skill it proposed took. */
  restored: number;
  /** How many entries it had written are retired now. */
  retired: number;
  /** Every entry the restore changed, by id. */
  changedIds: string[];
  /** Those entries, read after the restore. */
  entries: MemorySearchEntry[];
  /** Why they could not be read, where the restore was done and the read back was not. */
  entriesUnread?: string;
}

export function renderMemoryConsolidationRestored(data: MemoryConsolidationRestored): string {
  const lines = data.entries.map((entry) => `- ${memoryEntryLine(entry)}\n  ${entry.body.replaceAll("\n", "\n  ")}`);
  return (
    `Restored the set from before consolidation ${data.consolidation.id}: ${data.restored} entr${data.restored === 1 ? "y" : "ies"} ` +
    `${data.restored === 1 ? "is" : "are"} active again, and ${data.retired} it produced ${data.retired === 1 ? "is" : "are"} retired.` +
    (lines.length === 0 ? "" : `\n\nThe entries it touched, as they now stand:\n${lines.join("\n")}`)
  );
}

export function renderEngineStatus(data: IpcResponse<"engine:status">): string {
  return data.paused
    ? `Dispatch is **paused**. ${data.activeRunCount} run(s) still in flight. Nothing new will start until engine_resume, except the system agent's runs, which carry on while paused.`
    : `Dispatch is running. ${data.activeRunCount} run(s) in flight.`;
}

export function renderAgents(data: IpcResponse<"agents:listDetailed">): string {
  return list(
    data.agents.map((agent) => {
      const model = agent.model === null ? "provider default" : agent.model;
      // Retired agents are listed and said to be retired (EO-186). The
      // row is kept so an old run still has a name, and a caller reading
      // this to decide who can own a step has to be able to tell one
      // from an agent that would actually run — archived beats disabled
      // in the mark, because it is the one nothing reverses.
      const state = agent.archivedAt !== null ? " — archived" : agent.enabled ? "" : " — disabled";
      return `- ${agent.name} (id: ${agent.id}, role ${agent.role}, ${agent.provider}/${model})${state}`;
    }),
    "No agents are configured.",
  );
}

/**
 * The registry (KAN-124): what a step may run and return, said in the
 * words a client writing a pipeline needs — a builtin step names one of
 * these functions and routes each of its results.
 *
 * **`itemTypes` is deliberately not rendered here.** A project's types
 * have a tool of their own, `item_types_list` (EO-523), which reads them
 * through `itemTypes:list` with the row ids the assistant's item-type
 * cards name and says which are a pack's — see `renderItemTypes`. The
 * registry's copy is keyed by qualified slug and carries no id, so
 * rendering it here as well would be the same types twice, one of them
 * unusable for the thing a reader wants a type's id for.
 */
/**
 * A project's item types (EO-523): each one's id, names, the word items
 * are filed under, whether it holds other items, how many items are of
 * it, its fields, and whether a pack ships it — which is what decides
 * what of it may change. The ids are what the assistant's item-type
 * cards name.
 */
export function renderItemTypes(data: IpcResponse<"itemTypes:list">): string {
  return list(
    data.types.map((type) => {
      const owner = isPackShipped(type)
        ? `a ${type.packSlug} pack's type — only its label and plural can change, and it cannot be deleted`
        : "made here — its label, plural, fields and container flag can change, and it can be deleted while no item is of it";
      const fields = specFields(type.specShape).map((field) => {
        const notes = [
          field.kind,
          field.required ? "required" : "optional",
          ...(field.values === undefined ? [] : [`one of ${field.values.join(", ")}`]),
          ...(field.criteria ? ["holds the acceptance criteria"] : []),
        ];
        return `  - field \`${field.name}\` (${notes.join(", ")})${field.description === undefined ? "" : ` — ${field.description}`}`;
      });
      return [
        `- ${type.label} / ${type.plural} (id: ${type.id}, filed as \`${type.slug}\`, ${type.container ? "holds other items" : "is the work"}, ${type.itemCount} item(s) of it)`,
        `  ${owner}`,
        ...(fields.length === 0 ? ["  no fields: an item of it carries a title and a description only"] : fields),
      ].join("\n");
    }),
    "This project has no item types.",
  );
}

export function renderRegistry(data: IpcResponse<"registry:get">): string {
  const reuse = (value: boolean | "per-conversation"): string =>
    value === "per-conversation" ? "one thread per conversation" : value ? "one thread per ticket" : "a fresh thread per run";
  // The action catalog (EO-425): the pack's actions under the role that
  // ships them, then the ones roles defined for themselves. One list in
  // one shape, because a client writing a step asks the same thing of
  // both — which keys must this step route — and the one difference that
  // matters to it, whether it may edit the entry, is said on the line.
  const catalog = [
    ...data.roles.map((role) => ({ role: role.slug, actions: role.actions ?? [] })),
    ...(data.roleActions ?? []),
  ].flatMap(({ role, actions }) =>
    actions.flatMap((action) => {
      const lines = [
        `- ${role} / ${action.action} (${action.packShipped ? "ships with the role, read-only" : "defined by the role"})${action.description === "" ? "" : ` — ${action.description}`}`,
        ...action.results.map((result) => {
          const meaning = result.meaning === undefined || result.meaning === "" ? "" : ` — ${result.meaning}`;
          return `  - result \`${result.key}\` (${result.label})${meaning}`;
        }),
      ];
      if (action.fields !== undefined && Object.keys(action.fields).length > 0) lines.push(`  - fields: ${JSON.stringify(action.fields)}`);
      const usedBy = action.usedBy ?? [];
      lines.push(
        usedBy.length === 0 ? "  - used by no step" : `  - used by ${usedBy.map(describeActionUse).join(", ")}`,
      );
      return lines;
    }),
  );

  return [
    "Built-in roles:",
    list(
      data.roles.map((role) => `- ${role.slug} (${reuse(role.threadReuse)})`),
      "None.",
    ),
    "",
    "Actions an agent step can dispatch, by role, with the result keys each can return — a step must route every one:",
    list(catalog, "None."),
    "",
    "Built-in functions a builtin step can run, with the results each can return:",
    list(
      data.builtins.map((builtin) => `- ${builtin.action}: ${builtin.results.join(", ")}`),
      "None.",
    ),
    "",
    "Entry rule kinds, beyond `field`, `description` and `workspace`:",
    list(
      (data.entryRuleKinds ?? []).map((entry) => `- ${entry.kind}: asks for ${entry.noun}`),
      "None.",
    ),
  ].join("\n");
}

export function renderPipelines(data: IpcResponse<"pipelines:list">): string {
  return list(
    data.pipelines.map((pipeline) => `- ${pipeline.name} (id: ${pipeline.id})${pipeline.archivedAt === null ? "" : " — archived"}`),
    "No pipelines on this project.",
  );
}

export function renderPipeline(data: IpcResponse<"pipelineSteps:list">): string {
  if (data.steps.length === 0) return "This pipeline has no steps yet.";

  const lines = ["## Steps", ""];
  for (const step of data.steps) {
    const marks: string[] = [step.type];
    if (step.id === data.entryStepId) marks.push("work enters here");
    if (step.isTerminal) marks.push("terminal");
    if (step.ownerRole !== null) marks.push(`role ${step.ownerRole}`);
    lines.push(`- ${step.name} (id: ${step.id}) [${marks.join("; ")}]`);
    // Whether it reaches outside EO (EO-584): what a trial's plan decides
    // to run for real, redirect or mock, said on the step it is about.
    const reach = outsideReachLine(data.outsideReach[step.id]);
    if (reach !== null) lines.push(`  ${reach}`);
    // What a person may answer here, and which answers refuse to be
    // given without a reason (EO-310). Said on the step rather than left
    // to the routes below, because the routes say where a key *goes* and
    // this says which of them `item_decide` will take at all — an agent
    // that read only the routes would call it with a key nothing there
    // can choose, and an absence discovered by an agent is what
    // invariant 12 is about.
    if (step.results.length > 0) {
      const offered = step.results.map((result) => `\`${result.key}\` (${result.label}${result.requiresComment ? ", needs a comment" : ""})`);
      lines.push(`  decided with item_decide: ${offered.join(", ")}`);
    }
    // Keep checking, with the field and its values as pipeline_save takes
    // them (EO-506). A graph republished from this text without them used
    // to turn the step into one that runs once, and it was never said
    // here that the step was anything else — the absence an agent was
    // left to discover. Only on a step that keeps checking: a step that
    // runs once is the ordinary case and says nothing.
    // A watch that never gives up (EO-571) is said as one, with the flag
    // as pipeline_save takes it and no hours: they are not read, and a
    // number beside "never" reads as a deadline somebody might reach.
    if (step.watch !== null) {
      const { everyMinutes, giveUpAfterHours } = step.watch;
      const every = `every ${String(everyMinutes)} ${everyMinutes === 1 ? "minute" : "minutes"}`;
      lines.push(
        watchNeverGivesUp(step.watch)
          ? `  keeps checking: ${every}, never giving up — \`watch: { "everyMinutes": ${String(everyMinutes)}, "neverGivesUp": true }\``
          : `  keeps checking: ${every}, giving up after ${watchDurationWords(giveUpAfterHours * 3_600_000)} ` +
              `— \`watch: { "everyMinutes": ${String(everyMinutes)}, "giveUpAfterHours": ${String(giveUpAfterHours)} }\``,
      );
    }
  }

  lines.push("", "## Routes", "", "A step's result key decides where its ticket goes next.", "");
  for (const route of data.routes) {
    lines.push(`- from ${route.fromStepId} on \`${route.resultKey}\` → ${route.target}${route.label ? ` (${route.label})` : ""}`);
  }
  // As pipeline_save takes them, so what is shown can be sent back
  // (EO-610). Said only where there are any.
  if (data.entryRules.length > 0) {
    lines.push("", "## Entry rules", "", data.entrySentence ?? "", "", `\`entryRules\`: ${JSON.stringify(data.entryRules)}`);
  }
  // Said only where a webhook job files here, which is the only place
  // it means anything (EO-405). The assistant may explain the setting
  // and offer the card whose button changes it (EO-522); it is told in
  // the same breath that it cannot change it, so it does not go looking
  // for a tool that does.
  if (data.webhook.entry) {
    lines.push(
      "",
      "## Webhook",
      "",
      data.webhook.unattended
        ? "A webhook job files onto this pipeline, and a person has let what it delivers reach a step that sends without anybody reading it first. " +
            "Publishing reports that as a warning. Only a person can turn it off again, by pressing the button on the assistant's card for it " +
            `(\`card\` with the kind \`${WEBHOOK_UNATTENDED_CARD_KIND}\`); no tool can.`
        : "A webhook job files onto this pipeline. Publishing is refused while a step that acts outside EO can be reached before a human step. " +
            `A person can accept that for this pipeline by pressing the button on the assistant's card for it ("${WEBHOOK_UNATTENDED_LABEL}", ` +
            `\`card\` with the kind \`${WEBHOOK_UNATTENDED_CARD_KIND}\`); no tool can.`,
    );
  }
  return lines.join("\n");
}

export function renderModules(data: IpcResponse<"modules:list">): string {
  return list(
    data.modules.map((module) => {
      const approved = module.approvedAt === null ? "**not approved** — a pipeline naming it will not publish" : "approved";
      return `- ${module.name} (slug: ${module.slug}, id: ${module.id}) — ${approved}\n  ${module.description}\n  Tests: ${moduleTestsLine(module.testRun, module.testsStale)}`;
    }),
    "No custom modules.",
  );
}

/** A module's latest test run in one line (EO-352): how many passed, the coverage, and whether it is stale. */
function moduleTestsLine(run: ModuleTestRun | null, stale: boolean): string {
  if (run === null) return "never run.";
  const passed = run.cases.filter((each) => each.passed).length;
  const figures = `${passed} of ${run.cases.length} passed; line coverage ${run.coverage.lines.percent}%, branch coverage ${run.coverage.branches.percent}%`;
  return stale ? `${figures} — stale: the code or the cases changed since, and a re-run is due.` : `${figures}.`;
}

/**
 * What a write to a module's test cases says about its approval, when it
 * withdrew one (EO-498) — or nothing.
 */
export function approvalWithdrawnNote(withdrawn: boolean): string {
  return withdrawn
    ? " This withdrew the module's approval: its test cases are no longer the ones that were approved, so steps that run it stop " +
        "and no pipeline naming it will publish until a person approves it again with module_approve, which runs every case."
    : "";
}

/**
 * Values in what was just saved or approved that only hold on one
 * machine (EO-449), as a paragraph to append to the answer — or nothing.
 * `subject` is what would travel: the module, the pipeline, an agent's
 * instructions, a skill (EO-450).
 *
 * Said as advice, because it is: the save or the approval it follows has
 * already happened, and nothing was refused because of it.
 */
export function renderMachineSpecific(warnings: readonly MachineSpecificWarning[], subject = "the module"): string {
  if (warnings.length === 0) return "";
  return (
    `\n\nThese look like they only hold on this machine, and would break where ${subject} is exported or shared. ` +
    "This is advice — nothing was refused because of it:\n" +
    warnings.map((warning) => `- ${describeMachineSpecificWarning(warning)}`).join("\n")
  );
}

/** A module's cases, each with its source, so a caller can edit one rather than add another. */
export function renderModuleTests(data: IpcResponse<"moduleTests:list">): string {
  if (data.problem !== null) return data.problem;
  return list(
    data.tests.map((test) => `- ${test.description} (id: ${test.id})\n\n\`\`\`js\n${test.source}\n\`\`\``),
    "This module has no test cases.",
  );
}

/** A module's kept versions, newest first (EO-360). */
export function renderModuleVersions(data: IpcResponse<"moduleVersions:list">): string {
  if (data.problem !== null) return data.problem;
  return list(
    data.versions.map(
      (version) =>
        `- ${versionLabel(version.number)}, saved ${new Date(version.createdAt).toISOString()} — ${version.approved ? "approved" : "not approved"}, ` +
        `${version.testCount} test case(s)${version.current ? " (current)" : ""}`,
    ),
    "This module has no versions.",
  );
}

/** One version whole (EO-360): what restoring it would put back. */
export function renderModuleVersion(data: IpcResponse<"moduleVersions:get">): string {
  if (data.version === null) return data.problem ?? "No such version.";
  const version = data.version;
  const tests = version.tests.map((test) => `- ${test.description} (id: ${test.id})\n\n\`\`\`js\n${test.source}\n\`\`\``);
  return [
    `${versionLabel(version.number)} of "${version.name}"${version.current ? " (current)" : ""} — ${version.approved ? "approved" : "not approved"}.`,
    version.description,
    "",
    "Manifest:",
    JSON.stringify(version.manifest),
    "",
    "Code:",
    "```js",
    version.code,
    "```",
    "",
    `Test cases (${version.tests.length}):`,
    ...(tests.length === 0 ? ["none"] : tests),
  ].join("\n");
}

/** How much of a failed case's output a rendering quotes. The tail is where it explains itself. */
const MAX_RENDERED_CASE_OUTPUT = 2000;

/** One test run: a line per case, a failure's message and output beneath it, then the coverage. */
export function renderModuleTestRun(run: ModuleTestRun): string {
  if (run.cases.length === 0) return "This module has no test cases, so nothing ran. Line and branch coverage are 0%.";
  const lines = run.cases.map((each) => {
    if (each.passed) return `- passed: ${each.description}`;
    const output = each.output.trim() === "" ? "" : `\n  Output:\n${indent(each.output.slice(-MAX_RENDERED_CASE_OUTPUT))}`;
    return `- **failed**: ${each.description}\n${indent(each.failure ?? "")}${output}`;
  });
  const passed = run.cases.filter((each) => each.passed).length;
  lines.push(
    "",
    `${passed} of ${run.cases.length} passed. Line coverage ${run.coverage.lines.percent}% (${run.coverage.lines.covered} of ${run.coverage.lines.total} lines), ` +
      `branch coverage ${run.coverage.branches.percent}% (${run.coverage.branches.covered} of ${run.coverage.branches.total} branches).`,
  );
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/**
 * One catalogued server, in the terms someone deciding about it needs.
 *
 * Shared by the listing and by the writes below (EO-113), for
 * `repositoryLine`'s reason: what a caller reads back to check its own
 * save landed is the same line the listing would have given it, so a
 * field one of them prints and the other quietly omits cannot exist.
 * Names, never values — the note on `renderMcpServers` is the whole of
 * why, and it applies to every caller of this.
 */
/**
 * What fills a declared name besides the server's own secret, as the
 * listing knows it (EO-328, EO-488): the organisation's names and the
 * shared environment variables'. A write's reply is about one row and
 * has neither, so it says what it always said.
 */
interface DeclaredNameSources {
  organisation: readonly string[];
  variables: readonly string[];
}

/**
 * Where a declared name's value comes from, in the order a spawn asks:
 * the organisation's, the server's own secret, then an environment
 * variable — the words the server screens use.
 */
function declaredNameState(server: McpServerView, name: string, sources: DeclaredNameSources | undefined): string {
  if (sources?.organisation.includes(name) === true) return "set by your organisation";
  if (server.secretsSet.includes(name)) return "set";
  if (server.secretsUnreadable?.includes(name) === true) return UNREADABLE_SERVER_SECRET_LINE.toLowerCase();
  if (sources?.variables.includes(name) === true) return FROM_ENVIRONMENT_VARIABLES.toLowerCase();
  return "not set";
}

function mcpServerLine(server: McpServerView, sources?: DeclaredNameSources): string {
  const marks: string[] =
    server.config.transport === "stdio"
      ? [`stdio: \`${[server.config.command, ...server.config.args].join(" ")}\``]
      : [`${server.config.transport}: ${server.config.url}`];

  if (server.config.transport !== "stdio") {
    const headers = Object.keys(server.config.headers);
    if (headers.length > 0) marks.push(`headers: ${headers.join(", ")}`);
  }
  if (server.envNames.length > 0) {
    marks.push(`needs ${server.envNames.map((name) => `${name} (${declaredNameState(server, name, sources)})`).join(", ")}`);
  }
  if (!server.enabled) marks.push("disabled — no agent is given it");
  if (server.archivedAt !== null) marks.push("archived");

  return `${server.name} (id: ${server.id}) — ${marks.join("; ")}`;
}

/**
 * The MCP servers a person catalogued, as a client reads them (EO-112).
 *
 * Names, never values, in both directions. `McpServerViewSchema` carries
 * `secretsSet` — which of a server's declared environment variables has
 * something behind it in the OS keychain — and no value crosses that
 * boundary in either direction, so the most this can say about a secret
 * is that it is set. That is also the useful thing to say: a variable
 * with nothing behind it is a server that will be dispatched and fail,
 * and the name is what a person needs in order to fix it.
 *
 * A remote server's headers are printed by name for a smaller reason. By
 * convention a header that needs a secret is written `Authorization:
 * Bearer ${VAR}` with the value arriving from the keychain at spawn, and
 * EO cannot tell a person who followed that from one who pasted a token
 * in — `McpServerDraftSchema.headers` says as much. So nothing is gained
 * by printing what is in them, and a transcript is a bad place to find
 * out somebody got it wrong. The row itself still travels beside this as
 * `structuredContent`, unchanged: this is what the text says, not a
 * redaction the contract makes.
 */
export function renderMcpServers(data: IpcResponse<"mcpServers:list">): string {
  const sources = { organisation: data.organisationSecrets, variables: data.environmentVariables };
  const lines = data.servers.map((server) => `- ${mcpServerLine(server, sources)}`);

  // The keychain's warning belongs with the list rather than on its own,
  // because it is the answer to the question the list raises: "not set"
  // beside every variable reads as nobody having typed one, when the
  // truth can be that this machine has nowhere safe to put it.
  const keychain = data.keychain.warning === null ? [] : ["", data.keychain.warning];
  return [list(lines, "No MCP servers are catalogued."), ...keychain].join("\n");
}

/**
 * A server saved, or the sentences saying why it was not (EO-113).
 *
 * The refusal is the interesting half. `mcpServers:save` answers
 * `{ saved: false, problem }` on a successful call — a name another server has, a
 * stdio entry with no command, the name `eo` — because those are things
 * a person typed rather than programmer error, and the catalogue's own
 * `problem` is already a sentence a person could act on. Printed as
 * written, so a client reads a refusal it can fix rather than a
 * validation dump it will retry unchanged.
 *
 * What is saved reaches no agent on its own, and the second line says
 * so: a catalogue row is inert until something is attached to an agent,
 * and a model that does not know that has "added" a server that will
 * never appear anywhere and will go looking for why.
 */
export function renderMcpServerSaved(data: IpcResponse<"mcpServers:save">): string {
  if (!data.saved || data.server === null) return `Nothing was saved: ${data.problem ?? "it refused."}`;
  return `Saved ${mcpServerLine(data.server)}\nIt is catalogued and nothing more — no agent is dispatched with it until it is attached to one.`;
}

/**
 * A server switched on or off (EO-113).
 *
 * The whole row rather than the word, because the switch is one of
 * several things that decide whether an agent sees the server and the
 * others are on the same line — archived, and whether the values it
 * declared are actually stored. A caller told only "switched on" about a
 * server still missing its token has been told the least useful true
 * thing.
 */
export function renderMcpServerSwitched(data: IpcResponse<"mcpServers:setEnabled">): string {
  if (data.server === null) return `Nothing changed: ${data.problem ?? "it refused."}`;
  const switched = data.server.enabled ? "Switched on" : "Switched off";
  return `${switched}: ${mcpServerLine(data.server)}\nIt takes effect on the next dispatch, not on a run already in flight.`;
}

/**
 * One catalogued skill, description and not body.
 *
 * Shared by the listing and by the writes below (EO-113), the way
 * `mcpServerLine` is. The description is the sentence the model decides
 * on and the body is a page: a catalogue of a dozen bodies is a
 * transcript nobody can read, and a save that echoed back the body a
 * caller just sent it would be the same page twice. Both travel in
 * `structuredContent` regardless.
 */
function skillLine(skill: Skill): string {
  const marks: string[] = [];
  if (!skill.enabled) marks.push("disabled — not delivered at all");
  if (skill.disableModelInvocation) marks.push("delivered, but not offered for the model to choose");
  if (skill.archivedAt !== null) marks.push("archived");
  if (skill.files.length > 0) marks.push(`${skill.files.length} supporting file(s)`);
  const suffix = marks.length === 0 ? "" : ` — ${marks.join("; ")}`;
  return `${skill.name} (slug: ${skill.slug}, id: ${skill.id})${suffix}\n  ${skill.description}`;
}

/**
 * The skills a person wrote, as a client reads them (EO-112).
 *
 * The description rather than the body. A description is what the model
 * reading it decides on and is a sentence; a body is a page, and a
 * catalogue of a dozen of them is a transcript nobody can read. What is
 * left out of the text is in `structuredContent` for a caller that
 * wants it.
 *
 * Both switches are printed because they mean different things and a
 * person debugging "why did the agent not use this" needs to know which
 * one is off: disabled is not delivered at all, and
 * `disableModelInvocation` is delivered but not offered for the model to
 * choose.
 */
export function renderSkills(data: IpcResponse<"skills:list">): string {
  return list(
    data.skills.map((skill) => `- ${skillLine(skill)}`),
    "No skills are catalogued.",
  );
}

/**
 * A skill saved, or the sentences saying why it was not (EO-113).
 *
 * `renderMcpServerSaved`'s note applies in both halves: a slug that is
 * not one, a supporting file that climbs out of the skill's own folder
 * and a slug another skill already has all come back as `problem` on a
 * successful call, already written as sentences.
 *
 * The saved line names the slug for a reason the server half does not
 * have: a create may leave `slug` out and EO decides one from the name,
 * so the slug a model is about to put in a prompt is a thing it learns
 * here or guesses at.
 */
export function renderSkillSaved(data: IpcResponse<"skills:save">): string {
  if (!data.saved || data.skill === null) return `Nothing was saved: ${data.problem ?? "it refused."}`;
  return (
    `Saved ${skillLine(data.skill)}\nIt is catalogued and nothing more — no agent is dispatched with it until it is attached to one.` +
    // What its body holds that only exists here (EO-450): advice on a save that has happened.
    renderMachineSpecific(skillMachineSpecificWarnings(data.skill.body), "the skill")
  );
}

/**
 * A skill switched on or off (EO-113).
 *
 * The whole row again, and here because the two switches are easy to
 * confuse: this one decides whether the skill is delivered at all, and
 * `disableModelInvocation` — which travels on the save — decides whether
 * the model is offered it to choose. The line prints both, so a caller
 * that turned the wrong one can see it did.
 */
export function renderSkillSwitched(data: IpcResponse<"skills:setEnabled">): string {
  if (data.skill === null) return `Nothing changed: ${data.problem ?? "it refused."}`;
  const switched = data.skill.enabled ? "Switched on" : "Switched off";
  return `${switched}: ${skillLine(data.skill)}\nIt takes effect on the next dispatch, not on a run already in flight.`;
}

/**
 * What each agent is dispatched with, out of those two catalogues
 * (EO-112).
 *
 * Ids, because ids are what the channel carries — `AgentAttachments` is
 * the join and deliberately not a second copy of the rows, so that a
 * name changed in the catalogue cannot be stale here. The line under the
 * list is what makes them usable: three ids and no way to learn whose
 * they are is an answer a reader has to guess at.
 */
export function renderAgentAttachments(data: IpcResponse<"agentAttachments:list">): string {
  const lines = data.attachments.map((attachment) => {
    const parts: string[] = [];
    if (attachment.mcpServerIds.length > 0) parts.push(`MCP servers: ${attachment.mcpServerIds.join(", ")}`);
    if (attachment.skillIds.length > 0) parts.push(`skills: ${attachment.skillIds.join(", ")}`);
    return `- agent ${attachment.agentId} — ${parts.length === 0 ? "nothing attached" : parts.join("; ")}`;
  });

  if (lines.length === 0) return "No agent has anything attached.";
  return [...lines, "", "agents_list says which agent each id is; mcp_servers_list and skills_list say what is attached."].join("\n");
}

/**
 * One tick, answered with what the agent will actually be dispatched
 * with (EO-114).
 *
 * The reply carries the agent's entire attachment set and not the row
 * that changed, so this says what the agent now has rather than that the
 * call worked. That is the answer the caller is about to need: a client
 * that has just attached a server is going to tell somebody what they
 * now have, and "attached" on its own would send it back to
 * `agent_attachments_list` for a thing it was already holding.
 *
 * **Attached is not the same as delivered, and this has to say so.**
 * `setAgentAttachment` accepts a disabled or an archived row on purpose
 * — attaching something switched off is a thing a person may be part way
 * through doing, and archiving must not break the attachments already
 * pointing at a row. But `deliverableAttachments` filters both back out
 * when the plugin directory is written, so an agent is dispatched with
 * some subset of what is attached to it. Reporting the raw set as "now
 * dispatched with" would tell a client the next dispatch includes a
 * server it will never receive, which is worse than saying less: the
 * client repeats it to a person, and the first sign it was wrong is an
 * agent that cannot do the thing it was supposedly given.
 *
 * So both are printed, apart and with the reason. The rules are imported
 * rather than restated, so this cannot drift from what is actually
 * written to disk — `isDeliverable` for the two switches a person
 * controls, and `reservedMcpServerName` for the one they do not: a row
 * wearing a name EO keeps for itself is withheld from every dispatch
 * (EO-151), and a client told otherwise would repeat it to a person.
 *
 * The catalogue rows arrive from the two listings the host reads back
 * after the tick — the join itself is ids, deliberately, and a second
 * copy of a row inside it would be the stale one. When a listing could
 * not be read the ids are still printed and the delivery claim is
 * dropped rather than guessed: the tick has already happened either way,
 * and a caller is better told what changed than handed a confident
 * answer nobody checked.
 */
export function renderAgentAttachmentSet(
  data: IpcResponse<"agentAttachments:set">,
  servers: McpServerView[] | null,
  skills: Skill[] | null,
): string {
  if (data.attachments === null) return `Nothing changed: ${data.problem ?? "it refused."}`;

  const { agentId, mcpServerIds, skillIds } = data.attachments;
  const entries = [
    ...classifyAttached(mcpServerIds, servers, "MCP server", (row) =>
      reservedMcpServerName(row.name) === null ? null : "using a name EO keeps for a server of its own",
    ),
    ...classifyAttached(skillIds, skills, "skill"),
  ];

  if (entries.length === 0) {
    return [`Agent ${agentId} will be dispatched with nothing out of either catalogue.`, "", ATTACHMENT_TIMING, ATTACHMENT_IDS].join("\n");
  }

  const delivered = entries.filter((entry) => entry.state === "delivered");
  const withheld = entries.filter((entry) => entry.state === "withheld");
  const unknown = entries.filter((entry) => entry.state === "unknown");

  // A heading rather than a count: "1 of 2 attached" makes a reader work
  // out which one, and the lists below already say.
  //
  // The empty case forks on whether EO actually knows. "Dispatched with
  // nothing" is a claim, and a listing that could not be read is no
  // ground to make it from — that is the difference between an agent
  // with a disabled server and an agent EO could not check.
  const lines: string[] =
    delivered.length > 0
      ? [`Agent ${agentId} will be dispatched with:`, ...delivered.map((entry) => `- ${entry.label}`)]
      : unknown.length > 0
        ? [`Agent ${agentId} is attached to the ${unknown.length === 1 ? "entry" : "entries"} below.`]
        : [`Agent ${agentId} will be dispatched with nothing out of either catalogue.`];

  if (withheld.length > 0) {
    lines.push(
      "",
      "Attached, and not delivered:",
      ...withheld.map((entry) => `- ${entry.label} — ${entry.reason}`),
      "",
      "A disabled or archived entry stays attached and can be switched back on — mcp_server_set_enabled and skill_set_enabled are what make the next dispatch include one.",
    );
  }

  if (unknown.length > 0) {
    lines.push(
      "",
      "Attached, and EO could not read the catalogue back to say whether these are delivered:",
      ...unknown.map((entry) => `- ${entry.label}`),
    );
  }

  return [...lines, "", ATTACHMENT_TIMING, ATTACHMENT_IDS].join("\n");
}

const ATTACHMENT_TIMING =
  "Nothing else is added to the agent's surface: it has what is delivered here, its own instructions, and the `eo` server every agent already has. A tick takes effect on the next dispatch, not on a run already in flight.";

const ATTACHMENT_IDS = "agents_list says which agent each id is; mcp_servers_list and skills_list say what is attached.";

interface ClassifiedAttachment {
  state: "delivered" | "withheld" | "unknown";
  label: string;
  reason: string;
}

/**
 * One attached id, against the catalogue row it points at.
 *
 * Three answers rather than two, because "EO could not look" is not the
 * same as "it will not be delivered" and a reader acts differently on
 * each. A row the listing does not carry at all is counted as withheld:
 * `resolveAgentAttachments` drops an id nothing answers to, so a
 * dispatch would not deliver it either, and that is the honest thing to
 * report about it.
 */
function classifyAttached<T extends { id: string; name: string; enabled: boolean; archivedAt: number | null }>(
  ids: readonly string[],
  rows: readonly T[] | null,
  kind: string,
  /**
   * One more reason this *kind* can be withheld, or null when there is
   * none (EO-151).
   *
   * A server is held to a rule a skill is not: it may not wear a name EO
   * has reserved for its own. Passed in rather than branched on `kind`,
   * so the caller that knows which catalogue it is reading is the one
   * that says so.
   */
  alsoWithheld?: (row: T) => string | null,
): ClassifiedAttachment[] {
  return ids.map((id) => {
    if (rows === null) return { state: "unknown" as const, label: `${kind} ${id}`, reason: "" };

    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      return { state: "withheld" as const, label: `${kind} ${id}`, reason: "no longer in the catalogue" };
    }

    const label = `${kind} ${row.name} (id: ${row.id})`;
    // The *decision* stays the imported predicates', never this file's
    // reading of the same fields: `isDeliverable` for the two switches a
    // person controls, plus whatever extra rule this kind carries. The
    // list below is the explanation, and an explanation that drifted
    // would be a wrong sentence beside a right verdict rather than a
    // wrong verdict.
    const withheldFor = alsoWithheld?.(row) ?? null;
    if (isDeliverable(row) && withheldFor === null) return { state: "delivered" as const, label, reason: "" };

    // Every reason, not the first: a person who archived a server they
    // had already switched off has to switch it on *and* write it
    // afresh, and being told only one of those sends them back for the
    // other.
    const reasons = [
      !row.enabled ? "disabled" : null,
      row.archivedAt !== null ? "archived" : null,
      withheldFor,
    ].filter((reason) => reason !== null);
    return { state: "withheld" as const, label, reason: reasons.join(" and ") };
  });
}

export function renderSettings(data: IpcResponse<"settings:get">): string {
  // Every one of these is a value a caller has to know before it can
  // write one of the others: `settings_write` takes a partial, and a
  // model that cannot see what it is not changing has no way to tell a
  // deliberate omission from a forgotten field.
  const archive =
    data.archiveAfterDays === null
      ? "never — finished tickets stay on the project"
      : data.archiveAfterDays === 0
        ? "as soon as a ticket is finished"
        : `${data.archiveAfterDays} day(s) after a ticket is finished`;
  return [
    `- do not disturb: ${data.doNotDisturb ? "on — no notifications" : "off"}`,
    `- archive finished work: ${archive}`,
    `- Jira pull: ${data.jiraPullMinutes === null ? "off" : `every ${data.jiraPullMinutes} minute(s)`}`,
    `- branch prefix: ${data.branchPrefix} (branches are named ${data.branchPrefix}/<KEY>)`,
    `- pipeline versions to keep: ${data.pipelineVersionsToKeep} per pipeline (older ones are deleted at that pipeline's next save, except the current one and any a ticket is bound to)`,
    `- module versions to keep: ${data.moduleVersionsToKeep} per module (older ones are deleted at that module's next save, never the current one)`,
  ].join("\n");
}

export function renderGuards(data: IpcResponse<"guards:get">): string {
  return [
    `- concurrency: ${data.globalConcurrency} global, ${data.perRepositoryConcurrency} per repository, ${data.perAgentConcurrency} per agent`,
    `- attempts per ticket: ${data.perItemAttemptLimit}`,
    `- run timeout: ${Math.round(data.wallClockTimeoutMs / 60000)} minutes`,
    data.inactivityTimeoutMs > 0
      ? `- silence before a run is ended: ${Math.round(data.inactivityTimeoutMs / 60000)} minutes with no word from its backend and no tool running`
      : `- silence before a run is ended: off`,
    `- per-ticket budget: ${data.perItemBudgetCents === null ? "none" : money(data.perItemBudgetCents)}`,
    `- daily budget: ${data.dailyBudgetCents === null ? "none" : money(data.dailyBudgetCents)}`,
    `- free-text replies to a parked builtin or module step: ${data.interpretReplies ? "read by the system agent" : "handed straight back to the step"}`,
    `- agent-to-agent mentions on one ticket: ${data.agentMentionDepth} before a person has to comment`,
    `- watch round trips per ticket: ${data.watchRoundTripsPerItem} sends by steps that keep checking before a person has to comment`,
    `- memory given whole: up to ${data.memoryDeliveryChars} characters, past which a small model picks what bears on the task`,
    `- memory per scope: ${data.memoryScopeMaxEntries} entries or ${data.memoryScopeMaxChars} characters, whichever is reached first, before it is consolidated to about half`,
    `- trial items while their draft's conversation is open: ${data.trialsFirst ? "dispatched ahead of live work (the order only; concurrency is unchanged)" : "dispatched by priority and age like everything else"}`,
    `- rounds of a draft's test items before testing stops and asks the person: ${data.trialRoundsPerDraft}`,
    `- budget for testing one draft: ${data.trialBudgetCentsPerDraft === null ? "none (the daily budget still applies)" : `${data.trialBudgetCentsPerDraft}¢`}`,
    `- the same step failing with the same result in two rounds in a row: ${data.trialStopOnRepeatedFailure ? "stops testing and asks the person" : "does not stop testing"}`,
    "- the system agent: of the limits on a run, only the attempt limit applies to it. No concurrency cap, run timeout, silence limit, budget or mention limit holds it back, and what it spends still counts towards the budgets",
  ].join("\n");
}

/**
 * Both halves of what a budget guard is measured against.
 *
 * The day is always here — it is the figure the daily budget stops work
 * on, and a caller that asked about an item still wants to know how
 * close everything else is to the same wall. The item half is null
 * when nobody named one, rather than zero: "nothing spent" and "not
 * asked about" are different answers and a number cannot say which.
 */
export interface SpendReport {
  date: string;
  dailyCostCents: number;
  /** The part of the day's figure that was not runs: side calls, by spend line (EO-477). */
  dailySideCalls: SideCallSpendLine[];
  /**
   * The part of the day's figure spent on trial items (EO-582): included
   * in `dailyCostCents`, since a trial's runs count against the budgets,
   * and said apart. Zero on a day nothing was tested.
   */
  dailyTrialCostCents: number;
  item: { itemId: string; costCents: number; sideCalls: SideCallSpendLine[] } | null;
}

/** "of which Memory upkeep: $0.04", or nothing when every cent was a run's. */
function sideCallShare(lines: readonly SideCallSpendLine[]): string {
  if (lines.length === 0) return "";
  return ` (of which ${lines.map((line) => `${line.label}: ${money(line.costCents)}`).join(", ")})`;
}

/**
 * What EO has spent, in the terms the guardrails are written in.
 *
 * Printed beside the limit rather than alone: a figure with nothing to
 * compare it against tells a reader nothing about whether the next
 * dispatch will be stopped, which is the only question anybody reads
 * this to answer. guardrails_get holds the limits, and is named here so
 * the second call is obvious.
 */
export function renderSpend(report: SpendReport): string {
  const lines = [`- ${report.date}, across every ticket: ${money(report.dailyCostCents)}${sideCallShare(report.dailySideCalls)}`];
  // Said apart, never taken out (EO-582): a trial runs for real and the
  // daily budget counts it.
  if (report.dailyTrialCostCents > 0) {
    lines.push(`- of that, testing pipeline drafts with real runs (trial tickets): ${money(report.dailyTrialCostCents)}`);
  }
  if (report.item !== null) {
    // Zero is the one figure here that is ambiguous: EO sums the runs it
    // has, and an id it has never seen has none of them, so a typo and a
    // item nothing has run on report the same thing. Said out loud
    // rather than left to be read as a fact about the item.
    const nothing = report.item.costCents === 0 ? " — nothing has run on it yet, or that is not a ticket EO has; ticket_get says which" : "";
    lines.push(`- ticket ${report.item.itemId}, every run against it: ${money(report.item.costCents)}${sideCallShare(report.item.sideCalls)}${nothing}`);
  }
  lines.push(
    "",
    "These are the figures the daily and per-ticket budget guardrails are measured against: a run, other than the system agent's, stops the moment " +
      "either one reaches its budget. guardrails_get says what those budgets are, and guardrails_set changes them.",
  );
  return lines.join("\n");
}

export function renderWorktrees(data: IpcResponse<"worktrees:list">): string {
  return list(
    data.worktrees.map((worktree) => {
      // Named rather than counted, because it is the fact that decides
      // whether releasing this tree destroys the only copy of something.
      const dirty = worktree.uncommittedChanges > 0 ? `, **${worktree.uncommittedChanges} uncommitted change(s)**` : "";
      const inUse = worktree.inUse ? ", in use by a run" : "";
      const { itemKey, repositoryName, branch } = worktree;
      return `- ${itemKey} (${repositoryName}): ${branch}${dirty}${inUse}`;
    }),
    "EO is holding no worktrees.",
  );
}

/**
 * One backend's runtime, as `runtime_status` collected it.
 *
 * Carries the provider that was asked about alongside the answer,
 * because the answer can be null — a backend that runs inside EO has no
 * CLI — and "nothing here" is only readable if you know what was asked.
 */
export interface RuntimeEntry {
  provider: string;
  runtime: IpcResponse<"runtime:status">["runtime"];
}

/**
 * What this machine has, and whether EO may use it.
 *
 * Installed and enabled are separate facts and both are printed, every
 * time. A caller that reads only "installed" and dispatches against a
 * disabled runtime gets a step that parks with no explanation, which is
 * exactly the state `runtime_status` exists to make visible.
 */
export function renderRuntimes(entries: readonly RuntimeEntry[]): string {
  return list(
    entries.map(({ provider, runtime }) => {
      if (runtime === null) {
        // Two things at once, because EO cannot tell them apart and
        // saying only the first would answer a typo with a fact.
        return (
          `- \`${provider}\` — no managed runtime: it either runs inside EO's own process and shells out to nothing, or it ` +
          "is not a backend EO knows how to fetch. Either way there is nothing to install and nothing to enable."
        );
      }

      const managed =
        runtime.source === "cache"
          ? `installed${runtime.version === null ? "" : ` (version ${runtime.version})`}`
          : runtime.source === "configured"
            ? `not used — an executable path set by hand points at ${runtime.path ?? "somewhere else"}`
            : "not installed";
      const lines = [
        `- ${runtime.label} (provider \`${runtime.id}\`, published by ${runtime.publisher})`,
        `  - EO's managed copy: ${managed}`,
        `  - enabled: ${runtime.enabled === false ? "no — EO will not select its managed copy, and any step owned by an agent on this backend parks" : "yes"}`,
        `  - automatic updates: ${runtime.automaticUpdates === true ? "on" : "off"}`,
      ];
      lines.push(
        // Installed and signed in are different facts (EO-82), and a
        // caller told only the first would go on dispatching against a
        // runtime that can run nothing.
        runtime.auth.state === "signed_in"
          ? `  - signed in: yes${runtime.auth.account === null && runtime.auth.method === null ? "" : ` (${[runtime.auth.account, runtime.auth.method].filter((part) => part !== null).join(", ")})`}`
          : runtime.auth.state === "signed_out"
            ? "  - signed in: no — it is installed but nothing can run on it until someone signs in from Agents → Runtimes"
            : `  - signed in: EO could not tell${runtime.auth.problem === null ? "" : ` (${runtime.auth.problem})`}`,
      );
      if (runtime.state !== undefined) lines.push(`  - state: ${runtime.state}`);
      if (runtime.problem !== null && runtime.problem !== undefined) lines.push(`  - problem: ${runtime.problem}`);

      const missing = (runtime.components ?? []).filter((component) => !component.installed);
      if (missing.length > 0) lines.push(`  - still to fetch: ${missing.map((component) => `${component.label} ${component.version}`).join(", ")}`);

      const users = runtime.usedBy ?? [];
      if (users.length > 0) {
        lines.push(`  - agents on it: ${users.map((agent) => `${agent.name}${agent.enabled ? "" : " (disabled)"}`).join(", ")}`);
      }
      lines.push(
        runtime.packageName === null
          ? "  - nobody publishes a build of this for the machine EO is on"
          : `  - what an install would fetch: ${runtime.packageName}@${runtime.packageVersion ?? "unknown"} — runtime_describe says how big that is`,
      );
      return lines.join("\n");
    }),
    "EO knows of no agent runtimes.",
  );
}

/**
 * What a download would cost, before any of it happens.
 *
 * The size is the registry's own `unpackedSize` and is named for what it
 * is, for the reason `runtime:describe` gives: a "Size" under a Download
 * button reads as the transfer, the transfer is gzipped and smaller, and
 * overstating it is the wrong way to be wrong.
 */
export function renderRuntimeDescription(
  runtime: NonNullable<IpcResponse<"runtime:status">["runtime"]>,
  data: IpcResponse<"runtime:describe">,
): string {
  const lines = [
    `${runtime.label}, published by ${runtime.publisher}.`,
    `- terms: ${runtime.termsUrl}`,
    `- package: ${data.packageName === null ? "none published for the machine EO is on" : `${data.packageName}@${data.packageVersion ?? "unknown"}`}`,
  ];
  if (data.sourceUrl !== null) lines.push(`- tarball: ${data.sourceUrl}`);
  lines.push(
    data.unpackedBytes === 0
      ? "- size on disk: not known"
      : `- size on disk: ${(data.unpackedBytes / 1_000_000).toFixed(1)} MB unpacked (the transfer itself is gzipped and smaller)`,
  );
  if (data.problem !== null) lines.push(`- ${data.problem}`);
  lines.push(
    "",
    "Nothing has been downloaded by this call. runtime_install is what fetches it, and it sits behind the " +
      "destructive-operations switch — so the download is a decision someone makes with these numbers in front of them.",
  );
  return lines.join("\n");
}

// ── Writes ──────────────────────────────────────────────────────────
//
// A write renders what happened, in the terms the caller asked in. It is
// not enough to say "done": `items:move` succeeding and `items:move`
// declining are both successful calls, and only the text tells them
// apart for a reader.

export function renderCommentPosted(data: IpcResponse<"comments:post">): string {
  if (data.commentId === null) return data.problem ?? "Nothing was posted.";
  return data.resumedRun
    ? `Comment posted (${data.commentId}). Someone was waiting on this, so their run has resumed.`
    : `Comment posted (${data.commentId}).`;
}

export function renderCommentPinned(data: IpcResponse<"comments:setPinned">): string {
  // The one answer that must not be a guess. Nothing was written, so
  // saying which way it was not written would be describing a comment
  // that is not there — the only useful thing to say is where a real id
  // comes from.
  if (!data.found) {
    return (
      "Nothing was pinned or unpinned: EO has no comment with that id. Read the ids off ticket_get, which lists the " +
      "thread and marks what is already pinned, rather than constructing one. Nothing has changed."
    );
  }
  return data.pinned
    ? "Comment pinned. It now survives context truncation, so every agent that works this ticket reads it however long the thread gets — and on a feature it is carried into every story underneath."
    : "Comment unpinned. It is still in the thread, but it is now ordinary chatter and can be dropped from an agent's context once the thread is too long to fit.";
}

export function renderItemUpdated(data: IpcResponse<"items:update">): string {
  if (data.updated) return data.dependencies === undefined ? "Ticket updated." : `Ticket updated. ${dependencyChangeSentences(data.dependencies)}`;
  // Two ways to change nothing, and they are not the same answer. A
  // refused edit says why (EO-125); a request that named no field to
  // change has nothing to explain, and telling that caller a key was
  // taken would be inventing a failure it never hit.
  return data.problem === null ? "Nothing was updated — the request named no field to change." : `Nothing was updated: ${data.problem}`;
}

/**
 * What a change to what an item waits for did (EO-600): what was added
 * and taken off, and — the part a caller acts on — whether that left it
 * free to be picked up, or what it still waits for.
 */
function dependencyChangeSentences(change: NonNullable<IpcResponse<"items:update">["dependencies"]>): string {
  const sentences: string[] = [];
  if (change.added.length > 0) sentences.push(`It now waits for ${change.added.join(", ")}.`);
  if (change.removed.length > 0) sentences.push(`It no longer waits for ${change.removed.join(", ")}.`);
  if (change.freed) sentences.push("Nothing it waits for is still open, so it can be picked up on the next tick.");
  else if (change.stillWaitsFor.length > 0) sentences.push(`It still waits for ${change.stillWaitsFor.join(", ")}, until each reaches a finished step.`);
  sentences.push("A comment on it says what changed.");
  return sentences.join(" ");
}

export function renderMoved(data: IpcResponse<"items:move">): string {
  const cancelled = data.cancelledRunId === null ? "" : ` Run ${data.cancelledRunId} was cancelled to make room.`;
  const comment = data.commentId === null ? "" : " Your note was posted above the move.";
  return `Ticket moved.${cancelled}${comment}`;
}

export function renderMovedToVersion(data: IpcResponse<"items:moveToVersion">): string {
  if (data.queued) {
    return (
      `Sent to the organisation's record: the ticket moves from version ${data.fromVersion ?? "?"} to version ${data.toVersion ?? "?"} ` +
      "when the record applies it, and the binding and its comment reach this desktop on the next sync."
    );
  }
  return (
    `Ticket moved from version ${data.fromVersion ?? "?"} to version ${data.toVersion ?? "?"} of its pipeline. Its step is unchanged; ` +
    `from here it is routed and dispatched by version ${data.toVersion ?? "?"}, and a comment on its thread says so.`
  );
}

export function renderDecided(data: IpcResponse<"items:decide">): string {
  // The step by name, because the caller sent a result key and has no
  // other way to learn where it went — which is the whole difference
  // between this and a move, where the caller named the destination.
  const where = data.toStepName === null ? "on" : `to "${data.toStepName}"`;
  const comment = data.commentId === null ? "" : " Your comment was posted above the move.";
  return `Decision recorded. The ticket moved ${where}.${comment}`;
}

export function renderHeld(data: IpcResponse<"items:hold">): string {
  const cancelled = data.cancelledRunId === null ? "" : ` Run ${data.cancelledRunId} was cancelled.`;
  return `Ticket held where it is. The scheduler will not pick it up until it is resumed.${cancelled}`;
}

export function renderResumed(data: IpcResponse<"items:resume">): string {
  const cancelled = data.cancelledRunId === null ? "" : ` Run ${data.cancelledRunId} was cancelled.`;
  return `Hold cleared. The ticket is dispatchable again from the step it was already on.${cancelled}`;
}

export function renderArchived(data: IpcResponse<"items:setArchived">): string {
  return data.archived
    ? "Ticket archived. Nothing was deleted — it is still readable through tickets_list_archived."
    : "Ticket restored to the project.";
}

export function renderRunCancelled(data: IpcResponse<"runs:cancel">): string {
  return data.cancelled ? "Run cancelled. Whatever it had not finished is gone." : "That run was not running.";
}

export function renderPipelineProblems(data: IpcResponse<"pipeline:validate">): string {
  const verdict =
    data.problems.length === 0
      ? ["The graph is valid. pipeline_save would publish it."]
      : ["This graph would not publish:", "", ...data.problems.map((problem) => `- ${problem.message}`)];
  // What each step of the graph sent reaches outside EO (EO-584), so a
  // draft can be planned for a trial before it exists anywhere.
  const reaching = Object.entries(data.outsideReach).flatMap(([stepId, reach]) => {
    const line = outsideReachLine(reach);
    return line === null ? [] : [`- ${stepId}: ${line}`];
  });
  if (reaching.length === 0) return verdict.join("\n");
  return [...verdict, "", "## Steps that act outside EO", "", ...reaching].join("\n");
}

/**
 * A step's reach outside EO in a line (EO-584), or null for a step with
 * none. The words say what a trial does about it, because that is what the
 * line is read for: such a step runs for real only if the person says so,
 * and is otherwise redirected to a test target or mocked.
 */
function outsideReachLine(reach: "sends" | "creates" | undefined): string | null {
  if (reach === "sends") return "sends outside EO (a builtin or module with side effects, or a connector its agents can reach) — on a trial, redirect or mock it unless the person wants it real";
  if (reach === "creates") return "creates work items (a module declaring needs.create) — a module on a trial item may not create any, so mock it on a trial";
  return null;
}

export function renderPipelineSaved(data: IpcResponse<"pipeline:save">): string {
  if (!data.saved) {
    return ["Nothing was published:", "", ...data.problems.map((problem) => `- ${problem.message}`)].join("\n");
  }
  // The version it filed, because that is what the save *is* since
  // EO-327: what you sent is what new work takes, and anything already
  // standing on this pipeline finishes on the version it entered on.
  const version = data.version === null ? "" : ` It is ${versionLabel(data.version)}.`;
  const published =
    `Pipeline published. Every step and route in the graph you sent is now what EO runs for work entering from now on.${version} ` +
    "Anything already mid-flight finishes on the version it entered on.";
  // Said whenever it happened, meant or not (EO-506): the save was valid,
  // so nothing else will say that a step which waited on something
  // outside EO no longer does.
  if (data.watchTurnedOff.length === 0) return published;
  return [
    published,
    "",
    "Keep checking is now off on these steps — each now runs once:",
    ...data.watchTurnedOff.map((step) => `- ${step.name} (id: ${step.stepId})`),
    "If that was not meant, publish again with each step's `watch` as pipeline_get showed it. Leaving `watch` out keeps a step's setting; `null` turns it off.",
  ].join("\n");
}

/**
 * What suggesting a change did (EO-331, ARCHITECTURE.md, "Divergence and suggestions").
 *
 * Names the item, because the whole point of a suggestion being an item
 * is that there is somewhere to carry on the conversation: an assistant
 * that said "sent" and nothing else would leave the person with no way
 * to find it or quote it to their administrator.
 */
export function renderSuggested(data: IpcResponse<"pipelines:suggest">): string {
  if (!data.suggested) return `Nothing was suggested: ${data.problem ?? "the organisation's server did not take it."}`;
  const key = data.itemKey === null ? "" : ` It is ${data.itemKey}.`;
  return (
    `Suggested. This machine's copy of the pipeline went to your organisation's server as a change for an administrator ` +
    `to approve or send back, and the conversation about it happens in that item's thread.${key} ` +
    `Until somebody approves it, nothing here has changed for anybody else — and this machine's copy is now marked as edited locally.`
  );
}

/**
 * A pipeline's versions and what changed between two of them (EO-327).
 *
 * The diff first, because it is the question: a caller asking what
 * changed is answered by the list of changes, and the history underneath
 * is context for picking a different pair.
 */
export function renderPipelineVersions(data: IpcResponse<"pipeline:versions">): string {
  const history = data.versions.map(
    (version) =>
      `- ${versionLabel(version.number)}${version.createdByName === null ? "" : ` by ${version.createdByName}`}${version.number === data.current ? " (current)" : ""}`,
  );
  // The graph `graph` asked for (EO-359), whole, so a caller restoring a
  // version can hand it to pipeline_save as it stands. Publishing it
  // files a new version; asking for it wrote nothing.
  const graph =
    data.graph === null
      ? []
      : [
          "",
          `The graph of ${versionLabel(data.graph.number)} — pass it to pipeline_save to publish it as a new version:`,
          JSON.stringify({ steps: data.graph.steps, routes: data.graph.routes, entryStepId: data.graph.entryStepId, entryRules: data.graph.entryRules }),
        ];
  if (data.diff === null) {
    return ["This pipeline has one version, so there is nothing to compare it with.", "", ...history, ...graph].join("\n");
  }

  const steps = data.diff.steps.map((step) => {
    if (step.change !== "changed") return `- ${step.name}: ${step.change}`;
    return `- ${step.name}: ${step.fields.map((field) => `${field.field} ${field.before ?? "—"} → ${field.after ?? "—"}`).join(", ")}`;
  });
  const routes = data.diff.routes.map(
    (route) =>
      `- ${route.fromStepName} · ${route.resultKey}: ${route.change} — ` +
      // Field by field, like the steps above: a route can change where it
      // goes, what its button says, how it is drawn and where in the list
      // it is offered, and a line that only ever reported the first of
      // those said "nothing changed" about the other three.
      route.fields.map((field) => `${field.field} ${field.before ?? "—"} → ${field.after ?? "—"}`).join(", "),
  );

  return [
    `${versionLabel(data.diff.from)} → ${versionLabel(data.diff.to)}`,
    "",
    steps.length === 0 ? "No step changed." : "Steps:",
    ...steps,
    "",
    routes.length === 0 ? "No route changed." : "Routes:",
    ...routes,
    ...(data.diff.entryRules === null ? [] : ["", `Entry rules: ${data.diff.entryRules.before} → ${data.diff.entryRules.after}`]),
    "",
    "Every version:",
    ...history,
    ...graph,
  ].join("\n");
}

/** What a "move them all off this step" ended up doing (EO-327). */
export function renderStepItemsMoved(data: IpcResponse<"pipeline:moveStepItems">): string {
  if (data.problem !== null) return `Nothing moved: ${data.problem}`;
  const left = [
    data.archived === 0 ? null : `${data.archived} archived — restore them from the Archive first`,
    data.running === 0 ? null : `${data.running} with an agent working on them — move those one at a time, deciding about the run`,
    data.otherVersion === 0
      ? null
      : `${data.otherVersion} finishing on an older version of this pipeline, which has no such step — they can only move to a step their own version has`,
  ].filter((line): line is string => line !== null);
  const moved = `${data.moved} item(s) moved, each with a note in its thread saying why.`;
  return left.length === 0 ? moved : [moved, "Left where they were:", ...left.map((line) => `- ${line}`)].join("\n");
}

export function renderSettingsWritten(data: IpcResponse<"settings:set">): string {
  // The whole object, not the keys that were sent: a partial write is
  // only safe to make if the caller can see what it left alone, and the
  // channel answers with everything precisely so it can.
  return `Settings written. Every preference, as it now stands:\n${renderSettings(data)}`;
}

export function renderGuardsWritten(data: IpcResponse<"guards:set">): string {
  // A refusal reads as a refusal (EO-162). The channel can decline a run
  // timeout that contradicts a module step's own limit, and answering
  // "written, here is the configuration" with the *unchanged*
  // configuration would be the quiet no-op this whole story is about.
  if (!data.saved) {
    return [
      "Guardrails not written — nothing has changed.",
      ...data.problems.map((problem) => `- ${problem}`),
      `Every limit, as it still stands:\n${renderGuards(data.guards)}`,
    ].join("\n");
  }
  return `Guardrails written. Every limit, as it now stands:\n${renderGuards(data.guards)}`;
}

export function renderAgentSaved(data: IpcResponse<"agents:save">): string {
  // A refusal never reaches here — `savedAgent` turns it into the tool's
  // own `refused` outcome, which is the shape a client acts on. The
  // narrowing is a backstop rather than a branch anybody takes.
  const agent = data.agent;
  if (agent === null) return data.problem ?? "Nothing was saved.";
  const model = agent.model === null ? "the provider's own default model" : agent.model;
  const staffed =
    agent.pipelineCount === 0
      ? `No pipeline has a step owned by \`${agent.role}\` yet, so nothing dispatches to this agent until one does.`
      : `${agent.pipelineCount} pipeline(s) have a step owned by \`${agent.role}\`.`;
  const lines = [
    `Saved ${agent.name} (id: ${agent.id}) — role \`${agent.role}\`, running on ${agent.provider} with ${model}${agent.enabled ? "" : ", disabled"}.`,
    staffed,
    // Both said out loud because both are things a caller would
    // otherwise learn by being surprised: the role by having a later
    // edit refused, the timing by watching a running agent go on using
    // the prompt it was given.
    "The role is fixed now — a pipeline step names the role rather than the agent, so a later agent_save cannot change it.",
    "New instructions take effect on the next dispatch; a run already in flight keeps the prompt it started with.",
  ];
  // What the instructions hold that only exists here (EO-450): advice on a save that has happened.
  return lines.join("\n") + renderMachineSpecific(instructionsMachineSpecificWarnings(agent.instructions, agent.defaultInstructions), "the agent's instructions");
}

/**
 * The four project writes answer alike — whether it worked, the project
 * as it now stands, and a problem when it did not.
 *
 * One renderer over all four rather than four near-copies: the verb is
 * the only thing that differs between them, so the verb is the argument.
 */
type ProjectWriteResponse =
  | IpcResponse<"projects:create">
  | IpcResponse<"projects:update">
  | IpcResponse<"projects:addProject">
  | IpcResponse<"projects:removeProject">;

export function renderProjectWritten(data: ProjectWriteResponse, done: string): string {
  if (!data.ok) return `Nothing changed: ${data.problem ?? "EO refused."}`;
  if (data.project === undefined) {
    // `projects:update` can answer ok with nothing to show, when the row
    // went away between the read and the write. Said rather than
    // rendered as an empty project.
    return `${done}. EO returned no project to read back — call projects_list to see where it stands.`;
  }

  const { project } = data;
  const repositories =
    project.repositoryIds.length === 0
      ? "It spans no repositories yet, so nothing on it can be worked."
      : `It spans ${project.repositoryIds.length} repository(s): ${project.repositoryIds.join(", ")}.`;
  return [`${done}. ${project.name} (id: ${project.id}, key prefix: ${project.keyPrefix}) — ${project.itemCount} ticket(s).`, repositories].join("\n");
}

export function renderRepositoryCreated(data: IpcResponse<"repositories:create">): string {
  if (!data.ok || data.repository === undefined || data.project === undefined) return `Nothing was attached: ${data.problem ?? "EO refused."}`;

  const adopted =
    (data.adoptedItems ?? 0) === 0
      ? ""
      : ` ${data.adoptedItems} ticket(s) written before any repository existed now belong to it.`;
  return [
    `Attached. ${repositoryLine(data.repository)}`,
    // Both said out loud: a caller that does not know a project was
    // created will go looking for one to make, and a caller that does not
    // know the window moved has moved someone's window without meaning to.
    data.project.created
      ? `There was no project to join, so EO made "${data.project.name}" for it, and that project is now the one the app window is showing.${adopted}`
      : `It joined the project "${data.project.name}". No project was made, and the app window has not moved.${adopted}`,
  ].join("\n");
}

/**
 * One workspace, in a line (EO-301).
 *
 * The kind first, because it is what decides what everything else on
 * the line means: a path under `Repository` and a path under `Folder`
 * are two different promises about what a run there will do. The
 * problem, when there is one, is last and said in full — it is the
 * sentence a person would be shown, and a caller that truncated it
 * would be handing on a warning nobody can act on.
 */
function workspaceLine(workspace: IpcResponse<"workspaces:list">["workspaces"][number]): string {
  const items = `${workspace.itemCount} ticket(s)`;
  const problem = workspace.problem === null ? "" : ` — unavailable: ${workspace.problem}`;
  return `${workspace.kind} · ${workspace.label} · ${workspace.summary} · ${items}${problem}`;
}

export function renderWorkspaces(data: IpcResponse<"workspaces:list">): string {
  if (data.workspaces.length === 0) {
    return "This project has no workspaces, so every step on it runs with no disk at all. workspace_create attaches one.";
  }
  return data.workspaces.map((workspace) => workspaceLine(workspace)).join("\n");
}

export function renderWorkspaceCreated(data: IpcResponse<"workspaces:create">): string {
  if (!data.ok || data.workspace === undefined) return `Nothing was attached: ${data.problem ?? "EO refused."}`;
  return `Attached. ${workspaceLine(data.workspace)}`;
}

export function renderWorkspaceUpdated(data: IpcResponse<"workspaces:update">): string {
  if (!data.ok || data.workspace === undefined) return `Nothing changed: ${data.problem ?? "EO refused."}`;
  return `Changed. ${workspaceLine(data.workspace)}`;
}

export function renderRepositoryUpdated(data: IpcResponse<"repositories:update">): string {
  if (!data.ok || data.repository === undefined) return `Nothing changed: ${data.problem ?? "EO refused."}`;
  return `Changed. ${repositoryLine(data.repository)}`;
}

/**
 * The Jira sites EO knows about (KAN-22).
 *
 * `credentialsConfigured` is rendered as a sentence rather than a flag
 * because it is the difference between a site that can be used and one
 * that cannot — and it is the only thing said about the credential.
 * There is no token in this response and there is none in this text:
 * the rule is that EO reports *that* a token is stored, never what it
 * is, and a renderer is exactly the place that rule would be broken by
 * accident.
 */
export function renderJiraConnections(data: IpcResponse<"jiraConnections:list">): string {
  return list(
    data.connections.map((connection) => {
      const named = connection.name.trim() === "" ? connection.baseUrl : connection.name;
      const email = connection.email === null ? "no account email" : connection.email;
      const token = connection.credentialsConfigured
        ? "a token is stored for it"
        : "**no token is stored for it** — jira_connection_save is what gives it one";
      const used =
        connection.projectCount === 0
          ? "no repository mirrors through it yet"
          : `${connection.projectCount} repository(s) mirror through it`;
      return `- ${named} (id: ${connection.id}) — ${connection.baseUrl}, ${connection.flavour}, ${email}\n  ${token}; ${used}`;
    }),
    "EO knows no Jira sites. jira_connection_save adds one — it stores a credential, so it is behind the destructive-operations switch.",
  );
}

/**
 * Every step of the path, in the order it was tried.
 *
 * The whole point of the channel: credentials, project key and fields
 * fail for three different reasons, and one "it did not work" sends
 * someone to check the wrong one.
 */
export function renderJiraCheck(data: IpcResponse<"jira:test">): string {
  const head = data.ok
    ? "Jira answered every check. This repository can mirror."
    : "This repository cannot mirror yet. The failed step below is the one to fix — the checks stop at the first failure.";
  return [head, "", list(data.steps.map((step) => `- ${step.ok ? "ok" : "**failed**"} — ${step.name}: ${step.detail}`), "Nothing was checked at all.")].join("\n");
}

export function renderJiraFields(data: IpcResponse<"jira:fields">): string {
  if (data.problem !== null) return `Jira did not answer: ${data.problem}`;

  return list(
    data.fields.map((field) => {
      // The id is what `jira_save_config` is keyed by, and the allowed
      // values are what a caller has to choose between rather than
      // invent — a free-text guess at an option field is rejected by
      // Jira at create time, which is hours away from here.
      const allowed =
        field.allowedValues.length === 0
          ? ""
          : `\n  allowed: ${field.allowedValues.map((value) => `${value.value} (id: ${value.id})`).join(", ")}`;
      return `- ${field.name} (id: ${field.id}, ${field.schemaType})${field.required ? " — **required**" : ""}${allowed}`;
    }),
    "Jira listed no fields for that issue type here. Check the issue type exists in this project and that the account may create issues in it.",
  );
}

export function renderJiraStatuses(data: IpcResponse<"jira:statuses">): string {
  if (data.problem !== null) return `Jira did not answer: ${data.problem}`;

  return list(
    data.statuses.map((status) => `- ${status}`),
    "This project's workflow reported no statuses, so there is nothing to map an EO step onto.",
  );
}

export function renderJiraOutbox(data: IpcResponse<"jira:outbox">): string {
  if (data.pending === 0) return "Nothing is waiting to reach Jira for this repository.";

  const failing =
    data.failing === 0
      ? "none of them has failed yet"
      : `${data.failing} of them ${data.failing === 1 ? "has" : "have"} failed at least once and ${data.failing === 1 ? "is" : "are"} being retried`;
  return `${data.pending} push(es) waiting for Jira, and ${failing}. jira_test says whether the path itself is the problem.`;
}

export function renderForgeDetection(data: IpcResponse<"forge:detect">): string {
  const kind = data.kind ?? "EO cannot tell — name it with repository_update (forgeKind) rather than letting EO guess";
  const cli = data.cliInstalled ? (data.authenticated ? "installed and signed in" : "**installed but not signed in**") : "**not installed**";
  const lines = [
    `- remote: ${data.remoteUrl ?? "none — EO found no remote to push to"}`,
    `- host: ${data.host ?? "unknown"}`,
    `- kind: ${kind}`,
    `- CLI: ${cli}`,
    `- pull request template: ${data.templatePath ?? "none in this repository"}`,
  ];
  // Said last and in full: it is the sentence that names the command a
  // person would run, and losing it would leave a caller with two
  // booleans and nothing to do about them.
  if (data.problem !== null) lines.push("", data.problem);
  return lines.join("\n");
}

/**
 * A comment's options as an agent reads them: the answers a reply can
 * pick from, and apart from them the buttons only the person can press
 * (EO-533) — named so an agent knows what the person was offered, and
 * never listed as answers, since replying with one does nothing.
 */
function offeredLines(options: readonly CommentOption[] | null, indent: string): string[] {
  const answers = answerOptions(options);
  const actions = actionOptions(options);
  const lines: string[] = [];
  if (answers.length > 0) lines.push(indent.trimEnd(), `${indent}Offered answers: ${answers.join(" · ")}`);
  if (actions.length > 0) lines.push(indent.trimEnd(), `${indent}Buttons for the person: ${actions.map((action) => action.label).join(" · ")}`);
  return lines;
}

/**
 * A held template update, as `pipeline_update_conflict` tells it (EO-534):
 * what is held and why, then every changed key with its three values,
 * conflicts first, then the person's edits since the base, then the three
 * graphs. The graphs come last and compact — the fields a comparison or a
 * draft reads — because they are long, and the lines above are what a
 * resolution is decided from.
 */
export function renderUpdateConflict(data: IpcResponse<"pipeline:updateConflict">): string {
  const conflict = data.conflict;
  if (conflict === null) return data.problem ?? "There is no held template update for that pipeline.";
  const value = (side: unknown): string => (side === null || side === undefined ? "absent" : JSON.stringify(side));
  const conflicts = conflict.changes.filter((change) => change.changedBy === "conflict").length;
  const changes = conflict.changes.flatMap((change) => [
    `- [${change.changedBy === "conflict" ? "conflict" : change.changedBy === "same" ? "both, the same" : `${change.changedBy} only`}] ${change.description}`,
    `  base: ${value(change.base)} · person: ${value(change.current)} · template: ${value(change.template)}`,
  ]);
  const edits = conflict.edits.map(
    (edit) =>
      `- v${edit.version}${edit.createdByName === null ? "" : ` by ${edit.createdByName}`}, ${new Date(edit.createdAt).toISOString()}` +
      (edit.previousVersion === null
        ? " — the first version, nothing before it to compare"
        : edit.changes.length === 0
          ? ` — nothing in the graph changed from v${edit.previousVersion}`
          : `, from v${edit.previousVersion}: ${edit.changes.join("; ")}`),
  );
  const graph = (shown: (typeof conflict)["base"]): string =>
    JSON.stringify({
      entryStepId: shown.entryStepId,
      steps: shown.steps.map((step) => ({
        id: step.id,
        name: step.name,
        type: step.type,
        entryAction: step.entryAction,
        ownerRole: step.ownerRole,
        isTerminal: step.isTerminal,
        inputs: step.inputs,
        watch: step.watch,
        timeoutMs: step.timeoutMs,
        results: step.results,
      })),
      routes: shown.routes.map((route) => ({ fromStepId: route.fromStepId, resultKey: route.resultKey, target: route.target, label: route.label, tone: route.tone })),
    });
  return [
    `"${conflict.pipelineName}" (id: ${conflict.pipelineId}) holds the ${conflict.templateTitle} template's update (${conflict.templateSlug}) from ${conflict.fromVersion}, its base, to ${conflict.toVersion}. ` +
      "Nothing from it is applied until the person publishes a draft or keeps their pipeline.",
    "",
    "Release notes:",
    ...(conflict.releaseNotes === "" ? ["- (none)"] : conflict.releaseNotes.split("\n").map((line) => `- ${line}`)),
    "",
    `Every key somebody changed since the base, conflicts first (${conflicts} conflict${conflicts === 1 ? "" : "s"}):`,
    ...(changes.length === 0 ? ["- (none: the pipeline is the template's version already)"] : changes),
    ...(conflict.problems.length === 0 ? [] : ["", "The automatic merge would not be valid:", ...conflict.problems.map((problem) => `- ${problem}`)]),
    ...(conflict.takenStepIds.length === 0
      ? []
      : [
          "",
          `Step ids the template adds that another pipeline already holds: ${conflict.takenStepIds.join(", ")}. ` +
            'A draft gives each a fresh id and says which it is in `templateStepIds` — `{ "<template step id>": "<fresh id>" }` — so the next template version still knows the step.',
        ]),
    "",
    "The person's edits since the base, oldest first:",
    ...(edits.length === 0 ? ["- (none filed)"] : edits),
    "",
    "The three graphs, in this pipeline's own step ids — a draft uses these ids:",
    `Base (${conflict.templateSlug} ${conflict.fromVersion}): ${graph(conflict.base)}`,
    `The person's pipeline now: ${graph(conflict.current)}`,
    `Template ${conflict.toVersion}: ${graph(conflict.template)}`,
  ].join("\n");
}
