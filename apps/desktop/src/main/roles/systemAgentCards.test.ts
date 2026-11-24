import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is taught about the four things only a person
 * may do with a pipeline (EO-521): export it, import a file, delete it,
 * and discard this machine's edits to one the organisation manages.
 *
 * Held here because the prompt is the only place the agent learns the
 * cards exist and when to offer each. Before this it was told the button
 * for discarding was on the configuration screen — which is going — and
 * it holds `pipeline_delete` and `pipeline_import` among its tools, so a
 * prompt that did not say otherwise would have it write round the card.
 */

const prompt = loadRolePrompt("system")!;
const flat = prompt.replace(/\s+/g, " ");

/** A section, from its heading to the next heading of any depth, with its whitespace flattened. */
function section(heading: string): string {
  const start = prompt.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const next = /\n#{1,3} /.exec(prompt.slice(start + 1));
  return (next ? prompt.slice(start, start + 1 + next.index) : prompt.slice(start)).replace(/\s+/g, " ");
}

describe("what the system agent's prompt says about cards for what only a person may do", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names the route among the ways it changes anything", () => {
    expect(section("## How you change anything")).toContain("**What only a person may do is a card with its button on it.**");
    expect(section("## How you change anything")).toContain("see **Cards for what only a person may do**");
  });

  it("gives each card's shape and says when to offer it", () => {
    expect(cards()).toContain('`{ "kind": "pipelineExport", "pipelineId": "…" }`');
    expect(cards()).toContain("Offer it when somebody wants a pipeline as a file");
    expect(cards()).toContain('`{ "kind": "pipelineImport", "attachmentId": "…" }`');
    expect(cards()).toContain("Only a file attached to this chat");
    expect(cards()).toContain('`{ "kind": "pipelineDelete", "pipelineId": "…" }`');
    expect(cards()).toContain("Offer it when somebody asks for a pipeline to be deleted");
    expect(cards()).toContain('`{ "kind": "pipelineDiscardEdits", "pipelineId": "…" }`');
    expect(cards()).toContain("Only for a pipeline the organisation manages whose copy here is **edited locally**");
  });

  it("says what each card shows before it is pressed", () => {
    expect(cards()).toContain("asks about every module the file shares a slug with");
    expect(cards()).toContain("says how many items the pipeline holds and that it goes to the Archive");
    expect(cards()).toContain("The card says those updates resume once it is pressed.");
  });

  it("says nothing happens until the person presses it, once, and that the agent does none of it itself", () => {
    expect(cards()).toContain("Nothing is exported, imported, archived or discarded until they do");
    expect(cards()).toContain("each card is pressed once");
    expect(cards()).toContain("**never import it with `pipeline_import`**");
    expect(cards()).toContain("**Never delete it with `pipeline_delete`**");
    expect(cards()).toContain("never say it is done");
  });

  it("no longer sends the person to a configuration screen to discard their edits", () => {
    expect(flat).not.toContain("the button for it is on their configuration screen");
    expect(section("### A section the organisation manages")).toContain("offer the card whose button does it");
    expect(section("### A section the organisation manages")).toContain("no tool of yours can");
  });

  it("says a card comes on its own", () => {
    expect(cards()).toContain("`cards` come on their own — no `draft`, `modules`, `change` or `proposals` beside them");
  });

  it("is a new version of the prompt", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(25);
  });
});

describe("what the system agent's prompt says about the settings that are a person's (EO-522)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names them among what only a person may do", () => {
    expect(section("## How you change anything")).toContain("letting a pipeline's webhook items reach a sending step unread");
    expect(section("## How you change anything")).toContain("setting or clearing a step's own secret or environment variable");
  });

  it("gives the webhook card's shape, says it is a risk only a person may accept, and that pipeline_save refuses it", () => {
    expect(cards()).toContain('`{ "kind": "pipelineWebhookUnattended", "pipelineId": "…", "unattended": true }`');
    expect(cards()).toContain("It is a risk only a person may accept");
    expect(cards()).toContain("`pipeline_save` refuses a graph carrying `webhookUnattended`; the card is the only way.");
  });

  it("gives the step cards' shape, and says the person types the value on the card and the agent never sees it", () => {
    expect(cards()).toContain('`{ "kind": "stepSecret", "stepId": "…", "name": "…", "action": "set" }`');
    expect(cards()).toContain('`"stepVariable"`');
    expect(cards()).toContain("**The person types the value on the card**");
    expect(cards()).toContain("you never see it, so never ask for it in the chat");
    expect(cards()).toContain("The card says whether the step already has a value of its own, never what it is");
    expect(cards()).toContain("`environment_variables_list` names a step's own variables without their values");
    expect(cards()).toContain("a step's own value is the card's to set");
  });

  it("is a newer version than the one that taught the first four cards", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(26);
  });
});

describe("what the system agent's prompt says about item types (EO-523)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names them among what only a person may do", () => {
    expect(section("## How you change anything")).toContain("adding, changing or removing an item type are each returned as a card in `cards`");
  });

  it("describes the read tool: each type's fields, and whether a pack ships it", () => {
    expect(cards()).toContain("Read a project's types with `item_types_list` first");
    expect(cards()).toContain("its fields, and **whether a pack ships it**");
  });

  it("gives the three cards' shapes, with null for what a change leaves as it is", () => {
    expect(cards()).toContain('`{ "kind": "itemTypeCreate", "projectId": "…", "label": "Case", "plural": "Cases", "container": false, "fields": [');
    expect(cards()).toContain('`{ "kind": "itemTypeUpdate", "itemTypeId": "…", "label": "…", "plural": null, "container": null, "fields": null }`');
    expect(cards()).toContain('`{ "kind": "itemTypeDelete", "itemTypeId": "…" }`');
    expect(cards()).toContain("`null` to leave it as it is");
  });

  it("says a pack's type can be renamed and take optional fields of the project's own, and that a refusal is shown on the card", () => {
    expect(cards()).toContain("**A pack's type can be renamed, and can take optional fields of the project's own**");
    expect(cards()).toContain("each with `\"required\": false`");
    expect(cards()).toContain("the card shows that refusal in place of its button");
    expect(cards()).toContain("No tool adds, changes or removes a type; the card is the only way.");
  });

  it("is a newer version than the one that taught the settings' cards", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(27);
  });
});

describe("what the system agent's prompt says about a held template update (EO-534)", () => {
  const held = () => section("### A held template update");
  const cards = () => section("### Cards for what only a person may do");

  it("explains what an update conflict is and that nothing of a held update is applied", () => {
    expect(held()).toContain("remembers the version it came from — its *base*");
    expect(held()).toContain("**nothing** from that version is applied, not even the parts that do not conflict");
    expect(held()).toContain("**Fix with assistant**");
  });

  it("says to read the conflict with pipeline_update_conflict first, named by its server and not by any backend's spelling", () => {
    expect(held()).toContain("**Read the conflict first.** Call `pipeline_update_conflict`, on the MCP server EO registers as `eo_admin`");
    expect(held()).toContain("the person's own edits since the base");
    expect(held()).not.toMatch(/mcp__|eo_admin\//);
  });

  it("asks it to keep both intents, using the release notes for the template's", () => {
    expect(held()).toContain("**Keep both intents.**");
    expect(held()).toContain("the release notes say what the template's change is for");
  });

  it("allows at most three options, recommended first, each saying in one line what it keeps, with take-the-template and keep-mine among them", () => {
    expect(held()).toContain("**Offer at most three options, the one you recommend first.**");
    expect(held()).toContain("`alternatives` holds up to two more drafts of the same pipeline");
    expect(held()).toContain("**one line** saying what it keeps from the person's version and what from the template's");
    expect(held()).toContain("a plain **take the template** option");
    expect(held()).toContain('a plain **keep mine** option: the card `{ "kind": "pipelineKeepMine", "pipelineId": "…" }`');
    expect(held()).toContain("That is three at most, the Keep card included");
  });

  it("requires every draft to validate, and never applies anything", () => {
    expect(held()).toContain("**Every draft must validate.** Check each one with `pipeline_validate`");
    expect(held()).toContain("**Never apply anything.** Not with `pipeline_save`");
  });

  it("gives EO's own Delivery as the worked example of the recommendation", () => {
    expect(held()).toContain("`opened` → Watching pull request, and its `ready` → `merge_pr`, with `reportReady` on");
    // Ready is reachable where nobody approves on the forge, which is EO's case.
    expect(held()).toContain('`{ "reportReady": true, "readyWhen": "mergeable" }`');
  });

  it("says a fresh id for a template's step is named in templateStepIds, so the next version still knows it", () => {
    expect(held()).toContain("say which template step it is in the draft's `templateStepIds`");
  });

  it("lists the Keep my pipeline card among the cards, the one that may come beside a draft", () => {
    expect(cards()).toContain('**Keep my pipeline** — `{ "kind": "pipelineKeepMine", "pipelineId": "…" }`');
    expect(cards()).toContain("The one exception is a lone Keep my pipeline card, which comes beside the drafts resolving a held template update.");
    expect(section("## How you change anything")).toContain("so is keeping a pipeline as it is and skipping a held template update");
  });

  it("is a newer version than the one before held template updates", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(30);
  });
});

describe("what the system agent's prompt says about the publish card after trials (EO-588)", () => {
  it("lists the card, and says when it is offered and that it comes alone", () => {
    expect(section("### Cards for what only a person may do")).toContain('**Publish a tested draft** — `{ "kind": "trialPublish" }`');
    const done = section("### Testing a draft with real runs");
    expect(done).toContain('return the publish card, `{ "kind": "trialPublish" }`, on its own, with no draft');
    expect(done).toContain("Never call a mocked step tested.");
    expect(done).toContain("say plainly which test items did not end where they were expected to");
  });

  it("is a newer version than the one before the publish card", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(36);
  });
});

describe("what the entry step needs (EO-610)", () => {
  const needs = (): string => section("### What the entry step needs");

  it("is under Pipeline drafts, ahead of how a graph is routed", () => {
    expect(prompt.indexOf("## Pipeline drafts")).toBeLessThan(prompt.indexOf("### What the entry step needs"));
    expect(prompt.indexOf("### What the entry step needs")).toBeLessThan(prompt.indexOf("### Results and routes"));
  });

  it("has the assistant work out what the entry step needs whenever it designs or changes a pipeline, and say why", () => {
    expect(needs()).toContain("When you design or change a pipeline, work out what its entry step needs in order to start without stopping to ask");
    expect(needs()).toContain("propose entry rules for exactly that, in `entryRules` on the draft");
    expect(needs()).toContain("Say why in a sentence");
  });

  it("holds it back from guessing, repeating a type's requirements and asking for what nothing needs", () => {
    expect(needs()).toContain("ask the person rather than guessing");
    expect(needs()).toContain("Do not restate what an item type already requires");
    expect(needs()).toContain("Propose none where nothing is needed");
  });

  it("leaves it to the person, as with any draft", () => {
    expect(needs()).toContain("Nothing takes effect until the person publishes, as with any draft");
  });
});

describe("what the system agent's prompt says about jobs (EO-786)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names them among what only a person may do", () => {
    expect(section("## How you change anything")).toContain("So are creating, changing and deleting a job, and a webhook job's new secret and test event.");
  });

  it("says to read the jobs first, and that no tool writes one", () => {
    expect(cards()).toContain("**Read the jobs with `jobs_list` or `job_get` first**");
    expect(cards()).toContain("You have no tool that writes a job; the card is the only way.");
  });

  it("gives the four cards' shapes, with null for what a change leaves and \"none\" to clear a limit", () => {
    expect(cards()).toContain('`{ "kind": "jobCreate", "projectId": "…", "name": "Monday report", "trigger": { "kind": "schedule"');
    expect(cards()).toContain('`{ "kind": "jobUpdate", "jobId": "…", "name": null, "trigger": null');
    expect(cards()).toContain("`\"none\"` removes a budget, a cap or the repository (`workspaceId`)");
    expect(cards()).toContain('`{ "kind": "jobDelete", "jobId": "…" }`');
    expect(cards()).toContain('`{ "kind": "jobWebhook", "jobId": "…", "action": "regenerateSecret" }`');
    expect(cards()).toContain("the old one stops working the moment the button is pressed");
    expect(cards()).toContain("**A webhook job's signing secret is in no card, answer or chat message**");
  });

  it("no longer says it has no tool for jobs, or sends the person to the Jobs screen", () => {
    expect(flat).not.toContain("you have no tool that creates jobs");
    expect(flat).not.toContain("A watch intake is set up on the Jobs screen");
    expect(flat).not.toContain("add a watch job there");
    expect(section("### Modules, and when to reach for one instead of an agent")).toContain("offer a `jobCreate` card with a `watch` trigger");
  });

  it("is a newer version than the one before job cards", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(56);
  });
});

describe("what the system agent's prompt says about command-line tools (EO-822)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("names them among what only a person may do", () => {
    expect(section("## How you change anything")).toContain(
      "So are adding a command-line tool to the catalogue and giving one to an agent or taking it away.",
    );
  });

  it("says to read the catalogue first, and that no tool of its own writes or attaches a CLI", () => {
    expect(cards()).toContain("**Read the catalogue with `cli_tools_list` first**");
    expect(cards()).toContain("you have no tool that adds, changes, archives or attaches a CLI — `agent_attachments_set` refuses one from you — and the card is the only way.");
  });

  // The add card's own shape left the prompt with EO-860: adding is a `cliToolsAssign` with no agents.
  it("says a CLI grants nothing", () => {
    expect(cards()).toContain("A CLI grants nothing: an agent runs it through the shell it already has");
  });

  it("is a newer version than the one before CLI cards", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(58);
  });
});

describe("what the system agent's prompt says about giving CLIs to several agents (EO-859)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("offers cliToolsAssign for every give or take, a single one included", () => {
    expect(cards()).toContain(
      '`{ "kind": "cliToolsAssign", "add": [{ "name": "Jira CLI", "command": "jira", "description": "Issues on our Jira." }], "agents": [{ "agentId": "…", "give": ["…", "jira"], "take": [] }] }`',
    );
    expect(cards()).toContain("Name a catalogued CLI by the id `cli_tools_list` gives, and one this card adds by its `command`;");
    expect(cards()).toContain("Use this card whenever you give or take a CLI, even a single one.");
  });

  it("no longer offers cliToolAttach", () => {
    expect(prompt).not.toContain("cliToolAttach");
  });

  it("is a newer version than the one before it", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(60);
  });
});

describe("what the system agent's prompt says about adding several CLIs in one card (EO-860)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("offers cliToolsAssign for every CLI change, adding without giving included, with an add-only example", () => {
    expect(cards()).toContain("One card kind does every CLI change, `cliToolsAssign`:");
    expect(cards()).toContain("to add CLIs to the catalogue without giving them to anyone — one program or several, each its own entry in `add` — leave `agents` empty:");
    expect(cards()).toContain(
      '`{ "kind": "cliToolsAssign", "add": [{ "name": "GitHub CLI", "command": "gh", "description": "Pull requests, issues and checks on GitHub." }, { "name": "Jira CLI", "command": "jira", "description": "Issues on our Jira." }], "agents": [] }`',
    );
    expect(cards()).toContain("Only for a command the catalogue does not already run, archived entries included;");
    expect(cards()).toContain('The card\'s button says what it will do — "Add 2", or "Add 1, give 3" —');
  });

  it("no longer offers cliToolAdd", () => {
    expect(prompt).not.toContain("cliToolAdd");
  });

  it("is a newer version than the one before it", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(61);
  });
});

describe("what the system agent's prompt says about a job's repository (EO-856)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("puts workspaceId on both job cards' shapes", () => {
    expect(cards()).toContain('"maxItemsPerHour": null, "runsOn": null, "workspaceId": null }`');
    expect(cards()).toContain('"maxItemsPerHour": 4, "runsOn": null, "workspaceId": null }`');
  });

  it("says what it is, where its id comes from, what null means and when a project needs one named", () => {
    expect(cards()).toContain("`workspaceId` is the repository every item the job files is filed on, by the id `repositories_list` gives, and must be one of the project's");
    expect(cards()).toContain("`null` names none, which files on the project's only repository when it has exactly one");
    expect(cards()).toContain("On a project with several, a job whose pipeline's first step works on a branch of the item's own repository is refused without one");
    expect(cards()).toContain("`\"none\"` removes a budget, a cap or the repository (`workspaceId`)");
  });

  it("is a newer version than the one before a job named its repository", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(62);
  });
});

describe("what the system agent's prompt says about several cards in one reply (EO-862)", () => {
  const cards = () => section("### Cards for what only a person may do");

  it("says several things asked for at once are several cards in one reply, each its own decision", () => {
    expect(cards()).toContain("**Several cards in one reply.** When the person asked for several things at once");
    expect(cards()).toContain("return a card for each in `cards`, in the order they asked, rather than one a turn.");
    expect(cards()).toContain("Each card is one independent decision: the person presses each on its own");
  });

  it("caps them at twenty, keeps them on their own, and says a refused one is told by its place and kind", () => {
    expect(cards()).toContain("At most 20 in one reply; with more, offer the first 20 and the rest once those are pressed.");
    expect(cards()).toContain("Several cards still come on their own, as above.");
    expect(cards()).toContain("its place in `cards`, its kind and why — and offers the others.");
    expect(flat).not.toContain("one card a reply");
  });

  it("is a newer version than the one with one card a reply", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(63);
  });
});

describe("what the system agent's prompt says about teams on a step (EO-848)", () => {
  const teams = () => section("### A declared team on an agent step");

  it("offers `team` on a draft's agent step, by name, and `\"none\"` for one agent again", () => {
    expect(flat).toContain("- **An `agent` step may set `team`** — the name of the declared team it runs as,");
    expect(teams()).toContain("A team is created, changed and named only through a draft published from its card — all but what its members run on, below; `pipeline_save` takes the keys off.");
  });

  it("says every member is report-only by default, and what it cannot do", () => {
    expect(teams()).toContain("posts an attributed report on the thread, and cannot edit the work, run commands, change anything outside EO or widen what it may use.");
  });

  it("gives both coordination modes, their completion and limits", () => {
    expect(teams()).toContain('"coordination": "independent"');
    expect(teams()).toContain('"coordination": "leader"');
    expect(teams()).toContain("A required participant that could not contribute fails the team");
    expect(teams()).toContain("Left out they are 4, 2, 1 and 2.");
  });

  it("sends an independent team to the action catalogue, and to a custom action of its own rather than a pack's", () => {
    expect(teams()).toContain("read the actions with `registry_get`");
    expect(teams()).toContain("carry a definition of your own in `actions` beside the draft");
    expect(teams()).toContain("never point the team at a pack's action");
  });

  it("says what is refused before a card, that live work keeps its version, and how a mocked team is reported on a trial", () => {
    expect(teams()).toContain("**What is refused**, and named, before a card is offered");
    expect(teams()).toContain("**Publishing a team files a new version.**");
    expect(teams()).toContain("do not report the team as tested from a mocked result.");
  });
});

describe("what the system agent's prompt says about a team's member mode (EO-867)", () => {
  const teams = () => section("### A declared team on an agent step");

  it("says what each mode is for: report-only for content EO should not let an agent act on, isolated where members should work as their agents do", () => {
    expect(teams()).toContain("**Members: report-only or isolated.**");
    expect(teams()).toContain('`"report_only"`, the default, is for content EO should not let an agent act on');
    expect(teams()).toContain('`"isolated"` is for a team whose members should work as their agents do');
    expect(teams()).toContain("in a copy of the item's workspace made for it alone and removed when its turn ends.");
  });

  it("says an isolated team escapes the report-only refusals and is refused where its workspace cannot be copied", () => {
    expect(teams()).toContain("none of the report-only refusals below applies to it");
    expect(teams()).toContain("a step that works in a workspace EO cannot copy for each member — a folder, a scratch directory — is refused instead, and the refusal names the kind.");
  });
});

describe("what the system agent's prompt says about declared teams (EO-881)", () => {
  const teams = () => section("### A declared team on an agent step");

  it("says a team is its own entity, beside agents, which a step names and several pipelines may share", () => {
    expect(teams()).toContain("A team is a configured thing of its own, beside agents: it has a name, a leader agent (leader-led only) and member agents, and a step names it the way it names an agent.");
    expect(teams()).toContain("Several pipelines can name one team.");
  });

  it("says how a draft creates, changes and names a team, by name, with its agents by name", () => {
    expect(teams()).toContain("A draft creates or changes a team in its `teams` list, each entry whole, and points a step at one by name in the step's `team`.");
    expect(teams()).toContain("An entry whose `name` the project's team has changes that team — a new version — and any other creates one.");
    expect(teams()).toContain('"agent": "Security reviewer"');
    expect(teams()).toContain("whole entry as a draft's `teams` takes it");
  });

  it("names the tool pool, model range and member cap, and that eo_admin and the system agent are never on a team", () => {
    expect(teams()).toContain("a `toolPool` — the CLI tools (by command), MCP servers (by name) and skills (by slug) its members may be given");
    expect(teams()).toContain("a `modelRange` — the `runtimes`, `models` and `reasoning` levels a member its leader adds may run on");
    expect(teams()).toContain("`eo_admin` can never be in a pool, and EO's system agent can never be a leader or a member.");
  });

  it("says a locked team refuses every change, and that every change is a version a person can restore", () => {
    expect(teams()).toContain("**A locked team refuses every change but a person unlocking it**");
    expect(teams()).toContain("Every change to a team is a version, recorded with who made it, and a person can restore any earlier one.");
  });

  it("is a newer version than the one before declared teams", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(66);
  });
});

describe("what the system agent's prompt says about a team's new members (EO-898)", () => {
  const teams = () => section("### A declared team on an agent step");
  const held = () => section("### A held template update");

  it("says a team's agents are its own, declared new in `newMembers`, created only by Publish, and never an ordinary agent", () => {
    expect(teams()).toContain("**declares every agent it does not have yet in `newMembers`**");
    expect(teams()).toContain("Nothing is created until the person presses Publish, which creates each as an agent of the team's own, with the team; so never create agents for a team with `agent_save` first.");
    expect(teams()).toContain("A draft naming an ordinary agent as a leader or member is refused: declare a new member instead, with `from` naming that agent.");
    expect(teams()).toContain('"newMembers": [');
  });

  it("says a held update lists the template's team ready for a draft, taken on one card with no agents made first", () => {
    expect(held()).toContain("To take the template's team, put that entry in the draft's `teams` as it is and set the step's `team` to its `name` — one card, like any other change.");
    expect(held()).toContain("Never create agents for it yourself: Publish creates them, as the team's own.");
  });

  it("is a newer version than the one before a team's new members", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(67);
  });
});

describe("what the system agent's prompt says about its team members' runtime, model and reasoning (EO-900)", () => {
  const teams = () => section("### A declared team on an agent step");

  it("says it can read what each member runs on and set it with team_member_settings_set, nothing else of a member or the team", () => {
    expect(teams()).toContain("all but what its members run on, below;");
    expect(teams()).toContain("`teams_list` gives each team's id, its model range, and the runtime, model and reasoning each member — the leader included — runs on now; say what a team runs before you change it.");
    expect(teams()).toContain("`team_member_settings_set` sets one or more members, named by their names within the team, to one runtime, model and reasoning, as a person does in the Teams tab.");
    expect(teams()).toContain("files one version of the team, recorded as yours, which a person can restore.");
  });

  it("names what refuses it, what it saves and says, and is newer than the prompt before it", () => {
    expect(teams()).toContain("It is refused for a locked team, saying so, and for a backend the organisation does not allow.");
    expect(teams()).toContain("It does not ask the team's model range, which bounds only the members a leader adds.");
    expect(teams()).toContain("A runtime this machine has not installed or is not signed in to is still saved, and the answer says so, as the Teams tab does: pass that on to the person.");
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(68);
  });
});
